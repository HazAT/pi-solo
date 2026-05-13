/**
 * Solo — native integration between Pi and Solo (soloterm.com).
 *
 * Spawns Solo's bundled MCP helper as a long-lived subprocess and speaks
 * JSON-RPC over stdio. Every Solo MCP tool is registered as a first-class
 * Pi tool (solo_spawn_process, solo_todo_create, solo_scratchpad_write,
 * solo_timer_set, etc.) so the LLM can call them natively without going
 * through a generic mcp() wrapper.
 *
 * Auto-binds to SOLO_PROCESS_ID when Pi is launched inside a Solo agent.
 * Auto-reconnects on helper crash. No-ops cleanly when Solo isn't running
 * or MCP is disabled in Solo settings.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

// -------------------------------------------------------------------------
// Configuration

const DEFAULT_HELPER = "/Applications/Solo.app/Contents/MacOS/mcp";
const HELPER_PATH = process.env.SOLO_MCP_HELPER ?? DEFAULT_HELPER;
const APP_DATA_DIR =
	process.env.SOLOTERM_APP_DATA_DIR ?? join(homedir(), ".config", "soloterm");
const SOLO_PROCESS_ID = process.env.SOLO_PROCESS_ID;
const DISABLED = process.env.PI_SOLO_DISABLED === "1";

const TOOL_PREFIX = "solo_";
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "pi-solo-extension";
const CLIENT_VERSION = "1.0.0";

// When MCP is reachable but disabled in Solo, retry tools/list this often.
const DISABLED_RETRY_MS = 30_000;
// Idle window after which we close the helper subprocess so Solo's sidebar
// stops showing it as a child of this Pi. Bursts of MCP calls reuse one warm
// helper; quiet periods cost zero subprocesses.
const HELPER_IDLE_CLOSE_MS = 5_000;

// Braille spinner shown in the status line while the Solo helper is warming
// up. 80ms feels lively without distracting — matches typical CLI spinners.
const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const SPINNER_INTERVAL_MS = 80;

// -------------------------------------------------------------------------
// JSON-RPC types

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcSuccess<T = unknown> {
	jsonrpc: "2.0";
	id: number;
	result: T;
}

interface JsonRpcError {
	jsonrpc: "2.0";
	id: number;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

interface McpContentItem {
	type: "text" | "image" | "resource" | string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; text?: string; mimeType?: string };
}

interface McpToolCallResult {
	content?: McpContentItem[];
	isError?: boolean;
	structuredContent?: unknown;
}

interface McpInitializeResult {
	protocolVersion?: string;
	serverInfo?: { name?: string; version?: string };
	instructions?: string;
	capabilities?: unknown;
}

interface WhoamiResult {
	process_id?: string;
	actor?: string;
	project?: { id?: string; name?: string; path?: string };
	[k: string]: unknown;
}

// -------------------------------------------------------------------------
// Pending tool registration

interface PendingTool {
	mcpName: string;
	pi: any; // ExtensionAPI's registerTool definition (loosely typed)
}

// -------------------------------------------------------------------------
// MCP client over the bundled stdio helper

class SoloMcpClient {
	private child?: ChildProcessByStdio<Writable, Readable, Readable>;
	private buf = "";
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	private stopped = false;
	private idleTimer?: NodeJS.Timeout;
	private ensurePromise?: Promise<void>;

	state: "stopped" | "warming" | "ready" | "failed" = "stopped";
	tools: McpToolDef[] = [];
	serverInfo?: McpInitializeResult;
	boundProcessId?: string;
	boundProject?: { name?: string; path?: string };
	lastError?: string;

	private onReady: (client: SoloMcpClient) => void | Promise<void>;
	private onStateChange: () => void;

	constructor(
		onReady: (client: SoloMcpClient) => void | Promise<void>,
		onStateChange: () => void,
	) {
		this.onReady = onReady;
		this.onStateChange = onStateChange;
	}

	/**
	 * Initial startup probe: spawn helper, fetch tool catalog and project
	 * binding, then let the idle timer close the helper so Solo's sidebar
	 * doesn't show a persistent child process.
	 */
	async start(): Promise<void> {
		if (this.stopped) return;
		if (!existsSync(HELPER_PATH)) {
			this.state = "failed";
			this.lastError = `Solo MCP helper not found at ${HELPER_PATH}`;
			this.onStateChange();
			return;
		}
		try {
			await this.ensureChild();
			await this.onReady(this);
			this.touchIdle();
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			this.state = "failed";
			this.onStateChange();
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.killChild();
	}

	/**
	 * Re-query Solo for its current tool list. Returns true when a previously
	 * empty/disabled state now reports tools (i.e. the user enabled MCP).
	 */
	async refresh(): Promise<{ changed: boolean }> {
		if (this.stopped) return { changed: false };
		try {
			await this.ensureChild();
		} catch {
			return { changed: false };
		}
		const before = this.tools.map((t) => t.name).join(",");
		await this.refreshTools();
		const after = this.tools.map((t) => t.name).join(",");
		if (before !== after) await this.tryWhoami();
		this.touchIdle();
		return { changed: before !== after };
	}

	async restart(): Promise<void> {
		this.killChild();
		this.stopped = false;
		await this.start();
	}

	/**
	 * Ensure a warm helper subprocess is up. Multiple concurrent callers
	 * share one in-flight init. Cheap when already warm.
	 */
	private async ensureChild(): Promise<void> {
		if (this.stopped) throw new Error("Solo MCP client stopped");
		if (this.child) return;
		if (this.ensurePromise) return this.ensurePromise;

		this.state = "warming";
		this.onStateChange();

		this.ensurePromise = (async () => {
			try {
				this.spawnChild();
				await this.handshake();
				await this.refreshTools();
				if (SOLO_PROCESS_ID) await this.tryBindProcess(SOLO_PROCESS_ID);
				if (!this.boundProject) await this.tryWhoami();
				this.state = "ready";
				this.lastError = undefined;
				this.onStateChange();
			} catch (err) {
				this.killChild();
				this.lastError = err instanceof Error ? err.message : String(err);
				this.state = "failed";
				this.onStateChange();
				throw err;
			} finally {
				this.ensurePromise = undefined;
			}
		})();
		return this.ensurePromise;
	}

	private touchIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.stopped) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending.size > 0) {
				// A request landed concurrently — don't close.
				this.touchIdle();
				return;
			}
			this.killChild();
			if (!this.stopped) {
				this.state = "stopped";
				this.onStateChange();
			}
		}, HELPER_IDLE_CLOSE_MS);
	}

	private spawnChild() {
		const env = { ...process.env };
		env.SOLOTERM_APP_DATA_DIR = APP_DATA_DIR;
		if (SOLO_PROCESS_ID) env.SOLO_PROCESS_ID = SOLO_PROCESS_ID;

		const child = spawn(HELPER_PATH, [], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		}) as ChildProcessByStdio<Writable, Readable, Readable>;

		this.child = child;
		this.buf = "";

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		child.stderr.setEncoding("utf8");
		// Solo helper occasionally logs to stderr; keep silent unless debugging.
		child.stderr.on("data", () => {});

		child.on("exit", (code, signal) => {
			this.failPending(
				new Error(`Solo helper exited (code=${code ?? "?"} signal=${signal ?? "?"})`),
			);
			this.child = undefined;
			if (this.stopped) return;
			// Don't reconnect aggressively — next tool call will re-warm via
			// ensureChild(). This is what makes the helper invisible to Solo.
			if (this.state === "ready") {
				this.state = "stopped";
				this.onStateChange();
			}
		});

		child.on("error", (err) => {
			this.lastError = err.message;
		});
	}

	private killChild() {
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		try {
			child.kill("SIGTERM");
		} catch {}
	}

	private handleStdout(chunk: string) {
		this.buf += chunk;
		while (true) {
			const newline = this.buf.indexOf("\n");
			if (newline === -1) break;
			const line = this.buf.slice(0, newline).trim();
			this.buf = this.buf.slice(newline + 1);
			if (!line) continue;
			let msg: JsonRpcResponse | JsonRpcNotification;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if ("id" in msg && typeof (msg as any).id === "number") {
				this.handleResponse(msg as JsonRpcResponse);
			}
			// We intentionally ignore server-initiated notifications for now.
		}
	}

	private handleResponse(msg: JsonRpcResponse) {
		const handler = this.pending.get(msg.id);
		if (!handler) return;
		this.pending.delete(msg.id);
		if ("error" in msg) {
			handler.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
		} else {
			handler.resolve(msg.result);
		}
	}

	private failPending(err: Error) {
		for (const handler of this.pending.values()) handler.reject(err);
		this.pending.clear();
	}

	private async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
		const child = this.child;
		if (!child) throw new Error("Solo MCP helper not running");
		const id = this.nextId++;
		const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Solo MCP request '${method}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			try {
				child.stdin.write(`${JSON.stringify(payload)}\n`);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private async notify(method: string, params?: unknown): Promise<void> {
		const child = this.child;
		if (!child) return;
		const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		try {
			child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// best-effort
		}
	}

	private async handshake(): Promise<void> {
		this.serverInfo = await this.request<McpInitializeResult>("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
		});
		await this.notify("notifications/initialized");
	}

	private async refreshTools(): Promise<void> {
		const result = await this.request<{ tools: McpToolDef[] }>("tools/list");
		this.tools = Array.isArray(result?.tools) ? result.tools : [];
	}

	private async tryBindProcess(processId: string): Promise<void> {
		try {
			await this.request("tools/call", {
				name: "bind_session_process",
				arguments: { process_id: processId },
			});
			this.boundProcessId = processId;
		} catch (err) {
			// Non-fatal: server may not have this tool enabled or processId invalid.
			this.lastError = err instanceof Error ? err.message : String(err);
		}
	}

	private async tryWhoami(): Promise<void> {
		try {
			const r = await this.request<McpToolCallResult>("tools/call", {
				name: "whoami",
				arguments: {},
			});
			const blob = extractStructured<WhoamiResult>(r) ?? extractTextJson<WhoamiResult>(r);
			if (blob) {
				this.boundProcessId = this.boundProcessId ?? blob.process_id;
				this.boundProject = blob.project;
			}
		} catch {
			// ignore — whoami is informational
		}
	}

	async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
		await this.ensureChild();
		try {
			return await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
		} finally {
			this.touchIdle();
		}
	}

	isReady(): boolean {
		// Ready when the helper either is alive or could be re-warmed lazily.
		return !this.stopped && this.state !== "failed" && existsSync(HELPER_PATH);
	}

	isMcpDisabled(): boolean {
		return (
			this.serverInfo?.instructions?.toLowerCase().includes("disabled") === true &&
			this.tools.length === 0
		);
	}
}

