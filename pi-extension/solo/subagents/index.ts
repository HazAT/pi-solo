/**
 * Solo-native subagent orchestration.
 *
 * Subagents run as real Solo agent processes (`spawn_process(kind="agent")`).
 * The parent drives the child with one plain-text prompt, schedules Solo's
 * native idle timer, and reads the child's artifact from a Solo scratchpad
 * when the timer wakes the parent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	type SoloMcpLike,
	closeSurface,
	createAgentSurface,
	renameSurface,
	resolvePiAgentToolId,
	scheduleIdleWake,
	sendCommand,
	sendEscape,
	waitForAgentBusy,
	waitForAgentReady,
} from "./solo-surface.ts";

// ── Agent definitions ────────────────────────────────────────────────────

type AgentSource = "global" | "project";

interface AgentDefaults {
	// v2 honors these fields.
	interactive?: boolean;
	body?: string;
	output?: string;

	// Parsed for listing/tolerance only. kind="agent" cannot honor per-spawn
	// model/tool/session/env customization.
	model?: string;
	tools?: string;
	skills?: string;
	thinking?: string;
	denyTools?: string;
	spawning?: boolean;
	autoExit?: boolean;
	systemPromptMode?: "append" | "replace";
	sessionMode?: "standalone" | "lineage-only" | "fork";
	cwd?: string;
	disableModelInvocation?: boolean;
}

interface AgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
	source: AgentSource;
}

function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1]!.trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	if (value == null) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

export function parseAgentDefinition(
	content: string,
	fallbackName: string,
): AgentDefinition | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const frontmatter = match[1]!;
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");
	const sessionMode = getFrontmatterValue(frontmatter, "session-mode");

	return {
		name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
		description: getFrontmatterValue(frontmatter, "description"),
		model: getFrontmatterValue(frontmatter, "model"),
		tools: getFrontmatterValue(frontmatter, "tools"),
		skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
		thinking: getFrontmatterValue(frontmatter, "thinking"),
		denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
		spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
		autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
		interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
		systemPromptMode:
			systemPromptMode === "replace"
				? "replace"
				: systemPromptMode === "append"
					? "append"
					: undefined,
		sessionMode:
			sessionMode === "standalone" || sessionMode === "lineage-only" || sessionMode === "fork"
				? sessionMode
				: undefined,
		cwd: getFrontmatterValue(frontmatter, "cwd"),
		output: getFrontmatterValue(frontmatter, "output"),
		body: body || undefined,
		disableModelInvocation:
			getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
	};
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
	const agents = new Map<string, ListedAgentDefinition>();
	const dirs: Array<{ path: string; source: AgentSource }> = [
		{ path: join(getAgentConfigDir(), "agents"), source: "global" },
		{ path: join(process.cwd(), ".pi", "agents"), source: "project" },
	];

	for (const { path: dir, source } of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
			const parsed = parseAgentDefinition(
				readFileSync(join(dir, file), "utf8"),
				file.replace(/\.md$/, ""),
			);
			if (!parsed) continue;
			agents.set(parsed.name, { ...parsed, source });
		}
	}
	return [...agents.values()];
}

function loadAgentDefaults(agentName: string): AgentDefinition | null {
	const paths = [
		join(process.cwd(), ".pi", "agents", `${agentName}.md`),
		join(getAgentConfigDir(), "agents", `${agentName}.md`),
	];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const parsed = parseAgentDefinition(readFileSync(path, "utf8"), agentName);
		if (parsed) return parsed;
	}
	return null;
}

export function resolveEffectiveInteractive(
	params: { interactive?: boolean },
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.interactive != null) return params.interactive;
	return agentDefs?.interactive ?? false;
}

// ── Scratchpad artifacts ─────────────────────────────────────────────────

/** Generate a unique scratchpad name for a subagent artifact. */
export function buildArtifactScratchpadName(
	agentName: string | undefined,
	displayName: string,
): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16); // YYYY-MM-DDTHH-MM
	const safeAgent = (agentName ?? "subagent")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const safeName = displayName
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32);
	return `${safeAgent}/${ts}-${safeName || "task"}`;
}

interface CreatedScratchpad {
	scratchpadId?: number;
	revision?: number;
	name: string;
}

