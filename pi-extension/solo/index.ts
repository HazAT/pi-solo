/**
 * Solo — native integration between Pi and Solo (soloterm.com).
 *
 * Spawns Solo's bundled MCP helper as a long-lived subprocess and speaks
 * JSON-RPC over stdio. High-frequency Solo MCP tools are registered as
 * first-class Pi tools, while lower-frequency catalog tools remain
 * discoverable and callable through the `solo_tool` gateway.
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

import { installSoloHeader, setSoloHeaderStatus } from "./header.ts";
import { applySubagentModelOverride, initSoloSubagents } from "./subagents/index.ts";

// -------------------------------------------------------------------------
// Configuration

const DEFAULT_HELPER = "/Applications/Solo.app/Contents/MacOS/mcp";
const HELPER_PATH = process.env.SOLO_MCP_HELPER ?? DEFAULT_HELPER;
const APP_DATA_DIR = process.env.SOLOTERM_APP_DATA_DIR ?? join(homedir(), ".config", "soloterm");
const SOLO_PROCESS_ID = process.env.SOLO_PROCESS_ID;
const DISABLED = process.env.PI_SOLO_DISABLED === "1";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "pi-solo-extension";
const CLIENT_VERSION = "1.0.0";

export type SoloToolSurfaceProfile = "core" | "full" | "minimal";
export type SoloToolExposure = "direct" | "gateway";

export function parseToolSurfaceProfile(value: string | undefined): SoloToolSurfaceProfile {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "full" || normalized === "minimal" || normalized === "core") {
		return normalized;
	}
	return "core";
}

const TOOL_SURFACE_PROFILE = parseToolSurfaceProfile(process.env.PI_SOLO_TOOL_SURFACE);

const CORE_DIRECT_MCP_TOOLS = new Set([
	"scratchpad_write",
	"scratchpad_read",
	"scratchpad_list",
	"todo_create",
	"todo_list",
	"todo_update",
	"todo_complete",
]);

export function getMcpToolExposure(
	name: string,
	profile: SoloToolSurfaceProfile = TOOL_SURFACE_PROFILE,
): SoloToolExposure {
	if (profile === "full") return "direct";
	if (profile === "minimal") return "gateway";
	return CORE_DIRECT_MCP_TOOLS.has(name) ? "direct" : "gateway";
}

export function getSoloToolCategory(name: string): string {
	if (name.startsWith("todo_")) return "todos";
	if (name.startsWith("scratchpad_")) return "scratchpads";
	if (name.startsWith("lock_")) return "locks";
	if (name.startsWith("timer_")) return "timers";
	if (name.startsWith("kv_")) return "kv";
	if (
		name === "whoami" ||
		name === "identify_session" ||
		name === "bind_session_process" ||
		name === "list_projects"
	)
		return "session";
	if (name === "select_project" || name === "register_agent") return "session";
	if (
		name === "get_project" ||
		name === "create_project" ||
		name === "rename_project" ||
		name === "delete_project"
	)
		return "projects";
	if (name === "get_project_status" || name === "get_project_stats") return "inspection";
	if (name === "help" || name === "setup_agent_integration") return "docs";
	if (/service|port|wait_for_bound_port/.test(name)) return "readiness";
	if (
		/process|^spawn_|^send_input$|agent_tool|output|terminal_perf|_all_commands$/.test(name) ||
		name === "search_raw_output" ||
		name === "search_output"
	) {
		return "processes";
	}
	return "misc";
}

// Idle window after which we close the helper subprocess so Solo's sidebar
// stops showing it as a child of this Pi. Bursts of MCP calls reuse one warm
// helper; quiet periods cost zero subprocesses.
const HELPER_IDLE_CLOSE_MS = 5_000;

/**
 * Create a function that serializes async work onto a single promise chain.
 * Each call to the returned function waits for any previously-queued work to
 * settle (resolved or rejected) before its own `fn` runs. Errors from one
 * call do not poison subsequent calls.
 *
 * Used to keep one Solo MCP `tools/call` in flight at a time — the helper
 * has crashed (exit 1) when two large requests landed in parallel, e.g. two
 * back-to-back `todo_create` calls.
 */
export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