// -------------------------------------------------------------------------
// Helpers: MCP content → Pi content

export function mcpContentToPi(items?: McpContentItem[]): Array<{ type: "text"; text: string }> {
	if (!items?.length) return [{ type: "text", text: "(no content)" }];
	const out: Array<{ type: "text"; text: string }> = [];
	for (const item of items) {
		if (item.type === "text" && typeof item.text === "string") {
			out.push({ type: "text", text: item.text });
		} else if (item.type === "image" && item.data) {
			// Pi supports image content but providers vary; surface as a text note.
			out.push({
				type: "text",
				text: `[image content omitted, ${item.mimeType ?? "unknown"} ${item.data.length} bytes base64]`,
			});
		} else if (item.type === "resource" && item.resource) {
			out.push({
				type: "text",
				text: `[resource: ${item.resource.uri ?? "?"}]\n${item.resource.text ?? ""}`,
			});
		} else {
			out.push({ type: "text", text: `[${item.type} content]` });
		}
	}
	return out;
}

export function extractTextJson<T>(r: McpToolCallResult): T | undefined {
	const first = r.content?.find((c) => c.type === "text" && typeof c.text === "string");
	if (!first?.text) return undefined;
	try {
		return JSON.parse(first.text) as T;
	} catch {
		return undefined;
	}
}

