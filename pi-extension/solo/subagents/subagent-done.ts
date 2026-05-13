/**
 * Extension loaded INSIDE a subagent pi process via `-e <this-file>`.
 *
 * Responsibilities:
 *  - Surface the subagent's role + tool list as a styled widget above the
 *    editor (toggle with Ctrl+J), so the user can see what was spawned when
 *    they jump to the subagent's Solo pane.
 *  - Provide `subagent_done` so autonomous agents (auto-exit: true) can
 *    self-terminate after completing their work.
 *  - Provide `caller_ping` so agents can request help from the parent
 *    orchestrator without leaving the session orphaned.
 *  - Auto-exit on agent_end when `PI_SUBAGENT_AUTO_EXIT=1`, unless the user
 *    manually took over the conversation.
 *  - Write a `<session>.exit` sidecar JSON when shutting down, so the
 *    parent's pollForExit() can pick up the exit reason without scraping
 *    Solo's terminal output.
 *
 * Simplified from pi-interactive-subagents' subagent-done.ts: no separate
 * activity-recorder file. The parent uses Solo's native runtime-state
 * (idle/active) for status display; we only need the .exit sidecar for the
 * authoritative completion signal.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
	return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
	_userTookOver: boolean,
	messages: any[] | undefined,
): boolean {
	// Manual input should not strand an auto-exit subagent. If the latest
	// agent turn completed normally, close the session. Escape/abort still
	// leaves it open for inspection or another prompt.
	//
	// stopReason: "error" also returns true — we want to shut down so the
	// parent is woken up — but we pair this with findLatestAssistantError()
	// so the parent learns it was an error, not a clean completion.
	if (messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") {
				return msg.stopReason !== "aborted";
			}
		}
	}
	return true;
}

export interface SubagentErrorInfo {
	errorMessage: string;
	stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with stopReason: "error"
 * (typically auto-retry exhausted on overload / rate limit / server error),
 * return its error info so the parent can surface a clear failure instead
 * of treating the run as a silent success.
 */
export function findLatestAssistantError(messages: any[] | undefined): SubagentErrorInfo | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		return {
			errorMessage:
				raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
			stopReason: "error",
		};
	}
	return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
	return (rawValue ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export default function (pi: ExtensionAPI) {
	let toolNames: string[] = [];
	let denied: string[] = [];
	let expanded = false;

	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
	const deniedToolsValue = process.env.PI_DENY_TOOLS;
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const artifactScratchpadName = process.env.PI_SUBAGENT_ARTIFACT_SCRATCHPAD ?? "";

	function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
		ctx.ui.setWidget(
			"subagent-tools",
			(_tui: any, theme: any) => {
				const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

				const label = subagentAgent || subagentName;
				const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";
				const artifactTag = artifactScratchpadName
					? theme.fg("dim", ` · artifact → ${artifactScratchpadName}`)
					: "";

				if (expanded) {
					const countInfo = theme.fg("dim", ` — ${toolNames.length} tools available`);
					const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

					const toolList = toolNames
						.map((name: string) => theme.fg("dim", name))
						.join(theme.fg("muted", ", "));

					let deniedLine = "";
					if (denied.length > 0) {
						const deniedList = denied
							.map((name: string) => theme.fg("error", name))
							.join(theme.fg("muted", ", "));
						deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
					}

					box.addChild(
						new Text(
							`${agentTag}${countInfo}${artifactTag}${hint}\n${toolList}${deniedLine}`,
							0,
							0,
						),
					);
				} else {
					const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
					const deniedInfo =
						denied.length > 0
							? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
							: "";
					const hint = theme.fg("muted", "  (Ctrl+J to expand)");

					box.addChild(new Text(`${agentTag}${countInfo}${deniedInfo}${artifactTag}${hint}`, 0, 0));
				}

				return box;
			},
			{ placement: "aboveEditor" },
		);
	}

	let userTookOver = false;
	let agentStarted = false;

	pi.on("session_start", (_event, ctx) => {
		const tools = pi.getAllTools();
		toolNames = tools.map((t) => t.name).sort();
		denied = parseDeniedTools(deniedToolsValue);
		renderWidget(ctx, null);
	});

	pi.on("input", () => {
		if (!shouldMarkUserTookOver(agentStarted)) return;
		userTookOver = true;
	});

	pi.on("agent_start", () => {
		agentStarted = true;
	});

	pi.on("agent_end", (event, ctx) => {
		const messages = (event as any).messages as any[] | undefined;
		const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

		if (!shouldExit) {
			if (autoExit) {
				// Auto-exit subagents reset the takeover marker on every agent_end
				// — the decision is based on the latest assistant message's stop
				// reason, not on who initiated the turn.
				userTookOver = false;
			}
			return;
		}

		// Surface stopReason: "error" turns (auto-retry exhausted, provider
		// overload, etc.) to the parent via the .exit sidecar so the watcher
		// reports a clear failure instead of treating the crash as a success.
		const errorInfo = findLatestAssistantError(messages);
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (errorInfo && sessionFile) {
			try {
				writeFileSync(
					`${sessionFile}.exit`,
					JSON.stringify({
						type: "error",
						errorMessage: errorInfo.errorMessage,
						stopReason: errorInfo.stopReason,
					}),
				);
			} catch {
				// Best-effort — even without sidecar the session-file fallback
				// can still recover the error from the assistant entry.
			}
		}

		ctx.shutdown();
	});

	pi.registerShortcut("ctrl+j", {
		description: "Toggle subagent tools widget",
		handler: (ctx) => {
			expanded = !expanded;
			renderWidget(ctx, null);
		},
	});

	pi.registerTool({
		name: "caller_ping",
		label: "Caller Ping",
		description:
			"Send a help request to the parent agent and exit this session. " +
			"The parent is notified with your message and can resume this session with a response. " +
			"Use when you're stuck, need clarification, or need the parent to take action.",
		parameters: Type.Object({
			message: Type.String({ description: "What you need help with" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			if (!sessionFile) {
				throw new Error(
					"caller_ping is only available in subagent contexts. " +
						"PI_SUBAGENT_SESSION environment variable is not set.",
				);
			}

			writeFileSync(
				`${sessionFile}.exit`,
				JSON.stringify({
					type: "ping",
					name: process.env.PI_SUBAGENT_NAME ?? "subagent",
					message: params.message,
				}),
			);
			ctx.shutdown();
			return {
				content: [
					{ type: "text", text: "Ping sent. Session will exit and parent will be notified." },
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description:
			"Call this tool when you have completed your task. " +
			"It closes this session and returns your results to the parent orchestrator. " +
			"Your LAST assistant message before calling this becomes the summary returned to the caller. " +
			(artifactScratchpadName
				? `If your task asked you to produce an artifact, save it to Solo scratchpad "${artifactScratchpadName}" via solo_scratchpad_write first, then mention the scratchpad_id in your final message.`
				: "If your task produced an artifact (plan, spec, context document, report), prefer saving it to a Solo scratchpad via solo_scratchpad_write and mentioning the scratchpad_id in your final message."),
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			if (sessionFile) {
				try {
					writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
				} catch {}
			}
			ctx.shutdown();
			return {
				content: [{ type: "text", text: "Shutting down subagent session." }],
				details: {},
			};
		},
	});
}
