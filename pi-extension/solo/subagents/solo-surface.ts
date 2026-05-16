/**
 * Thin Solo backend for subagents.
 *
 * v2 subagents are real Solo agent processes (`spawn_process(kind="agent")`).
 * The parent drives them with one plain-text `send_input` call and relies on
 * Solo's idle timer primitive to wake the parent when the child goes idle.
 */

/** Minimal slice of SoloMcpClient that this module uses. */
export interface SoloMcpLike {
	callTool(
		name: string,
		args: unknown,
	): Promise<{
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
		structuredContent?: unknown;
	}>;
}

function extractJson<T = any>(result: {
	structuredContent?: unknown;
	content?: Array<{ type: string; text?: string }>;
}): T | undefined {
	if (result.structuredContent != null) return result.structuredContent as T;
	const first = result.content?.find((c) => c.type === "text" && typeof c.text === "string");
	if (!first?.text) return undefined;
	try {
		return JSON.parse(first.text) as T;
	} catch {
		return undefined;
	}
}

function errorText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.find((c) => c.type === "text" && c.text)?.text ?? "(unknown)";
}

function trimSurfaceName(name: string): string {
	// Solo display names look best at ≤ 32 chars in the sidebar.
	const clean = name.trim();
	return clean.length > 32 ? clean.slice(0, 31) + "…" : clean || "subagent";
}

export interface AgentSurface {
	processId: number;
	name: string;
	agentInstructions: string;
}

/** Spawn a real Solo agent process and return its process id + bootstrap text. */
export async function createAgentSurface(
	client: SoloMcpLike,
	name: string,
	agentToolId: number,
	options: { extraArgs?: string[] } = {},
): Promise<AgentSurface> {
	const result = await client.callTool("spawn_agent", {
		agent_tool_id: agentToolId,
		name: trimSurfaceName(name),
		include_agent_instructions: true,
		...(options.extraArgs && options.extraArgs.length > 0 ? { extra_args: options.extraArgs } : {}),
	});
	if (result.isError) throw new Error(`spawn_agent failed: ${errorText(result)}`);

	const data = extractJson<{ process_id?: number; name?: string; agent_instructions?: string }>(
		result,
	);
	const processId = typeof data?.process_id === "number" ? data.process_id : undefined;
	if (processId == null) {
		throw new Error(`spawn_agent did not return a process_id: ${JSON.stringify(data)}`);
	}
	return {
		processId,
		name: data?.name ?? name,
		agentInstructions: typeof data?.agent_instructions === "string" ? data.agent_instructions : "",
	};
}

/** Rename the Solo process row (cosmetic but improves sidebar UX). */
export async function renameSurface(
	client: SoloMcpLike,
	processId: number,
	newName: string,
): Promise<void> {
	try {
		await client.callTool("rename_process", {
			process_id: processId,
			new_name: trimSurfaceName(newName),
		});
	} catch {
		// Cosmetic — never fail the launch over a rename.
	}
}

/** Send one user turn to the Solo process. */
export async function sendCommand(
	client: SoloMcpLike,
	processId: number,
	input: string,
): Promise<void> {
	const result = await client.callTool("send_input", {
		process_id: processId,
		input,
		submit: true,
	});
	if (result.isError) throw new Error(`send_input failed: ${errorText(result)}`);
}

/** Send raw bytes (control keys). [27]=Escape, [3]=Ctrl-C, [4]=Ctrl-D. */
export async function sendBytes(
	client: SoloMcpLike,
	processId: number,
	bytes: number[],
): Promise<void> {
	const result = await client.callTool("send_input", {
		process_id: processId,
		bytes,
	});
	if (result.isError) throw new Error(`send_input(bytes) failed: ${errorText(result)}`);
}

/** Send one Escape keypress (interrupts a running Pi turn without killing the session). */
export async function sendEscape(client: SoloMcpLike, processId: number): Promise<void> {
	await sendBytes(client, processId, [27]);
}

/** Remove the surface from Solo's sidebar. Best-effort. */
export async function closeSurface(client: SoloMcpLike, processId: number): Promise<void> {
	try {
		await client.callTool("close_process", { process_id: processId });
	} catch {
		// Already closed by the user, or Solo restarted — not fatal.
	}
}

/**
 * Query Solo's native agent runtime state.
 *
 * For kind="agent" processes, Solo exposes agent_state.idle/thinking/planning.
 * This is the source of truth for v2; terminals do not populate it.
 */