/**
 * Apply pi-solo's per-tool argument defaults before forwarding to Solo.
 *
 * Solo's `scratchpad_read` silently downgrades to a headings-only outline
 * for “large” scratchpads when `mode` is omitted — the contract claims a
 * hint is included but the response payload does not actually carry one,
 * which has wasted real planner sessions chasing “my write didn't save”.
 * For pi's direct exposure we default `mode` to `"full"` so the obvious
 * read returns the full body. Callers that want the outline or a slice
 * can still pass `mode` (`headings`, `section`, `content`) or
 * `offset`/`limit` explicitly.
 */
export function applyDirectToolDefaults(name: string, args: unknown): unknown {
	if (name !== "scratchpad_read") return args;
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	if (record.mode != null && record.mode !== "") return args;
	return { ...record, mode: "full" };
}

/**
 * Per-tool description overrides for the direct ("core") tool surface.
 * Returns the override when present, otherwise `undefined` so the caller
 * can fall back to Solo's catalog description.
 */
export function getDirectToolDescriptionOverride(name: string): string | undefined {
	if (name === "scratchpad_read") {
		return (
			"Read one scratchpad's content, revision, and metadata. Returns the " +
			"FULL body by default — pi-solo overrides Solo's default to avoid " +
			"silent headings-only auto-degradation on large scratchpads. Pass " +
			'`mode="headings"` for a compact outline, `mode="section"` + ' +
			"`section_heading` for one section, or `offset`/`limit` for a line slice."
		);
	}
	return undefined;
}

// Braille spinner shown in the status line while the Solo helper is warming
// up. 80ms feels lively without distracting — matches typical CLI spinners.
const SPINNER_FRAMES = [
	"\u280b",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283c",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280f",
];
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

interface IdentifySessionResult {
	process_id?: string;
	actor?: string;
	project?: { id?: string; name?: string; path?: string };
	[k: string]: unknown;
}

// -------------------------------------------------------------------------
// MCP client over the bundled stdio helper

export class SoloMcpClient {
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
	// Serializes outbound `tools/call` requests. The Solo helper has proved
	// unreliable when two large requests land back-to-back — e.g. two parallel
	// todo_create calls have crashed the helper (exit 1) in the wild. We keep
	// one call in flight at a time; the overhead is a single extra round-trip
	// per call, which is invisible against the existing IPC latency.
	private readonly enqueueCall = createSerialQueue();

	state: "stopped" | "warming" | "ready" | "failed" = "stopped";
	tools: McpToolDef[] = [];
	serverInfo?: McpInitializeResult;
	boundProcessId?: string;
	boundProject?: { name?: string; path?: string };
	lastError?: string;

	private onReady: (client: SoloMcpClient) => void | Promise<void>;
	private onStateChange: () => void;