function extractToolJson<T = any>(result: {
	structuredContent?: unknown;
	content?: Array<{ type: string; text?: string }>;
}): T | undefined {
	if (result.structuredContent != null) return result.structuredContent as T;
	const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** Pre-create a Solo scratchpad to hold the subagent's artifact. */
async function preCreateArtifactScratchpad(
	client: SoloMcpLike,
	name: string,
	agentName: string | undefined,
	taskPreview: string,
): Promise<CreatedScratchpad> {
	const placeholder =
		`# ${name}\n\n` +
		`> Reserved by pi-solo subagent orchestration${agentName ? ` for the **${agentName}** agent` : ""}.\n` +
		`> The subagent should overwrite this scratchpad with its artifact before it stops.\n\n` +
		`**Task preview:** ${taskPreview.slice(0, 400)}${taskPreview.length > 400 ? "…" : ""}\n`;

	try {
		const result = await client.callTool("scratchpad_write", {
			name,
			content: placeholder,
			tags: ["subagent-artifact", ...(agentName ? [agentName] : [])],
		});
		const data = extractToolJson<any>(result) ?? {};
		return {
			name,
			scratchpadId: typeof data.scratchpad_id === "number" ? data.scratchpad_id : undefined,
			revision: typeof data.revision === "number" ? data.revision : undefined,
		};
	} catch {
		return { name };
	}
}

function wantsScratchpad(
	params: { scratchpad?: boolean },
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.scratchpad != null) return params.scratchpad;
	return agentDefs?.output?.trim().toLowerCase() !== "false";
}

// ── Task and wake-up text ────────────────────────────────────────────────

interface BuildTaskParams {
	agentInstructions?: string;
	roleBlock?: string;
	task: string;
	artifactScratchpadName?: string;
	artifactScratchpadId?: number;
	artifactScratchpadRevision?: number;
	interactive?: boolean;
}

export function buildWrappedTask(params: BuildTaskParams): string {
	const sections: string[] = [];
	if (params.agentInstructions?.trim()) sections.push(params.agentInstructions.trim());
	if (params.roleBlock?.trim()) sections.push(params.roleBlock.trim());

	sections.push(
		[
			"Complete your task.",
			"Your LAST assistant message is your summary. Make it self-contained because the parent will read your scratchpad and may also inspect your final message.",
			"When you finish, simply stop and wait for the next user message. Do not exit the pi process. You do not need to call any done tool; the parent is watching this Solo process and will wake up when it goes idle.",
			params.interactive
				? "This is an interactive subagent. After your current turn, wait in this pane so the user can continue the conversation."
				: "This is an autonomous subagent. Finish the requested work, write the artifact, summarize, and then stop.",
		].join("\n\n"),
	);

	if (params.artifactScratchpadName) {
		const idText =
			params.artifactScratchpadId != null ? ` (id ${params.artifactScratchpadId})` : "";
		const revisionText =
			params.artifactScratchpadId != null && params.artifactScratchpadRevision != null
				? ` Use scratchpad_id: ${params.artifactScratchpadId} and expected_revision: ${params.artifactScratchpadRevision} when you overwrite the placeholder.`
				: params.artifactScratchpadId != null
					? ` Read scratchpad_id: ${params.artifactScratchpadId} first if you need its latest revision, then overwrite the placeholder.`
					: " If it does not exist yet, create it with solo_scratchpad_write using that name.";
		sections.push(
			[
				"### Artifact (Solo scratchpad)",
				`Save any artifact you produce (plan, spec, context document, report, result note, etc.) to the Solo scratchpad named "${params.artifactScratchpadName}"${idText} via solo_scratchpad_write.${revisionText}`,
				"Reference the scratchpad name and id in your final summary so the parent can pick up the result.",
			].join("\n\n"),
		);
	}

	sections.push(["---", params.task].join("\n\n"));
	return sections.join("\n\n");
}

