import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SoloNotificationMode = "off" | "subagent" | "agent-end" | "all";
export type TerminalNotificationMethod =
	| "solo-terminal"
	| "osc777"
	| "osc99"
	| "osc9"
	| "macos"
	| "unsupported";

export interface SoloNotificationMcpClient {
	callTool(
		name: string,
		args: unknown,
	): Promise<{
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
		structuredContent?: unknown;
	}>;
}

export interface SoloSubagentNotification {
	kind: "done" | "interactive-ready";
	processId: number;
	name: string;
	agent?: string;
	scratchpadId?: number;
	scratchpadName?: string;
}

export interface SoloNotificationResult {
	ok: boolean;
	method: TerminalNotificationMethod;
	processId?: number;
	error?: string;
}

export interface SoloNotifications {
	getMode(): SoloNotificationMode;
	setMode(mode: SoloNotificationMode): void;
	queueSubagentReady(notification: SoloSubagentNotification): void;
	notify(
		title: string,
		body: string,
		forcedMethod?: TerminalNotificationMethod,
	): Promise<SoloNotificationResult>;
}

const DEFAULT_NOTIFICATION_MODE: SoloNotificationMode = "off";
const NOTIFICATION_TERMINAL_NAME = "Pi Solo Notifications";
const MAX_NOTIFICATION_TEXT_LENGTH = 240;

export function parseSoloNotificationMode(
	value: string | undefined | null,
): SoloNotificationMode | null {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return null;
	if (["0", "false", "no", "none", "off", "disable", "disabled"].includes(normalized)) return "off";
	if (["1", "true", "yes", "on", "subagent", "subagents", "worker", "workers"].includes(normalized))
		return "subagent";
	if (
		["agent", "agent-end", "agent_end", "agentend", "end", "every", "always"].includes(normalized)
	)
		return "agent-end";
	if (["all", "both"].includes(normalized)) return "all";
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function configuredModeFromSettings(
	settings: Record<string, unknown> | undefined,
): SoloNotificationMode | null {
	if (!settings) return null;
	const piSolo = settings.piSolo;
	if (!isRecord(piSolo)) return null;
	return parseSoloNotificationMode(
		typeof piSolo.notifications === "string" ? piSolo.notifications : undefined,
	);
}

export function readConfiguredSoloNotificationMode(cwd: string): SoloNotificationMode {
	const envMode = parseSoloNotificationMode(process.env.PI_SOLO_NOTIFY);
	if (envMode) return envMode;

	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const globalMode = configuredModeFromSettings(readJsonObject(join(agentDir, "settings.json")));
	const projectMode = configuredModeFromSettings(readJsonObject(join(cwd, ".pi", "settings.json")));
	return projectMode ?? globalMode ?? DEFAULT_NOTIFICATION_MODE;
}

export function notificationModeIncludes(
	mode: SoloNotificationMode,
	reason: "subagent" | "agent-end",
): boolean {
	if (mode === "all") return true;
	return mode === reason;
}

export function sanitizeNotificationText(value: string): string {
	let sanitized = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		sanitized += code < 32 || code === 127 || char === ";" || char === "\\" ? " " : char;
	}
	return sanitized.replace(/\s+/g, " ").trim().slice(0, MAX_NOTIFICATION_TEXT_LENGTH);
}

export function detectTerminalNotificationMethod(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): TerminalNotificationMethod {
	if (env.KITTY_WINDOW_ID) return "osc99";
	if (env.ITERM_SESSION_ID || env.TERM_PROGRAM === "iTerm.app") return "osc9";
	if (
		env.TERM_PROGRAM === "solo" ||
		env.TERM_PROGRAM === "ghostty" ||
		env.GHOSTTY_RESOURCES_DIR ||
		env.WEZTERM_PANE ||
		env.VTE_VERSION ||
		(env.TERM ?? "").toLowerCase().includes("ghostty")
	) {
		return "osc777";
	}
	return platform === "darwin" ? "macos" : "unsupported";
}