	constructor(onReady: (client: SoloMcpClient) => void | Promise<void>, onStateChange: () => void) {
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
		if (before !== after) await this.identifySession();
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
				await this.identifySession();
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

	async identifySession(): Promise<void> {
		try {
			const args = SOLO_PROCESS_ID ? { solo_process_id: Number(SOLO_PROCESS_ID) } : {};
			const r = await this.request<McpToolCallResult>("tools/call", {
				name: "identify_session",
				arguments: args,
			});
			const data =
				extractStructured<IdentifySessionResult>(r) ?? extractTextJson<IdentifySessionResult>(r);
			if (data) {
				if (data.process_id) this.boundProcessId = data.process_id;
				if (data.project) this.boundProject = data.project;
			}
		} catch {
			// Non-fatal: identify_session is informational
		}
	}

	async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
		return this.enqueueCall(async () => {
			await this.ensureChild();
			try {
				return await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
			} finally {
				this.touchIdle();
			}
		});
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
export function normalizeInputSchema(schema?: McpToolDef["inputSchema"]): Record<string, unknown> {
	if (!schema || typeof schema !== "object") {
		return { type: "object", properties: {}, additionalProperties: true };
	}
	const normalized = schema as Record<string, unknown>;
	const result: Record<string, unknown> = {
		...normalized,
		type: "object",
		properties: isPlainRecord(normalized.properties) ? normalized.properties : {},
		additionalProperties: normalized.additionalProperties ?? true,
	};
	if (Array.isArray(normalized.required) && (normalized.required as unknown[]).length) {
		result.required = normalized.required;
	} else {
		delete result.required;
	}
	return result;
}

export type SoloToolListInclude = "gateway" | "direct" | "all";

export interface SoloToolCatalogEntry {
	name: string;
	piName: string;
	category: string;
	exposure: SoloToolExposure;
	description: string;
}

export function listSoloCatalogTools(
	tools: Array<{ name: string; description?: string }>,
	options: { query?: string; category?: string; include?: SoloToolListInclude } = {},
	profile: SoloToolSurfaceProfile = TOOL_SURFACE_PROFILE,
): SoloToolCatalogEntry[] {
	const query = options.query?.trim().toLowerCase();
	const category = options.category?.trim().toLowerCase();
	const include = options.include ?? "gateway";

	return tools
		.map((tool) => {
			const description = firstLine(tool.description ?? `Solo MCP tool: ${tool.name}`);
			return {
				name: tool.name,
				piName: tool.name,
				category: getSoloToolCategory(tool.name),
				exposure: getMcpToolExposure(tool.name, profile),
				description,
			};
		})
		.filter((entry) => include === "all" || entry.exposure === include)
		.filter((entry) => !category || entry.category === category)
		.filter(
			(entry) =>
				!query ||
				entry.name.toLowerCase().includes(query) ||
				entry.piName.toLowerCase().includes(query) ||
				entry.category.toLowerCase().includes(query) ||
				entry.description.toLowerCase().includes(query),
		);
}

function summarizeCatalogExposure(
	tools: Array<{ name: string }>,
	profile: SoloToolSurfaceProfile = TOOL_SURFACE_PROFILE,
): { direct: number; gateway: number } {
	let direct = 0;
	let gateway = 0;
	for (const tool of tools) {
		if (getMcpToolExposure(tool.name, profile) === "direct") direct += 1;
		else gateway += 1;
	}
	return { direct, gateway };
}

function formatCatalogCounts(tools: Array<{ name: string }>): string {
	const counts = summarizeCatalogExposure(tools);
	return `${tools.length} catalog (${counts.direct} direct, ${counts.gateway} via solo_tool, profile=${TOOL_SURFACE_PROFILE})`;
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
	lines.push(`MCP tools: ${formatCatalogCounts(client.tools)}`);
	lines.push("Direct extras: solo_tool, subagent, subagent_interrupt, subagents_list");
	const groups = summarizeToolGroups(client.tools);
	if (groups) lines.push(`Groups: ${groups}`);
	if (client.boundProcessId) {
		lines.push(`Bound process: ${client.boundProcessId}`);
	}
	if (client.boundProject) {
		lines.push(`Project: ${client.boundProject.name ?? "?"} (${client.boundProject.path ?? "?"})`);
	}
	return lines.join("\n");
}

const SoloToolGatewayParams = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["list", "schema", "call"],
			description:
				"Gateway action: list hidden/direct catalog tools, inspect a schema, or call a Solo MCP tool.",
		},
		query: {
			type: "string",
			description: "Optional name/category/description filter for action=list.",
		},
		category: { type: "string", description: "Optional category filter for action=list." },
		include: {
			type: "string",
			enum: ["gateway", "direct", "all"],
			description: "Which exposure bucket to list. Defaults to gateway.",
		},
		name: {
			type: "string",
			description: "Solo MCP tool name for schema/call.",
		},
		arguments: {
			type: "object",
			description: "Arguments to pass to the Solo MCP tool for action=call.",
			additionalProperties: true,
		},
		reason: {
			type: "string",
			description: "Required for state-changing or destructive gateway calls.",
		},
	},
	required: ["action"],
	additionalProperties: false,
};

type SoloToolGatewayArgs = {
	action?: "list" | "schema" | "call";
	query?: string;
	category?: string;
	include?: SoloToolListInclude;
	name?: string;
	arguments?: unknown;
	reason?: string;
};