function quoteMarkerValue(value: string): string {
	return value.replace(/["\\]/g, "\\$&");
}

interface BuildWakeBodyParams {
	subagentName: string;
	agent?: string;
	processId: number;
	scratchpadName?: string;
	scratchpadId?: number;
	interactive: boolean;
	maxWaitMs?: number;
}

export function buildWakeBody(params: BuildWakeBodyParams): string {
	const markerKind = params.interactive ? "subagent-interactive-ready" : "subagent-done";
	const scratchpadMarker = params.scratchpadId != null ? ` scratchpad=${params.scratchpadId}` : "";
	const agentMarker = params.agent ? ` agent="${quoteMarkerValue(params.agent)}"` : "";
	const marker = `[pi-solo:${markerKind} id=${params.processId}${scratchpadMarker} name="${quoteMarkerValue(params.subagentName)}"${agentMarker}]`;
	const scratchpadRef = params.scratchpadName
		? `Its artifact scratchpad is "${params.scratchpadName}"${
				params.scratchpadId != null ? ` (id ${params.scratchpadId})` : ""
			}. Read it with solo_scratchpad_read${
				params.scratchpadId != null
					? `(scratchpad_id=${params.scratchpadId})`
					: ` after locating it by name`
			} to pick up where it left off.`
		: "No artifact scratchpad was pre-created for this subagent.";
	const maxWait = params.maxWaitMs != null ? Math.round(params.maxWaitMs / 60_000) : 30;

	if (params.interactive) {
		return [
			marker,
			`Sub-agent "${params.subagentName}" (Solo agent #${params.processId}) finished its current turn or reached the ${maxWait} minute watcher cap and is waiting in its Solo pane.`,
			scratchpadRef,
			"Do not close this pane automatically; the user can continue the conversation in Solo.",
		].join("\n\n");
	}

	return [
		marker,
		`Sub-agent "${params.subagentName}" (Solo agent #${params.processId}) triggered its Solo idle watcher or reached the ${maxWait} minute watcher cap.`,
		scratchpadRef,
		'If this looks premature, inspect output with solo_tool({ action: "call", name: "get_process_output", arguments: { process_id: ' +
			params.processId +
			', lines: 80 } }) and resume the conversation with solo_tool({ action: "call", name: "send_input", arguments: { process_id: ' +
			params.processId +
			', input: "..." }, reason: "resume subagent after premature idle wake" }) if needed.',
		'When you have used the result, close the subagent pane with solo_tool({ action: "call", name: "close_process", arguments: { process_id: ' +
			params.processId +
			' }, reason: "close completed subagent pane" }).',
	].join("\n\n");
}

function parseWakeMarker(text: string): { processId: number } | null {
	const match = text.match(/^\[pi-solo:subagent-(?:done|interactive-ready) id=(\d+)/);
	if (!match) return null;
	return { processId: Number(match[1]) };
}

// ── Tool parameters ─────────────────────────────────────────────────────

const SubagentParams = Type.Object({
	name: Type.String({ description: "Display name for the subagent (shown in Solo's sidebar)" }),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	agent: Type.Optional(
		Type.String({
			description:
				"Agent name to load identity/defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads project .pi/agents/ and global ~/.pi/agent/agents/.",
		}),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Additional role instructions" })),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Mark the subagent as interactive. The wake-up tells the parent/user not to close the pane.",
		}),
	),
	scratchpad: Type.Optional(
		Type.Boolean({
			description:
				"Pre-create a Solo scratchpad for the subagent's artifact. Defaults to true unless the agent definition sets output: false.",
		}),
	),
});

// ── Launch ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;

interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	processId: number;
	timerId?: number;
	startTime: number;
	interactive: boolean;
	runtimeState?: string;
	artifactScratchpadName?: string;
	artifactScratchpadId?: number;
	wakeBody: string;
	wakeAlreadyDue: boolean;
}

const runningSubagents = new Map<string, RunningSubagent>();

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

function labelForSurface(name: string, agent?: string): string {
	const agentTag = agent ? `[${agent}] ` : "🤖 ";
	return `${agentTag}${name}`;
}

function buildRoleBlock(agentDefs: AgentDefaults | null, systemPrompt?: string): string {
	return [agentDefs?.body, systemPrompt].filter((part) => part?.trim()).join("\n\n");
}

async function launchSubagent(
	client: SoloMcpLike,
	params: Static<typeof SubagentParams>,
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
	const interactive = resolveEffectiveInteractive(params, agentDefs);

	let artifact: CreatedScratchpad | null = null;
	if (wantsScratchpad(params, agentDefs)) {
		artifact = await preCreateArtifactScratchpad(
			client,
			buildArtifactScratchpadName(params.agent, params.name),
			params.agent,
			params.task,
		);
	}

	const agentToolId = await resolvePiAgentToolId(client);
	const tagged = labelForSurface(params.name, params.agent);
	const surface = await createAgentSurface(client, tagged, agentToolId);
	await renameSurface(client, surface.processId, tagged);
	await waitForAgentReady(client, surface.processId);

	const wakeBody = buildWakeBody({
		subagentName: params.name,
		agent: params.agent,
		processId: surface.processId,
		scratchpadName: artifact?.name,
		scratchpadId: artifact?.scratchpadId,
		interactive,
		maxWaitMs: DEFAULT_MAX_WAIT_MS,
	});
	const wrappedTask = buildWrappedTask({
		agentInstructions: surface.agentInstructions,
		roleBlock: buildRoleBlock(agentDefs, params.systemPrompt),
		task: params.task,
		artifactScratchpadName: artifact?.name,
		artifactScratchpadId: artifact?.scratchpadId,
		artifactScratchpadRevision: artifact?.revision,
		interactive,
	});

	try {
		await sendCommand(client, surface.processId, wrappedTask);
	} catch (err) {
		await closeSurface(client, surface.processId);
		throw err;
	}

	const becameBusy = await waitForAgentBusy(client, surface.processId);
	let wake: { timerId?: number } = { timerId: undefined };
	try {
		if (becameBusy) {
			wake = await scheduleIdleWake(client, surface.processId, DEFAULT_MAX_WAIT_MS, wakeBody);
		}
	} catch (err) {
		await closeSurface(client, surface.processId);
		throw err;
	}

	const running: RunningSubagent = {
		id,
		name: params.name,
		task: params.task,
		agent: params.agent,
		processId: surface.processId,
		timerId: wake.timerId,
		startTime,
		interactive,
		runtimeState: "active",
		artifactScratchpadName: artifact?.name,
		artifactScratchpadId: artifact?.scratchpadId,
		wakeBody,
		wakeAlreadyDue: !becameBusy,
	};
	runningSubagents.set(id, running);
	return running;
}