export async function getRuntimeState(client: SoloMcpLike, processId: number): Promise<string> {
	try {
		const result = await client.callTool("get_process_status", { process_id: processId });
		const data = extractJson<any>(result);
		const state = data?.agent_state;
		if (state?.thinking || state?.planning) return "active";
		if (state?.idle === true) return "idle";
		if (data?.status && String(data.status).toLowerCase() !== "running") {
			return String(data.status).toLowerCase();
		}
		return "active";
	} catch {
		return "unknown";
	}
}

let cachedPiAgentToolId: number | undefined;

export function resetResolvedPiAgentToolIdForTests(): void {
	cachedPiAgentToolId = undefined;
}

/** Resolve the Solo Agent Tool configured to run bare `pi`. */
export async function resolvePiAgentToolId(client: SoloMcpLike): Promise<number> {
	if (cachedPiAgentToolId != null) return cachedPiAgentToolId;

	const result = await client.callTool("list_agent_tools", {});
	if (result.isError) throw new Error(`list_agent_tools failed: ${errorText(result)}`);

	const data = extractJson<any>(result);
	const tools = Array.isArray(data) ? data : Array.isArray(data?.tools) ? data.tools : [];
	const enabled = tools.filter((tool: any) => tool?.enabled !== false);
	const exactCommand = enabled.find((tool: any) => String(tool?.command ?? "").trim() === "pi");
	const exactName = enabled.find((tool: any) => String(tool?.name ?? "").toLowerCase() === "pi");
	const selected = exactCommand ?? exactName;
	const id = typeof selected?.id === "number" ? selected.id : undefined;
	if (id == null) {
		throw new Error(
			"No Solo agent tool configured for Pi. In Solo settings, open Agents and add a Generic agent tool with command `pi`.",
		);
	}

	cachedPiAgentToolId = id;
	return id;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until Solo reports the newly spawned Pi agent is ready at an idle prompt. */
export async function waitForAgentReady(
	client: SoloMcpLike,
	processId: number,
	options: { timeoutMs?: number; intervalMs?: number; initialDelayMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const intervalMs = options.intervalMs ?? 250;
	const startedAt = Date.now();
	await delay(options.initialDelayMs ?? 500);

	let lastState = "unknown";
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const result = await client.callTool("get_process_status", { process_id: processId });
			const data = extractJson<any>(result);
			lastState = JSON.stringify(data?.agent_state ?? data?.status ?? null);
			if (data?.agent_state?.idle === true) return;
		} catch (err) {
			lastState = err instanceof Error ? err.message : String(err);
		}
		await delay(intervalMs);
	}

	throw new Error(`Timed out waiting for Solo agent #${processId} to become ready (${lastState}).`);
}

/**
 * Wait briefly for a just-prompted agent to leave idle before scheduling
 * `timer_fire_when_idle_any`.
 *
 * Solo ignores processes that are already idle when an idle-any timer is
 * scheduled, so scheduling while the child is still at its prompt can miss the
 * completion transition. Returning false means the child never visibly left
 * idle within the window; callers should treat that as already complete and
 * surface the wake body directly instead of arming a timer that cannot fire.
 */
export async function waitForAgentBusy(
	client: SoloMcpLike,
	processId: number,
	options: { timeoutMs?: number; intervalMs?: number; initialDelayMs?: number } = {},
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 100;
	const startedAt = Date.now();
	await delay(options.initialDelayMs ?? 0);

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const result = await client.callTool("get_process_status", { process_id: processId });
			const data = extractJson<any>(result);
			const state = data?.agent_state;
			if (state?.idle === false || state?.thinking === true || state?.planning === true)
				return true;
		} catch {
			// Keep waiting; a transient status failure should not fail the launch.
		}
		await delay(intervalMs);
	}
	return false;
}

export interface ScheduledIdleWake {
	timerId?: number;
	status?: string;
	alreadySatisfied: boolean;
}

/** Schedule Solo's native idle/timeout wake-up for a child agent. */
export async function scheduleIdleWake(
	client: SoloMcpLike,
	processId: number,
	maxWaitMs: number,
	body: string,
): Promise<ScheduledIdleWake> {
	const result = await client.callTool("timer_fire_when_idle_any", {
		processes: [processId],
		max_wait_ms: maxWaitMs,
		body,
	});
	if (result.isError) throw new Error(`timer_fire_when_idle_any failed: ${errorText(result)}`);

	const data = extractJson<any>(result) ?? {};
	const timerId = typeof data.timer_id === "number" ? data.timer_id : undefined;
	const status = typeof data.status === "string" ? data.status : undefined;
	return {
		timerId,
		status,
		alreadySatisfied: timerId == null || status === "already_satisfied",
	};
}