export function buildTerminalNotificationSequence(
	method: Exclude<TerminalNotificationMethod, "solo-terminal" | "macos" | "unsupported">,
	title: string,
	body: string,
): string {
	const safeTitle = sanitizeNotificationText(title) || "Pi";
	const safeBody = sanitizeNotificationText(body) || "Ready for input";
	if (method === "osc777") return `\x1b]777;notify;${safeTitle};${safeBody}\x07`;
	if (method === "osc9") return `\x1b]9;${safeTitle}: ${safeBody}\x07`;
	return `\x1b]99;i=pi-solo:d=0;${safeTitle}\x1b\\` + `\x1b]99;i=pi-solo:p=body;${safeBody}\x1b\\`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildSoloTerminalNotificationCommand(title: string, body: string): string {
	const safeTitle = sanitizeNotificationText(title) || "Pi";
	const safeBody = sanitizeNotificationText(body) || "Ready for input";
	const payload = `\\033]777;notify;${safeTitle};${safeBody}\\007`;
	return `printf '%b' ${shellSingleQuote(payload)}`;
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

function errorText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.find((c) => c.type === "text" && c.text)?.text ?? "(unknown)";
}

export async function sendLocalNotification(
	title: string,
	body: string,
	forcedMethod?: TerminalNotificationMethod,
): Promise<SoloNotificationResult> {
	const method =
		forcedMethod && forcedMethod !== "solo-terminal" && forcedMethod !== "unsupported"
			? forcedMethod
			: detectTerminalNotificationMethod();
	if (method === "solo-terminal") {
		return { ok: false, method, error: "solo-terminal requires a Solo MCP client" };
	}
	if (method === "unsupported") {
		return { ok: false, method, error: "No supported local notification transport detected" };
	}

	if (method === "macos") {
		const safeTitle = sanitizeNotificationText(title) || "Pi Solo";
		const safeBody = sanitizeNotificationText(body) || "Ready for input";
		try {
			await execFileAsync(
				"osascript",
				[
					"-e",
					`display notification "${escapeAppleScriptString(safeBody)}" with title "${escapeAppleScriptString(safeTitle)}"`,
				],
				{ timeout: 5_000 },
			);
			return { ok: true, method };
		} catch (err) {
			return { ok: false, method, error: err instanceof Error ? err.message : String(err) };
		}
	}

	try {
		process.stdout.write(buildTerminalNotificationSequence(method, title, body));
		return { ok: true, method };
	} catch (err) {
		return { ok: false, method, error: err instanceof Error ? err.message : String(err) };
	}
}

async function spawnNotificationTerminal(client: SoloNotificationMcpClient): Promise<number> {
	const result = await client.callTool("spawn_process", {
		kind: "terminal",
		name: NOTIFICATION_TERMINAL_NAME,
	});
	if (result.isError) throw new Error(`spawn_process failed: ${errorText(result)}`);
	const data = extractToolJson<{ process_id?: number; id?: number }>(result);
	const processId = typeof data?.process_id === "number" ? data.process_id : data?.id;
	if (typeof processId !== "number") {
		throw new Error(`spawn_process did not return process_id: ${JSON.stringify(data)}`);
	}
	return processId;
}

async function processExists(
	client: SoloNotificationMcpClient,
	processId: number,
): Promise<boolean> {
	try {
		const result = await client.callTool("get_process_status", { process_id: processId });
		return result.isError !== true;
	} catch {
		return false;
	}
}

export function summarizeSubagentNotifications(notifications: SoloSubagentNotification[]): {
	title: string;
	body: string;
} {
	if (notifications.length === 1) {
		const [item] = notifications;
		const agent = item!.agent ? ` (${item!.agent})` : "";
		const state = item!.kind === "interactive-ready" ? "is ready" : "finished";
		return {
			title: "Solo agent ready",
			body: `${item!.name}${agent} ${state} in Solo #${item!.processId}. Pi is waiting for input.`,
		};
	}

	return {
		title: "Solo agents ready",
		body: `${notifications.length} Solo subagents finished. Pi is waiting for input.`,
	};
}

function formatMode(mode: SoloNotificationMode): string {
	if (mode === "off") return "off";
	if (mode === "subagent") return "subagent completions";
	if (mode === "agent-end") return "every agent_end";
	return "subagent completions + every other agent_end";
}

function parseNotificationMethod(value: string | undefined): TerminalNotificationMethod | null {
	if (!value) return null;
	if (["solo", "terminal", "solo-terminal"].includes(value)) return "solo-terminal";
	if (value === "osc777" || value === "osc99" || value === "osc9" || value === "macos")
		return value;
	return null;
}

function usage(): string {
	return [
		"Usage: /solo-notify [status|test [solo-terminal|macos|osc777|osc9|osc99]|off|subagent|agent-end|all]",
		'Persistent setting: add `{ "piSolo": { "notifications": "subagent" } }` to ~/.pi/agent/settings.json or .pi/settings.json.',
		"Env override: PI_SOLO_NOTIFY=off|subagent|agent-end|all.",
	].join("\n");
}

export function initSoloNotifications(
	pi: ExtensionAPI,
	deps?: { client?: SoloNotificationMcpClient; isClientReady?: () => boolean },
): SoloNotifications {
	let mode: SoloNotificationMode = readConfiguredSoloNotificationMode(process.cwd());
	let runtimeOverride = false;
	let pendingSubagents: SoloSubagentNotification[] = [];
	let notificationProcessId: number | undefined;

	const closeNotificationTerminal = async () => {
		if (notificationProcessId == null || !deps?.client) return;
		const processId = notificationProcessId;
		notificationProcessId = undefined;
		try {
			await deps.client.callTool("close_process", { process_id: processId });
		} catch {
			// Best-effort cleanup. The process may already have been closed by the user.
		}
	};

	const ensureNotificationTerminal = async (): Promise<number> => {
		if (!deps?.client || deps.isClientReady?.() === false) {
			throw new Error("Solo MCP is not ready; cannot create Solo notification terminal");
		}
		if (
			notificationProcessId != null &&
			(await processExists(deps.client, notificationProcessId))
		) {
			return notificationProcessId;
		}
		notificationProcessId = await spawnNotificationTerminal(deps.client);
		return notificationProcessId;
	};

	const notify = async (
		title: string,
		body: string,
		forcedMethod?: TerminalNotificationMethod,
	): Promise<SoloNotificationResult> => {
		if (!forcedMethod || forcedMethod === "solo-terminal") {
			try {
				const processId = await ensureNotificationTerminal();
				const result = await deps!.client!.callTool("send_input", {
					process_id: processId,
					input: buildSoloTerminalNotificationCommand(title, body),
					wait_ms: 500,
				});
				if (result.isError)
					return { ok: false, method: "solo-terminal", processId, error: errorText(result) };
				return { ok: true, method: "solo-terminal", processId };
			} catch (err) {
				return {
					ok: false,
					method: "solo-terminal",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
		return sendLocalNotification(title, body, forcedMethod);
	};

	const controller: SoloNotifications = {
		getMode: () => mode,
		setMode(nextMode) {
			mode = nextMode;
			runtimeOverride = true;
		},
		queueSubagentReady(notification) {
			pendingSubagents.push(notification);
		},
		notify,
	};

	pi.on("session_start", (_event, ctx) => {
		if (!runtimeOverride) mode = readConfiguredSoloNotificationMode(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		pendingSubagents = [];
		await closeNotificationTerminal();
	});

	pi.on("agent_end", async (_event, _ctx) => {
		const subagents = pendingSubagents;
		pendingSubagents = [];

		if (subagents.length > 0 && notificationModeIncludes(mode, "subagent")) {
			const summary = summarizeSubagentNotifications(subagents);
			await notify(summary.title, summary.body);
			return;
		}

		if (notificationModeIncludes(mode, "agent-end")) {
			await notify("Pi ready", "The agent finished and is waiting for input.");
		}
	});

	pi.registerCommand("solo-notify", {
		description:
			"Configure/test Solo desktop notifications: /solo-notify [off|subagent|agent-end|all|test]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command = "", methodArg] = trimmed.toLowerCase().split(/\s+/, 2);
			const normalized = command;

			if (!trimmed || normalized === "status") {
				ctx.ui.notify(`Solo notifications: ${formatMode(mode)}\n${usage()}`, "info");
				return;
			}

			if (normalized === "test") {
				const forcedMethod = parseNotificationMethod(methodArg);
				const result = await notify(
					"Solo notification test",
					"Pi Solo notifications are working. The agent is waiting for input.",
					forcedMethod ?? undefined,
				);
				const processText = result.processId != null ? ` through Solo #${result.processId}` : "";
				ctx.ui.notify(
					result.ok
						? `Sent Solo notification via ${result.method}${processText}.`
						: `Solo notification failed via ${result.method}: ${result.error}`,
					result.ok ? "info" : "warning",
				);
				return;
			}

			const nextMode = parseSoloNotificationMode(trimmed);
			if (!nextMode) {
				ctx.ui.notify(usage(), "warning");
				return;
			}

			controller.setMode(nextMode);
			ctx.ui.notify(
				`Solo notifications: ${formatMode(mode)} (runtime only; use piSolo.notifications to persist).`,
				"info",
			);
		},
	});

	return controller;
}