function resolveInterruptTarget(params: {
	id?: string;
	name?: string;
}): { running: RunningSubagent } | { error: string } {
	const requestedId = params.id?.trim();
	if (requestedId) {
		const running = runningSubagents.get(requestedId);
		return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
	}
	const requestedName = params.name?.trim();
	if (!requestedName) return { error: "Provide a running subagent id or exact display name." };
	const matches = Array.from(runningSubagents.values()).filter((r) => r.name === requestedName);
	if (matches.length === 1) return { running: matches[0]! };
	if (matches.length === 0) return { error: `No running subagent named "${requestedName}".` };
	const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
	return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function muxUnavailableResult(reason: string) {
	return {
		content: [{ type: "text" as const, text: reason }],
		details: { error: reason },
	};
}

// ── Public entry point ──────────────────────────────────────────────────

export interface SoloSubagentDeps {
	client: SoloMcpLike;
	isClientReady: () => boolean;
}

export function initSoloSubagents(pi: ExtensionAPI, deps: SoloSubagentDeps) {
	pi.on("session_shutdown", () => {
		runningSubagents.clear();
	});

	pi.on("input", (event: any) => {
		const marker = parseWakeMarker(event.text ?? "");
		if (!marker) return { action: "continue" };
		for (const [id, running] of runningSubagents) {
			if (running.processId === marker.processId) runningSubagents.delete(id);
		}
		return { action: "continue" };
	});

	// ── solo_subagent ──
	pi.registerTool({
		name: "solo_subagent",
		label: "Solo Subagent",
		description:
			"Spawn a sub-agent as a real Solo agent process (kind=agent). " +
			"This is fire-and-forget: the call returns after the child is launched and an idle timer is scheduled. " +
			"When the child goes idle (or the timer hits its max wait), Solo injects a fresh user turn into the parent with the process id and scratchpad id. " +
			"Artifacts are saved to Solo scratchpads. Do not poll or fabricate results.",
		promptSnippet:
			"Spawn a Solo-native sub-agent. Fire-and-forget; Solo wakes the parent when the child goes idle. Artifacts go to Solo scratchpads.",
		parameters: SubagentParams,

		async execute(_toolCallId, params) {
			if (!deps.isClientReady()) {
				return muxUnavailableResult(
					"Solo MCP not ready — make sure Solo is running and MCP is enabled (Settings → MCP).",
				);
			}

			const running = await launchSubagent(deps.client, params);
			const artifactText = running.artifactScratchpadName
				? `Artifact scratchpad: "${running.artifactScratchpadName}"${running.artifactScratchpadId != null ? ` (id ${running.artifactScratchpadId})` : ""}. `
				: "";
			const statusText = running.wakeAlreadyDue
				? `It returned to idle before a timer could be armed. Treat this as the wake-up body now:\n\n${running.wakeBody}`
				: `Solo will wake the parent when it goes idle or reaches the 30 minute max wait. ${artifactText}Do not poll or guess results; wait for the wake-up body.`;
			return {
				content: [
					{
						type: "text" as const,
						text: `Sub-agent "${params.name}" launched in Solo agent pane #${running.processId}. ${statusText}`,
					},
				],
				details: {
					id: running.id,
					name: params.name,
					task: params.task,
					agent: params.agent,
					processId: running.processId,
					timerId: running.timerId,
					artifactScratchpadName: running.artifactScratchpadName,
					artifactScratchpadId: running.artifactScratchpadId,
					wakeAlreadyDue: running.wakeAlreadyDue,
					status: "started",
				},
			};
		},

		renderCall(args, theme) {
			const partial = args as Record<string, unknown>;
			const name = typeof partial.name === "string" && partial.name ? partial.name : "(unnamed)";
			const task = typeof partial.task === "string" ? partial.task : "";
			const agent =
				typeof partial.agent === "string" && partial.agent
					? theme.fg("dim", ` (${partial.agent})`)
					: "";
			let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent;
			if (task) {
				const first = task.split("\n").find((line: string) => line.trim()) ?? "";
				const preview = first.length > 100 ? first.slice(0, 100) + "…" : first;
				if (preview) text += "\n" + theme.fg("toolOutput", preview);
				const lines = task.split("\n").length;
				if (lines > 1) text += theme.fg("muted", ` (${lines} lines)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			const name = details?.name ?? "(unnamed)";
			if (details?.status === "started") {
				const artifactTag = details?.artifactScratchpadName
					? theme.fg("dim", ` · artifact → ${details.artifactScratchpadName}`)
					: "";
				const timerTag =
					details?.timerId != null ? theme.fg("dim", ` · timer #${details.timerId}`) : "";
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", ` — started (Solo #${details.processId})`) +
						artifactTag +
						timerTag,
					0,
					0,
				);
			}
			const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
			return new Text(theme.fg("dim", text), 0, 0);
		},
	});

	// ── solo_subagent_interrupt ──
	pi.registerTool({
		name: "solo_subagent_interrupt",
		label: "Interrupt Solo Subagent",
		description:
			"Send Escape to a running Solo subagent. The Solo pane and idle timer stay alive; this only interrupts the active turn.",
		promptSnippet: "Interrupt the active turn of a running Solo subagent without killing the pane.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
			name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
		}),
		async execute(_toolCallId, params) {
			const resolved = resolveInterruptTarget(params);
			if ("error" in resolved) {
				return {
					content: [{ type: "text" as const, text: resolved.error }],
					details: { error: resolved.error },
				};
			}
			const running = resolved.running;
			try {
				await sendEscape(deps.client, running.processId);
				return {
					content: [
						{
							type: "text" as const,
							text: `Interrupt requested for subagent "${running.name}".`,
						},
					],
					details: { id: running.id, name: running.name, status: "interrupt_requested" },
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to send Escape: ${err?.message ?? String(err)}`,
						},
					],
					details: { id: running.id, name: running.name, error: err?.message },
				};
			}
		},
	});

	// ── solo_subagents_list ──
	pi.registerTool({
		name: "solo_subagents_list",
		label: "List Solo Subagent Definitions",
		description:
			"List all available subagent definitions. Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. Project-local agents override global ones with the same name.",
		promptSnippet:
			"List the agent definitions available to solo_subagent (scout, worker, planner, …).",
		parameters: Type.Object({}),
		async execute() {
			const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);
			if (list.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No subagent definitions found." }],
					details: { agents: [] },
				};
			}
			const lines = list.map((agent) => {
				const badge = agent.source === "project" ? " (project)" : "";
				const desc = agent.description ? ` — ${agent.description}` : "";
				const interactive = agent.interactive ? " [interactive]" : "";
				return `• ${agent.name}${badge}${interactive}${desc}`;
			});
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { agents: list },
			};
		},
	});

	// ── /solo-subagent ──
	pi.registerCommand("solo-subagent", {
		description: "Spawn a Solo-native subagent: /solo-subagent <agent> [task]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /solo-subagent <agent> [task]", "warning");
				return;
			}
			const spaceIdx = trimmed.indexOf(" ");
			const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			const defs = loadAgentDefaults(agentName);
			if (!defs) {
				ctx.ui.notify(
					`Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
					"error",
				);
				return;
			}
			const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
			const displayName = agentName[0]!.toUpperCase() + agentName.slice(1);
			pi.sendUserMessage(
				`Use solo_subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`,
			);
		},
	});

	pi.registerMessageRenderer("solo_subagent_result", (message, _options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;
		return {
			render(): string[] {
				const name = details.name ?? "subagent";
				const content = typeof message.content === "string" ? message.content : "";
				return [
					"",
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", ` — Solo #${details.processId ?? "?"}`),
					...content.split("\n").map((line) => theme.fg("dim", line)),
				];
			},
		};
	});
}

// Exported for tests
export const __test__ = {
	buildArtifactScratchpadName,
	buildWakeBody,
	buildWrappedTask,
	discoverAgentDefinitions,
	formatElapsed,
	labelForSurface,
	loadAgentDefaults,
	parseAgentDefinition,
	parseWakeMarker,
	resolveEffectiveInteractive,
	resolveInterruptTarget,
	runningSubagents,
	wantsScratchpad,
};
