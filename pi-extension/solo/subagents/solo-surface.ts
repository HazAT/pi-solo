/**
 * Solo-native surface backend for subagents.
 *
 * Replaces the multi-mux abstraction from pi-interactive-subagents' cmux.ts
 * (cmux / tmux / zellij / wezterm). Solo has its own process surface model
 * and exposes everything we need over MCP:
 *
 *   spawn_process(kind="terminal") → create a new shell pane (visible in
 *     Solo's sidebar; the user can ⌘N to jump to it).
 *   send_input(process_id, input=…)         → type text + Enter
 *   send_input(process_id, bytes=[27])      → raw Escape key
 *   get_process_output(process_id, lines)   → read rendered tail
 *   search_output(process_id, pattern)      → scan rendered tail for sentinels
 *   close_process(process_id)               → remove the pane
 *   rename_process(process_id, new_name)    → label the pane
 *
 * Surfaces are identified by Solo's numeric process_id. This is the only
 * identifier the rest of the subagent system needs.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
	if (result.structuredContent && typeof result.structuredContent === "object") {
		return result.structuredContent as T;
	}
	const first = result.content?.find((c) => c.type === "text" && typeof c.text === "string");
	if (!first?.text) return undefined;
	try {
		return JSON.parse(first.text) as T;
	} catch {
		return undefined;
	}
}

export function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Detect fish shell so we use $status instead of $? in the sentinel echo. */
export function isFishShell(): boolean {
	const shell = process.env.SHELL ?? "";
	return shell.endsWith("/fish") || shell === "fish";
}

export function exitStatusVar(): string {
	return isFishShell() ? "$status" : "$?";
}

/**
 * Spawn a Solo terminal and return its process id + display name.
 *
 * The display name is what shows up in Solo's sidebar. We keep it short and
 * prefixed with a marker so it's clearly a subagent vs a user-spawned shell.
 */
export async function createSurface(
	client: SoloMcpLike,
	name: string,
): Promise<{ processId: number; name: string }> {
	const result = await client.callTool("spawn_process", {
		kind: "terminal",
		name: trimSurfaceName(name),
	});
	if (result.isError) {
		const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
		throw new Error(`spawn_process failed: ${text ?? "(unknown)"}`);
	}
	const data = extractJson<{ process_id?: number; name?: string }>(result);
	const processId = typeof data?.process_id === "number" ? data.process_id : undefined;
	if (processId == null) {
		throw new Error(`spawn_process did not return a process_id: ${JSON.stringify(data)}`);
	}
	return { processId, name: data?.name ?? name };
}