export function extractStructured<T>(r: McpToolCallResult): T | undefined {
	return (r.structuredContent as T) ?? undefined;
}

// JSON Schema sanitizer: MCP tools sometimes ship empty/loose schemas. Pi's
// parameter system wants an object schema with at least { type: "object" }.
export function normalizeInputSchema(schema?: McpToolDef["inputSchema"]): {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
} {
	if (!schema || typeof schema !== "object") {
		return { type: "object", properties: {}, additionalProperties: true };
	}
	return {
		type: "object",
		properties: schema.properties ?? {},
		...(schema.required && schema.required.length ? { required: schema.required } : {}),
		additionalProperties: (schema as any).additionalProperties ?? true,
	};
}

// -------------------------------------------------------------------------
// Pretty status text for /solo and ctx.ui

function formatStatus(client: SoloMcpClient): string {
	const lines: string[] = [];
	lines.push(`Solo MCP: ${client.state}`);
	if (client.lastError) lines.push(`Last error: ${client.lastError}`);
	if (client.serverInfo?.serverInfo) {
		const s = client.serverInfo.serverInfo;
		lines.push(`Server: ${s.name ?? "?"} ${s.version ?? ""}`);
	}
	if (client.isMcpDisabled()) {
		lines.push("MCP is disabled in Solo (Settings → Integrations → MCP).");
	}
	lines.push(`Helper: ${HELPER_PATH}`);
	lines.push(`Tools registered: ${client.tools.length}`);
	const groups = summarizeToolGroups(client.tools);
	if (groups) lines.push(`Groups: ${groups}`);
	if (client.boundProcessId) {
		lines.push(`Bound process: ${client.boundProcessId}`);
	} else if (SOLO_PROCESS_ID) {
		lines.push(`Bound process: ${SOLO_PROCESS_ID} (env, not confirmed)`);
	}
	if (client.boundProject) {
		lines.push(`Project: ${client.boundProject.name ?? "?"} (${client.boundProject.path ?? "?"})`);
	}
	return lines.join("\n");
}