function resolveCatalogTool(tools: McpToolDef[], requested: unknown): McpToolDef | undefined {
	if (typeof requested !== "string") return undefined;
	const trimmed = requested.trim();
	if (!trimmed) return undefined;
	return tools.find((tool) => tool.name === trimmed);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function gatewayCallRequiresReason(name: string): boolean {
	return !(
		name.startsWith("list_") ||
		name.endsWith("_list") ||
		name.startsWith("get_") ||
		name.startsWith("search_") ||
		name.startsWith("wait_for_") ||
		name === "help" ||
		name === "whoami" ||
		name === "identify_session" ||
		name === "scratchpad_read" ||
		name === "scratchpad_find" ||
		name === "scratchpad_tail" ||
		name === "todo_get" ||
		name === "lock_status" ||
		name === "services_list"
	);
}

function gatewayError(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details,
	};
}

function registerSoloToolGateway(pi: ExtensionAPI, client: SoloMcpClient) {
	pi.registerTool({
		name: "solo_tool",
		label: "Solo Tool Gateway",
		description:
			"Gateway for Solo MCP catalog tools that are not exposed directly. " +
			"Use action=list to discover tools, action=schema to inspect inputs, and action=call to invoke a Solo MCP tool.",
		promptSnippet:
			"List, inspect, or call Solo MCP catalog tools hidden from the direct tool surface.",
		parameters: SoloToolGatewayParams as any,
		async execute(_toolCallId: string, params: SoloToolGatewayArgs = {}) {
			if (!client.isReady()) {
				return gatewayError(
					client.isMcpDisabled()
						? "Solo MCP is disabled in Solo settings (Integrations → MCP). Re-enable it and run /solo-reconnect."
						: `Solo MCP not ready (state=${client.state}${client.lastError ? `: ${client.lastError}` : ""}).`,
					{ state: client.state, error: client.lastError },
				);
			}

			if (params.action !== "list" && params.action !== "schema" && params.action !== "call") {
				return gatewayError(`Invalid solo_tool action: ${String(params.action)}`, {
					action: params.action,
				});
			}

			if (params.action === "list") {
				const include = params.include ?? "gateway";
				if (include !== "gateway" && include !== "direct" && include !== "all") {
					return gatewayError(`Invalid include value: ${String(params.include)}`, {
						action: "list",
					});
				}
				const tools = listSoloCatalogTools(
					client.tools,
					{ query: params.query, category: params.category, include },
					TOOL_SURFACE_PROFILE,
				);
				const lines = tools.map(
					(tool) => `• ${tool.piName} (${tool.category}, ${tool.exposure}) — ${tool.description}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: lines.length
								? lines.join("\n")
								: `No Solo MCP tools matched include=${include}.`,
						},
					],
					details: {
						action: "list",
						profile: TOOL_SURFACE_PROFILE,
						include,
						query: params.query,
						category: params.category,
						tools,
					},
				};
			}

			const tool = resolveCatalogTool(client.tools, params.name);
			if (!tool) {
				return gatewayError(`Unknown Solo MCP tool: ${String(params.name ?? "")}`, {
					action: params.action,
					name: params.name,
				});
			}

			const exposure = getMcpToolExposure(tool.name);
			const category = getSoloToolCategory(tool.name);
			const schema = normalizeInputSchema(tool.inputSchema);
			const baseDetails = {
				mcpTool: tool.name,
				piTool: tool.name,
				exposure,
				category,
				profile: TOOL_SURFACE_PROFILE,
			};

			if (params.action === "schema") {
				const payload = {
					...baseDetails,
					description: tool.description ?? `Solo MCP tool: ${tool.name}`,
					inputSchema: schema,
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
					details: payload,
				};
			}

			if (gatewayCallRequiresReason(tool.name) && !params.reason?.trim()) {
				return gatewayError(
					`solo_tool call to ${tool.name} requires a non-empty reason because it can change Solo state.`,
					baseDetails,
				);
			}

			if (params.arguments != null && !isPlainRecord(params.arguments)) {
				return gatewayError(
					"solo_tool call arguments must be an object when provided.",
					baseDetails,
				);
			}

			try {
				const callArgs = params.arguments ?? {};
				const result = await client.callTool(tool.name, callArgs);
				const details: any = {
					...baseDetails,
					action: "call",
					structuredContent: result.structuredContent,
				};

				if (!result.isError && SHORTCUT_TOOLS.has(tool.name)) {
					const data: any = extractStructuredOrText(result);
					const processId =
						typeof data?.process_id === "number"
							? data.process_id
							: typeof data?.id === "number"
								? data.id
								: undefined;
					const projectId = data?.project_id ?? (callArgs as any).project_id ?? undefined;
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
				return gatewayError(
					`Solo tool call failed: ${err instanceof Error ? err.message : String(err)}`,
					baseDetails,
				);
			}
		},
		renderCall(args: ToolArgs, theme: any) {
			const action = typeof args.action === "string" ? args.action : "?";
			const name = typeof args.name === "string" && args.name ? ` ${args.name}` : "";
			let text =
				theme.fg("accent", "○") +
				" " +
				theme.fg("toolTitle", theme.bold("solo_tool")) +
				theme.fg("accent", ` ${action}${name}`);
			if (typeof args.reason === "string" && args.reason.trim()) {
				text += theme.fg("dim", ` — ${firstLine(args.reason, 80)}`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result: ToolResult, _opts: { isPartial?: boolean }, theme: any) {
			if (result.isError) {
				return new Text(
					theme.fg("error", `✘ solo_tool: ${firstLine(result.content[0]?.text, 120)}`),
					0,
					0,
				);
			}
			const details = result.details as any;
			const count = Array.isArray(details?.tools) ? ` · ${details.tools.length} tools` : "";
			const subject = details?.mcpTool ?? details?.action ?? "ok";
			return new Text(theme.fg("success", "✓") + " " + theme.fg("dim", `${subject}${count}`), 0, 0);
		},
	});
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
			if (getMcpToolExposure(tool.name) !== "direct") continue;
			const piName = tool.name;
			if (registered.has(piName)) continue;
			registered.add(piName);

			const parameters = normalizeInputSchema(tool.inputSchema);
			const description = (
				getDirectToolDescriptionOverride(tool.name) ??
				tool.description ??
				`Solo MCP tool: ${tool.name}`
			).trim();

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
									text: client.isMcpDisabled()
										? "Solo MCP is disabled in Solo settings (Integrations → MCP). Re-enable it and run /solo-reconnect."
										: `Solo MCP not ready (state=${client.state}${client.lastError ? `: ${client.lastError}` : ""}).`,
								},
							],
							isError: true,
							details: { state: client.state, error: client.lastError },
						};
					}
					try {
						const callArgs = applyDirectToolDefaults(tool.name, args ?? {});
						const result = await client.callTool(tool.name, callArgs);
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
							const projectId = data?.project_id ?? (callArgs as any)?.project_id ?? undefined;
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
			uiCtx.ui.notify(`Solo: ${formatCatalogCounts(client.tools)} now available`, "info");
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
			const counts = summarizeCatalogExposure(client.tools);
			tag = theme.fg("dim", `solo (${counts.direct} direct/${counts.gateway} gw)`);
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
			if (c.isMcpDisabled()) {
				setSoloHeaderStatus({ kind: "disabled" });
			} else {
				const counts = summarizeCatalogExposure(c.tools);
				setSoloHeaderStatus({
					kind: "connected",
					total: c.tools.length,
					direct: counts.direct,
					gateway: counts.gateway,
					profile: TOOL_SURFACE_PROFILE,
				});
			}
			syncSpinner();
			pushStatus();
		},
		() => {
			if (client.state === "warming") setSoloHeaderStatus({ kind: "warming" });
			else if (client.state === "failed")
				setSoloHeaderStatus({ kind: "error", message: client.lastError ?? "unknown" });
			syncSpinner();
			pushStatus();
		},
	);

	registerSoloToolGateway(pi, client);

	// Hook up the Solo-native subagent module. We pass the live SoloMcpClient
	// in so subagents can call spawn_process / send_input / scratchpad_write
	// without re-warming a second helper. Subagents are tool-gated on PI_DENY_TOOLS
	// internally so spawning: false agents still get their tools hidden.
	initSoloSubagents(pi, {
		client,
		isClientReady: () => client.isReady() && !client.isMcpDisabled(),
	});

	// --- Lifecycle ----------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		uiCtx = ctx;
		installSoloHeader(ctx, pi);
		await client.start();

		// If this Pi was launched as a Solo subagent (parent set the surface
		// name to `[<agent>] <display>`), pull the agent's `model` / `thinking`
		// out of its `.md` frontmatter and apply them before the first user
		// turn runs. Only honor on initial startup so resumed/forked sessions
		// keep whatever model the user/last session chose.
		if (SOLO_PROCESS_ID && event.reason === "startup" && client.isReady()) {
			try {
				const override = await applySubagentModelOverride(pi, ctx, client);
				if (override.applied && uiCtx?.hasUI) {
					const parts: string[] = [];
					if (override.model) parts.push(`model=${override.model}`);
					if (override.thinking) parts.push(`thinking=${override.thinking}`);
					uiCtx.ui.notify(`Subagent override: ${override.agent} → ${parts.join(", ")}`, "info");
				}
			} catch (err) {
				// Non-fatal: a failed override just means the default model is used.
				if (uiCtx?.hasUI) {
					uiCtx.ui.notify(
						`Subagent model override failed: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			}
		}
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
		description: "List Solo MCP catalog tools and their Pi exposure",
		handler: async (_args, ctx) => {
			if (!client.tools.length) {
				ctx.ui.notify("No Solo MCP tools discovered.", "warning");
				return;
			}
			const tools = listSoloCatalogTools(client.tools, { include: "all" });
			const lines = tools
				.map((t) => `• ${t.piName} [${t.exposure}/${t.category}] — ${t.description}`)
				.join("\n");
			ctx.ui.notify(`Solo MCP tools (${formatCatalogCounts(client.tools)}):\n${lines}`, "info");
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
						? `Solo tools refreshed — ${formatCatalogCounts(client.tools)}`
						: `Solo tools unchanged (${formatCatalogCounts(client.tools)})`,
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

	pi.registerCommand("solo-identify", {
		description: "Refresh this session's Solo identity (process and project binding)",
		handler: async (_args, ctx) => {
			if (!client.isReady()) {
				ctx.ui.notify("Solo not ready — run /solo-reconnect first.", "warning");
				return;
			}
			try {
				await client.identifySession();
				const pid = client.boundProcessId ?? "none";
				const proj = client.boundProject ?? "none";
				ctx.ui.notify(`Solo identity refreshed — process: ${pid}, project: ${proj}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Identify failed: ${err instanceof Error ? err.message : String(err)}`,
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
export const SHORTCUT_TOOLS = new Set([
	"spawn_process",
	"spawn_agent",
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
	if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
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
	if (name.startsWith("spawn_")) return "\u25b8"; // ▸ create/spawn
	if (/^close_|^delete|_delete$|^stop_/.test(name)) return "\u2718"; // ✘ destructive
	if (name.startsWith("send_input")) return "\u23f5"; // ⏵ send
	if (/^restart|reload|refresh|wait_for/.test(name)) return "\u21bb"; // ↻ restart
	if (name.startsWith("start_")) return "\u25b6"; // ▶ start
	if (/^list_|_list$|^get_|^search_|^whoami|^lock_status/.test(name)) return "\u25cb"; // ○ read
	if (
		/_write$|_update|_create|_rename|_add_|_remove_|_set|_tag|_complete|_archive|_transfer|_load|_save|_clear|register_/.test(
			name,
		)
	)
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
				theme.fg("accent", marker) + " " + theme.fg("toolTitle", theme.bold(`solo ${mcpName}`));

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
			if (typeof args.lease_ttl_seconds === "number") hints.push(`ttl=${args.lease_ttl_seconds}s`);
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
				} else if (typeof d.todo_id === "number" && typeof d.completed === "boolean") {
					summary = `todo #${d.todo_id} \u00b7 ${d.completed ? "completed" : "reopened"}`;
				}
				// list responses
				else if (Array.isArray(d)) {
					summary = `${d.length} items`;
				} else if (Array.isArray(d.scratchpads)) summary = `${d.scratchpads.length} scratchpads`;
				else if (Array.isArray(d.todos)) summary = `${d.todos.length} todos`;
				else if (Array.isArray(d.processes)) summary = `${d.processes.length} processes`;
				else if (Array.isArray(d.tools)) summary = `${d.tools.length} tools`;
				else if (Array.isArray(d.timers)) summary = `${d.timers.length} timers`;
				else if (Array.isArray(d.tags)) summary = `${d.tags.length} tags`;
				else if (Array.isArray(d.matches)) summary = `${d.matches.length} matches`;
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
					if (d.released != null)
						summary = `${d.lock_key} \u00b7 ${d.released ? "released" : "not owned"}`;
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