function trimSurfaceName(name: string): string {
	// Solo display names look best at ≤ 32 chars in the sidebar.
	const clean = name.trim();
	return clean.length > 32 ? clean.slice(0, 31) + "…" : clean || "subagent";
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

/** Send a command line + Enter to the surface. */
export async function sendCommand(
	client: SoloMcpLike,
	processId: number,
	command: string,
): Promise<void> {
	const result = await client.callTool("send_input", {
		process_id: processId,
		input: command,
		submit: true,
	});
	if (result.isError) {
		const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
		throw new Error(`send_input failed: ${text ?? "(unknown)"}`);
	}
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
	if (result.isError) {
		const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
		throw new Error(`send_input(bytes) failed: ${text ?? "(unknown)"}`);
	}
}

/** Send one Escape keypress (interrupts a running Pi turn without killing the session). */
export async function sendEscape(client: SoloMcpLike, processId: number): Promise<void> {
	await sendBytes(client, processId, [27]);
}

/** Read the rendered tail of the surface (rows, not raw bytes). */
export async function readScreen(
	client: SoloMcpLike,
	processId: number,
	lines = 50,
): Promise<string> {
	try {
		const result = await client.callTool("get_process_output", {
			process_id: processId,
			lines,
		});
		const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
		return text ?? "";
	} catch {
		return "";
	}
}

/**
 * Scan the rendered tail for a pattern. Returns true when a match is found.
 * Uses Solo's `search_output` which is cheaper than pulling the whole tail
 * across MCP.
 */
export async function screenHasPattern(
	client: SoloMcpLike,
	processId: number,
	pattern: string,
): Promise<boolean> {
	try {
		const result = await client.callTool("search_output", {
			process_id: processId,
			pattern,
			max_results: 1,
		});
		const data = extractJson<{ matches?: unknown[] } | unknown[]>(result);
		if (Array.isArray(data)) return data.length > 0;
		if (Array.isArray(data?.matches)) return data!.matches!.length > 0;
		const text = result.content?.find((c) => c.type === "text" && c.text)?.text ?? "";
		return text.includes(pattern);
	} catch {
		return false;
	}
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
 * Send a long command to a surface by writing it to a script file first and
 * running `bash <path>`. Avoids PTY line-wrap issues when the assembled
 * command exceeds the surface's column width.
 *
 * Returns the script path so the caller can include it in tool details
 * (useful for debugging exact env + arg invocations).
 */
export function writeLaunchScript(scriptPath: string, command: string, preamble?: string): string {
	mkdirSync(dirname(scriptPath), { recursive: true });
	const parts = ["#!/bin/bash"];
	if (preamble) parts.push(preamble.trimEnd());
	parts.push(command);
	writeFileSync(scriptPath, parts.join("\n") + "\n", { mode: 0o755 });
	return scriptPath;
}

export async function sendLongCommand(
	client: SoloMcpLike,
	processId: number,
	command: string,
	options?: { scriptPath?: string; scriptPreamble?: string },
): Promise<string> {
	const scriptPath =
		options?.scriptPath ??
		join(
			tmpdir(),
			"pi-solo-subagent-scripts",
			`cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
		);
	writeLaunchScript(scriptPath, command, options?.scriptPreamble);
	await sendCommand(client, processId, `bash ${shellEscape(scriptPath)}`);
	return scriptPath;
}

/**
 * Optional: query Solo's runtime state for the surface (idle/active/exited).
 * Returns "unknown" if the field isn't present in the response.
 *
 * Solo distinguishes runtime states that map well to subagent state:
 *   - "active" / "running"   → child agent is doing work
 *   - "idle"                 → child is waiting at a prompt
 *   - "exited" / "stopped"   → child finished
 */
export async function getRuntimeState(client: SoloMcpLike, processId: number): Promise<string> {
	try {
		const result = await client.callTool("get_process_status", { process_id: processId });
		const data = extractJson<any>(result);
		const candidates = [data?.runtime_state, data?.agent_runtime_state, data?.state, data?.status];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.length > 0) return candidate.toLowerCase();
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}

// -------------------------------------------------------------------------
// Completion polling
//
// Subagents signal completion in one of three ways:
//
//   1. Best path — they call subagent_done / caller_ping, which writes a
//      `<session>.exit` sidecar JSON file describing the exit type.
//
//   2. Fallback — the wrapping shell prints `__SUBAGENT_DONE_<exitcode>__`
//      after the pi process returns. Used to detect crashes / shell errors
//      that don't go through the in-child extension.
//
//   3. Worst case — neither appears and we hit `signal.aborted` (parent shut
//      down or interruption requested).

export interface PollResult {
	reason: "done" | "ping" | "sentinel" | "error";
	exitCode: number;
	ping?: { name: string; message: string };
	errorMessage?: string;
}

export function interpretExitSidecar(data: any): PollResult {
	if (data?.type === "ping") {
		return {
			reason: "ping",
			exitCode: 0,
			ping: {
				name: typeof data.name === "string" ? data.name : "subagent",
				message: typeof data.message === "string" ? data.message : "",
			},
		};
	}
	if (data?.type === "error") {
		const errorMessage =
			typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
				? data.errorMessage
				: "Subagent exited with stopReason=error (no errorMessage in sidecar).";
		return { reason: "error", exitCode: 1, errorMessage };
	}
	return { reason: "done", exitCode: 0 };
}

export const SENTINEL_RE = /__SUBAGENT_DONE_(\d+)__/;

export async function pollForExit(
	client: SoloMcpLike,
	processId: number,
	signal: AbortSignal,
	options: {
		interval: number;
		sessionFile?: string;
		onTick?: (elapsed: number) => void;
	},
): Promise<PollResult> {
	const start = Date.now();
	for (;;) {
		if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

		// Fast path — .exit sidecar set by subagent_done / caller_ping / the
		// stopReason: "error" path in subagent-done.ts.
		if (options.sessionFile) {
			try {
				const exitFile = `${options.sessionFile}.exit`;
				if (existsSync(exitFile)) {
					const data = JSON.parse(readFileSync(exitFile, "utf8"));
					rmSync(exitFile, { force: true });
					return interpretExitSidecar(data);
				}
			} catch {
				// fall through to sentinel
			}
		}

		// Slow path — look for the shell sentinel in Solo's rendered tail.
		try {
			if (await screenHasPattern(client, processId, "__SUBAGENT_DONE_")) {
				const screen = await readScreen(client, processId, 20);
				const match = screen.match(SENTINEL_RE);
				if (match) {
					return { reason: "sentinel", exitCode: parseInt(match[1]!, 10) };
				}
			}
		} catch {
			// Surface vanished — try sidecar one last time before erroring out.
			if (options.sessionFile) {
				try {
					const exitFile = `${options.sessionFile}.exit`;
					if (existsSync(exitFile)) {
						const data = JSON.parse(readFileSync(exitFile, "utf8"));
						rmSync(exitFile, { force: true });
						return interpretExitSidecar(data);
					}
				} catch {}
			}
		}

		const elapsed = Math.floor((Date.now() - start) / 1000);
		options.onTick?.(elapsed);

		await new Promise<void>((resolve, reject) => {
			if (signal.aborted) return reject(new Error("Aborted"));
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, options.interval);
			function onAbort() {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			}
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