// -------------------------------------------------------------------------
// Extension entrypoint

export default function soloExtension(pi: ExtensionAPI) {
	if (DISABLED) return;
	if (!existsSync(HELPER_PATH)) return; // Solo not installed — silent no-op.

	let uiCtx: ExtensionContext | undefined;
	const registered = new Set<string>();

	const registerToolsFromCatalog = (client: SoloMcpClient) => {
		for (const tool of client.tools) {
			const piName = `${TOOL_PREFIX}${tool.name}`;
			if (registered.has(piName)) continue;
			registered.add(piName);

			const parameters = normalizeInputSchema(tool.inputSchema);
			const description = (tool.description ?? `Solo MCP tool: ${tool.name}`).trim();

			const renderers = makeRenderers(tool.name);
			pi.registerTool({
				name: piName,
				label: humanizeToolLabel(tool.name),
				description,
				promptSnippet: description.split("\n")[0]?.slice(0, 180),
				parameters: parameters as any,
				renderCall: renderers.renderCall,
				renderResult: renderers.renderResult,
				async execute(_toolCallId: string, args: unknown) {
					if (!client.isReady()) {
						return {
							content: [
								{
									type: "text" as const,
									text:
										client.isMcpDisabled()
											? "Solo MCP is disabled in Solo settings (Integrations → MCP). Re-enable it and run /solo-reconnect."
											: `Solo MCP not ready (state=${client.state}${client.lastError ? `: ${client.lastError}` : ""}).`,
								},
							],
							isError: true,
							details: { state: client.state, error: client.lastError },
						};
					}
					try {
						const result = await client.callTool(tool.name, args ?? {});
						const details: any = {
							mcpTool: tool.name,
							structuredContent: result.structuredContent,
						};

						// For spawn/start/restart/status, compute a Solo keyboard
						// shortcut hint so the human can jump to the process in one
						// keypress. Failures here are silent — the hint is a bonus.
						if (!result.isError && SHORTCUT_TOOLS.has(tool.name)) {
							const data: any = extractStructuredOrText(result);
							const processId =
								typeof data?.process_id === "number"
									? data.process_id
									: typeof data?.id === "number"
										? data.id
										: undefined;
							const projectId =
								data?.project_id ??
								(args as any)?.project_id ??
								undefined;
							if (processId != null) {
								details.jumpHint = await computeJumpHint(
									client,
									processId,
									typeof projectId === "number" ? projectId : undefined,
								);
							}
						}

						return {
							content: mcpContentToPi(result.content),
							isError: result.isError === true,
							details,
						};
					} catch (err) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Solo tool call failed: ${err instanceof Error ? err.message : String(err)}`,
								},
							],
							isError: true,
							details: { mcpTool: tool.name },
						};
					}
				},
			});
		}
	};

	const onChange = async () => {
		registerToolsFromCatalog(client);
		if (uiCtx?.hasUI) {
			uiCtx.ui.notify(
				`Solo: ${client.tools.length} tool${client.tools.length === 1 ? "" : "s"} now available`,
				"info",
			);
			pushStatus();
		}
	};

	// Animated spinner state. While the helper is warming, a setInterval keeps
	// re-rendering the status line so the user sees a moving indicator instead
	// of a frozen "warming" string. Cleared the moment state leaves "warming".
	let spinnerFrame = 0;
	let spinnerTimer: NodeJS.Timeout | undefined;

	const pushStatus = () => {
		if (!uiCtx?.hasUI) return;
		const theme = uiCtx.ui.theme;
		let tag: string;
		if (client.state === "warming") {
			const dot = theme.fg("accent", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!);
			tag = `${dot} ${theme.fg("dim", "solo: connecting")}`;
		} else if (client.state === "failed") {
			tag = theme.fg("error", "solo: error");
		} else if (client.isMcpDisabled()) {
			tag = theme.fg("warning", "solo: disabled");
		} else if (client.tools.length === 0) {
			tag = theme.fg("dim", "solo: off");
		} else {
			tag = theme.fg("dim", `solo (${summarizeToolGroups(client.tools)})`);
		}
		uiCtx.ui.setStatus("solo", tag);
	};

	const syncSpinner = () => {
		if (client.state === "warming") {
			if (spinnerTimer) return;
			spinnerFrame = 0;
			spinnerTimer = setInterval(() => {
				spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
				pushStatus();
			}, SPINNER_INTERVAL_MS);
			// Don't keep the Node event loop alive just for the spinner.
			spinnerTimer.unref?.();
		} else if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	const client = new SoloMcpClient(
		async (c) => {
			registerToolsFromCatalog(c);
			if (uiCtx?.hasUI) {
				const msg = c.isMcpDisabled()
					? "Solo connected — but MCP is disabled in Solo settings"
					: `Solo connected — ${c.tools.length} tool${c.tools.length === 1 ? "" : "s"} registered`;
				uiCtx.ui.notify(msg, c.isMcpDisabled() ? "warning" : "info");
			}
			syncSpinner();
			pushStatus();
		},
		() => {
			syncSpinner();
			pushStatus();
		},
	);

	// --- Lifecycle ----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		await client.start();
	});

	pi.on("session_shutdown", async () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		client.stop();
	});

	// --- Commands -----------------------------------------------------------

	pi.registerCommand("solo", {
		description: "Show Solo connection status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStatus(client), "info");
		},
	});

	pi.registerCommand("solo-tools", {
		description: "List Solo MCP tools registered in Pi",
		handler: async (_args, ctx) => {
			if (!client.tools.length) {
				ctx.ui.notify("No Solo tools registered.", "warning");
				return;
			}
			const lines = client.tools
				.map((t) => `• ${TOOL_PREFIX}${t.name} — ${(t.description ?? "").split("\n")[0]}`)
				.join("\n");
			ctx.ui.notify(`Solo tools (${client.tools.length}):\n${lines}`, "info");
		},
	});

	pi.registerCommand("solo-reconnect", {
		description: "Restart the Solo MCP helper",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Reconnecting to Solo…", "info");
			await client.restart();
			ctx.ui.notify(formatStatus(client), client.state === "ready" ? "info" : "warning");
		},
	});

	pi.registerCommand("solo-refresh", {
		description: "Re-query Solo for its current MCP tool catalog",
		handler: async (_args, ctx) => {
			if (!client.isReady()) {
				ctx.ui.notify("Solo not ready — run /solo-reconnect first.", "warning");
				return;
			}
			try {
				const { changed } = await client.refresh();
				if (changed) await onChange();
				ctx.ui.notify(
					changed
						? `Solo tools refreshed — ${client.tools.length} total`
						: `Solo tools unchanged (${client.tools.length})`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("solo-bind", {
		description: "Manually bind this Pi session to a Solo process ID",
		handler: async (args, ctx) => {
			const processId = args.trim();
			if (!processId) {
				ctx.ui.notify("Usage: /solo-bind <solo-process-id>", "warning");
				return;
			}
			if (!client.isReady()) {
				ctx.ui.notify("Solo not ready — run /solo-reconnect first.", "warning");
				return;
			}
			try {
				await client.callTool("bind_session_process", { process_id: processId });
				ctx.ui.notify(`Bound to Solo process ${processId}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Bind failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}

// -------------------------------------------------------------------------
// Misc

export function humanizeToolLabel(name: string): string {
	return name
		.split("_")
		.map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
		.join(" ");
}

/**
 * Classify which Solo feature groups are currently exposed. The MCP server
 * only returns tools from enabled groups, so a simple prefix scan is exact:
 * if `kv_*` tools aren't in the catalog, key-value is disabled.
 */
function summarizeToolGroups(tools: McpToolDef[]): string {
	let hasScratchpads = false;
	let hasTodos = false;
	let hasTimers = false;
	let hasKv = false;
	let hasCore = false;
	for (const t of tools) {
		if (t.name.startsWith("scratchpad_")) hasScratchpads = true;
		else if (t.name.startsWith("todo_")) hasTodos = true;
		else if (t.name.startsWith("timer_")) hasTimers = true;
		else if (t.name.startsWith("kv_")) hasKv = true;
		else hasCore = true;
	}
	const extras: string[] = [];
	if (hasTodos) extras.push("todos");
	if (hasScratchpads) extras.push("notes");
	if (hasTimers) extras.push("timers");
	if (hasKv) extras.push("kv");
	if (extras.length === 0) return hasCore ? "core" : "";
	return extras.join("+");
}

// -------------------------------------------------------------------------
// Tool renderers
//
// Solo has ~85 tools. Rather than write 85 renderers, we categorize by
// name pattern and produce a tight one-line summary for both the call and
// the result. Visual language matches pi-interactive-subagents:
//   marker + theme.fg("toolTitle", bold(subject)) + theme.fg("dim", context)
//   result tags via theme.fg("accent"/"success"/"error"/"dim", ...)

type ToolArgs = Record<string, unknown>;
type JumpHint = {
	shortcut: string; // e.g. "⌘5" or "⌥3 · ⌘5" or "⌘E"
	projectName?: string;
	projectIdx?: number;
	processIdx?: number;
	processName?: string;
};
type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: {
		mcpTool?: string;
		structuredContent?: unknown;
		jumpHint?: JumpHint;
	};
};

// Tools whose result is worth augmenting with a Solo keyboard shortcut hint
// so the human can jump to the relevant process in the sidebar with one
// keypress. Cheap extra calls (list_projects + list_processes) on success.
const SHORTCUT_TOOLS = new Set([
	"spawn_process",
	"start_process",
	"restart_process",
	"get_process_status",
]);

// macOS modifier glyphs
const KEY_CMD = "\u2318"; // ⌘
const KEY_OPT = "\u2325"; // ⌥

async function computeJumpHint(
	client: SoloMcpClient,
	processId: number,
	projectIdHint?: number,
): Promise<JumpHint | undefined> {
	try {
		let projectIdx: number | undefined;
		let projectName: string | undefined;
		let effectiveProjectId = projectIdHint;

		// 1. Find project position (Alt+N to switch projects).
		if (effectiveProjectId != null) {
			const projectsResp = await client.callTool("list_projects", {});
			let projects: any = extractStructuredOrText(projectsResp);
			if (projects && !Array.isArray(projects) && Array.isArray(projects.projects))
				projects = projects.projects;
			if (Array.isArray(projects)) {
				const idx = projects.findIndex((p: any) => p?.id === effectiveProjectId);
				if (idx >= 0) {
					projectIdx = idx;
					projectName = projects[idx]?.name;
				}
			}
		}

		// 2. Find process position within its project (Cmd+N to jump).
		const processesResp = await client.callTool(
			"list_processes",
			effectiveProjectId != null ? { project_id: effectiveProjectId } : {},
		);
		let processes: any = extractStructuredOrText(processesResp);
		if (processes && !Array.isArray(processes) && Array.isArray(processes.processes))
			processes = processes.processes;
		if (!Array.isArray(processes)) return undefined;

		const procIdx = processes.findIndex((p: any) => p?.id === processId);
		if (procIdx < 0) return undefined;
		const processName = processes[procIdx]?.name;

		// Assemble shortcut. Solo: ⌥N picks the project, ⌘N picks the process
		// within the *current* project. Use ⌘E as fallback when positional
		// shortcuts run out (Solo's cross-project quick-jump palette).
		const parts: string[] = [];
		if (projectIdx != null && projectIdx >= 0 && projectIdx < 9) {
			parts.push(`${KEY_OPT}${projectIdx + 1}`);
		}
		if (procIdx < 9) {
			parts.push(`${KEY_CMD}${procIdx + 1}`);
		}
		const shortcut = parts.length > 0 ? parts.join(" \u00b7 ") : `${KEY_CMD}E`;

		return { shortcut, projectName, projectIdx, processIdx: procIdx, processName };
	} catch {
		return undefined;
	}
}

function extractStructuredOrText(r: McpToolCallResult): any {
	if (r.structuredContent !== undefined && r.structuredContent !== null)
		return r.structuredContent;
	return extractTextJson<any>(r);
}

export function str(v: unknown, max = 60): string {
	if (v == null) return "";
	const s = String(v);
	return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

export function firstLine(v: unknown, max = 80): string {
	if (v == null) return "";
	const s = String(v);
	const line = s.split("\n").find((l) => l.trim()) ?? "";
	return line.length > max ? line.slice(0, max - 1) + "\u2026" : line;
}

export function lineCount(v: unknown): number {
	if (v == null) return 0;
	return String(v).split("\n").length;
}

// Best-effort: most Solo MCP tools return one text content item whose body
// is a JSON string. Parse it and return the structured object.
function extractJson(result: ToolResult): any | undefined {
	const sc = result.details?.structuredContent;
	if (sc && typeof sc === "object") return sc;
	const first = result.content?.find((c) => c.type === "text" && typeof c.text === "string");
	if (!first?.text) return undefined;
	try {
		return JSON.parse(first.text);
	} catch {
		return undefined;
	}
}

// Identify the "primary subject" of a tool call from its args. Used as the
// bold title in renderCall.
export function pickSubject(name: string, args: ToolArgs): string {
	if (typeof args.process_name === "string" && args.process_name) return args.process_name;
	if (args.process_id != null) return `#${args.process_id}`;
	if (typeof args.name === "string" && args.name) return args.name;
	if (typeof args.title === "string" && args.title) return args.title;
	if (args.todo_id != null) return `todo #${args.todo_id}`;
	if (args.scratchpad_id != null) return `scratchpad #${args.scratchpad_id}`;
	if (args.timer_id != null) return `timer #${args.timer_id}`;
	if (typeof args.lock_key === "string" && args.lock_key) return args.lock_key;
	if (typeof args.key === "string" && args.key) return args.key;
	if (typeof args.pattern === "string" && args.pattern) return `"${args.pattern}"`;
	if (args.project_id != null) return `project #${args.project_id}`;
	return name;
}

export function markerFor(name: string): string {
	if (/^spawn_/.test(name)) return "\u25b8"; // ▸ create/spawn
	if (/^close_|^delete|_delete$|^stop_/.test(name)) return "\u2718"; // ✘ destructive
	if (/^send_input/.test(name)) return "\u23f5"; // ⏵ send
	if (/^restart|reload|refresh|wait_for/.test(name)) return "\u21bb"; // ↻ restart
	if (/^start_/.test(name)) return "\u25b6"; // ▶ start
	if (/^list_|_list$|^get_|^search_|^whoami|^lock_status/.test(name)) return "\u25cb"; // ○ read
	if (/_write$|_update|_create|_rename|_add_|_remove_|_set|_tag|_complete|_archive|_transfer|_load|_save|_clear|register_/.test(name))
		return "\u270e"; // ✎ write
	return "\u00b7"; // · default
}

function makeRenderers(mcpName: string): {
	renderCall: (args: ToolArgs, theme: any) => Text;
	renderResult: (result: ToolResult, opts: { isPartial?: boolean }, theme: any) => Text;
} {
	const marker = markerFor(mcpName);

	return {
		renderCall(args, theme) {
			const subject = pickSubject(mcpName, args);
			let text =
				theme.fg("accent", marker) +
				" " +
				theme.fg("toolTitle", theme.bold(`solo ${mcpName}`));

			if (subject && subject !== mcpName) {
				text += " " + theme.fg("accent", subject);
			}

			// Per-tool context hints
			const hints: string[] = [];
			if (mcpName === "spawn_process" && typeof args.kind === "string") {
				hints.push(String(args.kind));
				if (args.agent_tool_id != null) hints.push(`tool=${args.agent_tool_id}`);
			}
			if (typeof args.body === "string" && args.body) hints.push(`${lineCount(args.body)}L body`);
			if (typeof args.content === "string" && args.content)
				hints.push(`${lineCount(args.content)}L content`);
			if (typeof args.input === "string" && args.input)
				hints.push(`${lineCount(args.input)}L input`);
			if (Array.isArray(args.bytes)) hints.push(`bytes=${(args.bytes as number[]).join(",")}`);
			if (typeof args.priority === "string") hints.push(String(args.priority));
			if (typeof args.status === "string") hints.push(String(args.status));
			if (typeof args.delay_ms === "number") hints.push(`${args.delay_ms}ms`);
			if (typeof args.max_wait_ms === "number") hints.push(`<= ${args.max_wait_ms}ms`);
			if (typeof args.lease_ttl_seconds === "number")
				hints.push(`ttl=${args.lease_ttl_seconds}s`);
			if (Array.isArray(args.tags) && args.tags.length) hints.push(`tags=${args.tags.join(",")}`);
			if (typeof args.wait_ms === "number") hints.push(`wait=${args.wait_ms}ms`);
			if (typeof args.lines === "number") hints.push(`${args.lines}L`);

			if (hints.length) text += theme.fg("dim", ` (${hints.join(", ")})`);

			// Inline body / content preview (one line)
			const body =
				(typeof args.body === "string" && args.body) ||
				(typeof args.content === "string" && args.content) ||
				(typeof args.input === "string" && args.input) ||
				"";
			if (body) {
				const preview = firstLine(body, 90);
				if (preview) text += "\n" + theme.fg("toolOutput", preview);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", `solo ${mcpName}: \u2026`), 0, 0);

			if (result.isError) {
				const msg = firstLine(
					result.content[0]?.type === "text" ? result.content[0].text : "",
					140,
				);
				return new Text(theme.fg("error", `\u2718 ${mcpName}: ${msg}`), 0, 0);
			}

			const data = extractJson(result);

			// Per-shape summaries — covers the common Solo response patterns.
			let summary = "";

			if (data && typeof data === "object") {
				const d = data as Record<string, any>;

				// spawn_process
				if (typeof d.process_id === "number" && typeof d.name === "string") {
					summary = `spawned ${d.name} (#${d.process_id})`;
					const hint = result.details?.jumpHint;
					if (hint?.shortcut) summary += ` \u00b7 ${hint.shortcut} to jump`;
				}
				// scratchpad write/append
				else if (typeof d.scratchpad_id === "number" && d.revision != null) {
					summary = `${d.created ? "created" : "updated"} scratchpad #${d.scratchpad_id} \u00b7 rev ${d.revision}`;
				}
				// scratchpad read
				else if (d.scratchpad && typeof d.scratchpad === "object") {
					const sp = d.scratchpad;
					const body = typeof sp.content === "string" ? sp.content : "";
					summary = `\u201c${str(sp.name, 40)}\u201d \u00b7 ${lineCount(body)}L \u00b7 rev ${sp.revision}`;
				}
				// todo create
				else if (typeof d.todo_id === "number" && d.completed == null) {
					summary = `todo #${d.todo_id}`;
				}
				else if (typeof d.todo_id === "number" && typeof d.completed === "boolean") {
					summary = `todo #${d.todo_id} \u00b7 ${d.completed ? "completed" : "reopened"}`;
				}
				// list responses
				else if (Array.isArray(d)) {
					summary = `${d.length} items`;
				}
				else if (Array.isArray(d.scratchpads)) summary = `${d.scratchpads.length} scratchpads`;
				else if (Array.isArray(d.todos)) summary = `${d.todos.length} todos`;
				else if (Array.isArray(d.processes)) summary = `${d.processes.length} processes`;
				else if (Array.isArray(d.tools)) summary = `${d.tools.length} tools`;
				else if (Array.isArray(d.timers)) summary = `${d.timers.length} timers`;
				else if (Array.isArray(d.tags)) summary = `${d.tags.length} tags`;
				else if (Array.isArray(d.matches))
					summary = `${d.matches.length} matches`;
				// process status / generic
				else if (typeof d.status === "string" && d.id != null) {
					summary = `${d.name ?? `#${d.id}`} \u00b7 ${d.status}`;
					if (d.uptime_seconds != null) summary += ` \u00b7 ${Math.round(d.uptime_seconds)}s`;
					const hint = result.details?.jumpHint;
					if (hint?.shortcut) summary += ` \u00b7 ${hint.shortcut} to jump`;
				}
				// whoami / bind
				else if (typeof d.process_id === "number" && typeof d.project_name === "string") {
					summary = `bound #${d.process_id} \u2192 ${d.project_name}`;
				}
				// send_input
				else if (typeof d.bytesSent === "number") {
					summary = `sent ${d.bytesSent}B${d.appendedEnter ? " + \u23ce" : ""}`;
					if (d.appliedWaitMs) summary += ` \u00b7 waited ${d.appliedWaitMs}ms`;
				}
				// timer set
				else if (typeof d.timer_id === "number") {
					summary = `timer #${d.timer_id} ${d.status ?? "scheduled"}`;
				}
				// locks
				else if (typeof d.lock_key === "string") {
					if (d.released != null) summary = `${d.lock_key} \u00b7 ${d.released ? "released" : "not owned"}`;
					else if (d.acquired != null)
						summary = `${d.lock_key} \u00b7 ${d.acquired ? "acquired" : "busy"}`;
					else summary = d.lock_key;
				}
				// get_process_output
				else if (typeof d.content === "string") summary = `${lineCount(d.content)}L`;
				// fallback: a single readable field
				else if (typeof d.message === "string") summary = d.message;
			}

			// Last-resort fallback: trim the raw text content to one line.
			if (!summary) {
				const raw = result.content?.[0]?.type === "text" ? result.content[0].text! : "";
				summary = firstLine(raw, 100) || "ok";
			}

			return new Text(theme.fg("success", "\u2713") + " " + theme.fg("dim", summary), 0, 0);
		},
	};
}
