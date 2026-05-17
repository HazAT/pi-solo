/**
 * Solo-native subagent orchestration.
 *
 * Subagents run as real Solo agent processes launched via Solo 0.7.1's
 * native `spawn_agent` tool. Per-launch Pi flags (e.g. `--model`, `--thinking`)
 * derived from the agent's frontmatter are passed through `extra_args`.
 * The parent drives the child with one plain-text prompt, schedules Solo's
 * native idle timer, and reads the child's artifact from a Solo scratchpad
 * when the timer wakes the parent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
	type SoloMcpLike,
	closeSurface,
	createAgentSurface,
	getAgentProcessState,
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

	// `model` and `thinking` are converted into Pi CLI `extra_args` at launch
	// time by `buildPiExtraArgs`. The remaining fields are parsed for listing
	// and tolerance only; Solo agent processes do not honor per-spawn
	// tool/session/env customization.
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

// ── Launch args from agent frontmatter ──────────────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

export function parseModelSpec(
	spec: string | undefined,
): { provider: string; modelId: string; thinking?: ThinkingLevel } | null {
	if (!spec) return null;
	const trimmed = spec.trim();
	if (!trimmed) return null;

	// Accepts "provider/model-id" and "provider/model-id:<thinking>".
	const colon = trimmed.indexOf(":");
	const base = colon >= 0 ? trimmed.slice(0, colon) : trimmed;
	const thinkingSuffix = colon >= 0 ? trimmed.slice(colon + 1).trim() : "";
	const slash = base.indexOf("/");
	if (slash <= 0 || slash === base.length - 1) return null;

	const provider = base.slice(0, slash).trim();
	const modelId = base.slice(slash + 1).trim();
	if (!provider || !modelId) return null;

	const thinking =
		thinkingSuffix && THINKING_LEVELS.has(thinkingSuffix as ThinkingLevel)
			? (thinkingSuffix as ThinkingLevel)
			: undefined;
	return { provider, modelId, thinking };
}

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	return THINKING_LEVELS.has(normalized as ThinkingLevel) ? (normalized as ThinkingLevel) : null;
}

/**
 * Build Pi CLI launch args from agent frontmatter model/thinking.
 * `model: provider/model[:thinking]` -> `["--model", spec]`
 * `thinking: level` -> `["--thinking", level]` (skipped if model already has :thinking suffix)
 */
export function buildPiExtraArgs(defs: AgentDefaults | null): string[] {
	const args: string[] = [];
	if (defs?.model?.trim()) args.push("--model", defs.model.trim());
	const modelHasThinking = Boolean(parseModelSpec(defs?.model)?.thinking);
	const thinking = modelHasThinking ? null : normalizeThinkingLevel(defs?.thinking);
	if (thinking) args.push("--thinking", thinking);
	return args;
}

function safeSlug(value: string, fallback: string, maxLength = 48): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, maxLength);
	return slug || fallback;
}

function expandTilde(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function resolveSessionPathForLaunch(path: string, cwd = process.cwd()): string {
	const expanded = expandTilde(path.trim());
	return expanded.startsWith("/") ? expanded : resolve(cwd, expanded);
}

export function buildChildSessionFile(
	sessionDir: string | undefined,
	displayName: string,
): string | undefined {
	if (!sessionDir?.trim()) return undefined;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return join(sessionDir, `${ts}_${safeSlug(displayName, "subagent")}_${randomUUID()}.jsonl`);
}

export function buildSubagentLaunchArgs(
	defs: AgentDefaults | null,
	childSessionFile?: string,
): string[] {
	const args = buildPiExtraArgs(defs);
	if (childSessionFile) args.push("--session", childSessionFile);
	return args;
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
		const writeHint =
			params.artifactScratchpadId != null && params.artifactScratchpadRevision != null
				? ` Call scratchpad_write with scratchpad_id: ${params.artifactScratchpadId}, expected_revision: ${params.artifactScratchpadRevision}, and your content. If the tool ever returns a revision-mismatch error, retry once using the \`current\` value from the error message; do not call scratchpad_read first.`
				: params.artifactScratchpadId != null
					? ` Call scratchpad_write with scratchpad_id: ${params.artifactScratchpadId} and your content. Omit expected_revision on the first write; if a revision-mismatch error comes back, retry once with the \`current\` value from the error message.`
					: " Call scratchpad_write with that name and your content. Omit expected_revision on the first write; if a revision-mismatch error comes back, retry once with the `current` value from the error message.";
		sections.push(
			[
				"### Artifact (Solo scratchpad)",
				`Save any artifact you produce (plan, spec, context document, report, result note, etc.) to the Solo scratchpad named "${params.artifactScratchpadName}"${idText}.${writeHint}`,
				"Reference the scratchpad name and id in your final summary so the parent can pick up the result.",
			].join("\n\n"),
		);
	}

	sections.push(["---", params.task].join("\n\n"));
	return sections.join("\n\n");
}

export function buildResumePrompt(params: {
	name: string;
	task?: string;
	artifactScratchpadName?: string;
	artifactScratchpadId?: number;
	prompt?: string;
}): string {
	const artifact = params.artifactScratchpadName
		? `Artifact scratchpad: "${params.artifactScratchpadName}"${params.artifactScratchpadId != null ? ` (id ${params.artifactScratchpadId})` : ""}. Keep using this scratchpad; do not create a replacement.`
		: "No artifact scratchpad was pre-created for this subagent.";
	return [
		`Resume the previous subagent session for "${params.name}".`,
		"You were relaunched with the same Pi --session file, so continue from the existing conversation context rather than starting over.",
		artifact,
		params.task ? `Original task:\n${params.task}` : undefined,
		params.prompt ? `Additional resume instruction:\n${params.prompt}` : undefined,
		"If the task is already complete, ensure the artifact is up to date, summarize, and then stop at idle.",
	]
		.filter(Boolean)
		.join("\n\n");
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
			}. Read it with scratchpad_read${
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

export interface ParsedWakeMarker {
	kind: "done" | "interactive-ready";
	processId: number;
	scratchpadId?: number;
	name?: string;
	agent?: string;
}

export function parseWakeMarker(text: string): ParsedWakeMarker | null {
	// Solo's idle timer prepends `[Solo timer #N] [wait for any: ...]` before
	// our wake body, so the marker is rarely at the very start of the input.
	// Match anywhere; the marker token is unambiguous enough on its own.
	const match = text.match(/\[pi-solo:subagent-(done|interactive-ready)\s+id=(\d+)([^\]]*)\]/);
	if (!match) return null;

	const kind = match[1] as "done" | "interactive-ready";
	const processId = Number(match[2]);
	const tail = match[3] ?? "";

	const scratchpadMatch = tail.match(/\bscratchpad=(\d+)/);
	const nameMatch = tail.match(/\bname="((?:\\.|[^"\\])*)"/);
	const agentMatch = tail.match(/\bagent="((?:\\.|[^"\\])*)"/);

	const unquote = (s: string) => s.replace(/\\(.)/g, "$1");

	return {
		kind,
		processId,
		scratchpadId: scratchpadMatch ? Number(scratchpadMatch[1]) : undefined,
		name: nameMatch ? unquote(nameMatch[1]!) : undefined,
		agent: agentMatch ? unquote(agentMatch[1]!) : undefined,
	};
}

/**
 * Compact wake-up body fed to the LLM after we suppress the verbose Solo
 * timer prompt. The model already has solo_tool / scratchpad_read in its
 * tool catalog; it does not need paragraph-length instructions to know how
 * to call them.
 */
export function buildShortWakeBody(params: {
	kind: "done" | "interactive-ready";
	processId: number;
	name: string;
	agent?: string;
	scratchpadId?: number;
	scratchpadName?: string;
}): string {
	const scratchpadRef =
		params.scratchpadId != null
			? `Artifact: scratchpad #${params.scratchpadId}${params.scratchpadName ? ` ("${params.scratchpadName}")` : ""} — read with scratchpad_read.`
			: "No artifact scratchpad was pre-created for this subagent.";

	if (params.kind === "interactive-ready") {
		return [
			`Sub-agent "${params.name}" (Solo agent #${params.processId}) finished its turn and is waiting in its Solo pane.`,
			scratchpadRef,
			"Do not close the pane automatically — the user can continue the conversation in Solo.",
		].join(" ");
	}

	return [
		`Sub-agent "${params.name}" (Solo agent #${params.processId}) reached idle.`,
		scratchpadRef,
		`When done, close the pane with solo_tool({ action: "call", name: "close_process", arguments: { process_id: ${params.processId} }, reason: "close completed subagent pane" }).`,
	].join(" ");
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
	resumeSession: Type.Optional(
		Type.String({
			description:
				"Existing Pi session file to use for the child. When omitted, pi-solo creates a child session file and passes it to Pi as --session.",
		}),
	),
});

const SubagentResumeParams = Type.Object({
	id: Type.Optional(Type.String({ description: "pi-solo subagent id to resume" })),
	processId: Type.Optional(Type.Number({ description: "Solo process id to resume" })),
	session: Type.Optional(Type.String({ description: "Pi session file to spawn with --session" })),
	name: Type.Optional(
		Type.String({ description: "Display name when spawning from a session path" }),
	),
	agent: Type.Optional(
		Type.String({ description: "Agent definition to use when spawning from a session path" }),
	),
	prompt: Type.Optional(
		Type.String({ description: "Optional instruction to send after resuming" }),
	),
	interactive: Type.Optional(
		Type.Boolean({ description: "Whether the resumed agent is interactive" }),
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
	childSessionFile?: string;
	launchArgs: string[];
}

const SUBAGENT_STATE_ENTRY = "pi-solo-subagent";
const SCRATCHPAD_PLACEHOLDER_MARKER = "Reserved by pi-solo subagent orchestration";

interface PersistedSubagentState extends RunningSubagent {
	version: 1;
	updatedAt: string;
}

type SubagentStateEntryData =
	| { version: 1; event: "upsert"; subagent: PersistedSubagentState; updatedAt: string }
	| { version: 1; event: "complete"; id?: string; processId?: number; completedAt: string };

const runningSubagents = new Map<string, RunningSubagent>();

function toPersistedSubagent(running: RunningSubagent): PersistedSubagentState {
	return { ...running, version: 1, updatedAt: new Date().toISOString() };
}

function normalizePersistedSubagent(value: any): PersistedSubagentState | null {
	if (!value || typeof value !== "object") return null;
	if (typeof value.id !== "string" || typeof value.name !== "string") return null;
	if (typeof value.task !== "string" || typeof value.processId !== "number") return null;
	return {
		version: 1,
		id: value.id,
		name: value.name,
		task: value.task,
		agent: typeof value.agent === "string" ? value.agent : undefined,
		processId: value.processId,
		timerId: typeof value.timerId === "number" ? value.timerId : undefined,
		startTime: typeof value.startTime === "number" ? value.startTime : Date.now(),
		interactive: value.interactive === true,
		runtimeState: typeof value.runtimeState === "string" ? value.runtimeState : undefined,
		artifactScratchpadName:
			typeof value.artifactScratchpadName === "string" ? value.artifactScratchpadName : undefined,
		artifactScratchpadId:
			typeof value.artifactScratchpadId === "number" ? value.artifactScratchpadId : undefined,
		wakeBody: typeof value.wakeBody === "string" ? value.wakeBody : "",
		wakeAlreadyDue: value.wakeAlreadyDue === true,
		childSessionFile:
			typeof value.childSessionFile === "string" ? value.childSessionFile : undefined,
		launchArgs: Array.isArray(value.launchArgs)
			? value.launchArgs.filter((arg: unknown) => typeof arg === "string")
			: [],
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
	};
}

function runningFromPersisted(state: PersistedSubagentState): RunningSubagent {
	const { version: _version, updatedAt: _updatedAt, ...running } = state;
	return running;
}

function reconstructPersistedSubagents(
	entries: readonly any[],
): Map<string, PersistedSubagentState> {
	const restored = new Map<string, PersistedSubagentState>();
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== SUBAGENT_STATE_ENTRY) continue;
		const data = entry.data as SubagentStateEntryData | undefined;
		if (data?.version !== 1) continue;
		if (data.event === "upsert") {
			const state = normalizePersistedSubagent(data.subagent);
			if (state) restored.set(state.id, state);
			continue;
		}
		if (data.event === "complete") {
			if (typeof data.id === "string") {
				restored.delete(data.id);
				continue;
			}
			if (typeof data.processId === "number") {
				for (const [id, state] of restored) {
					if (state.processId === data.processId) restored.delete(id);
				}
			}
		}
	}
	return restored;
}

function persistRunningSubagent(pi: ExtensionAPI, running: RunningSubagent): void {
	pi.appendEntry<SubagentStateEntryData>(SUBAGENT_STATE_ENTRY, {
		version: 1,
		event: "upsert",
		subagent: toPersistedSubagent(running),
		updatedAt: new Date().toISOString(),
	});
}

function persistSubagentComplete(
	pi: ExtensionAPI,
	params: { id?: string; processId?: number },
): void {
	pi.appendEntry<SubagentStateEntryData>(SUBAGENT_STATE_ENTRY, {
		version: 1,
		event: "complete",
		id: params.id,
		processId: params.processId,
		completedAt: new Date().toISOString(),
	});
}

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
	ctx: ExtensionContext,
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
	const interactive = resolveEffectiveInteractive(params, agentDefs);
	const childSessionFile = params.resumeSession?.trim()
		? resolveSessionPathForLaunch(params.resumeSession, ctx.cwd)
		: buildChildSessionFile(ctx.sessionManager.getSessionDir(), params.name);
	const launchArgs = buildSubagentLaunchArgs(agentDefs, childSessionFile);

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
	const surface = await createAgentSurface(client, tagged, agentToolId, {
		extraArgs: launchArgs,
	});
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
	let wake: { timerId?: number; alreadySatisfied?: boolean } = { timerId: undefined };
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
		wakeAlreadyDue: !becameBusy || wake.alreadySatisfied === true,
		childSessionFile,
		launchArgs,
	};
	runningSubagents.set(id, running);
	return running;
}

async function armWakeForRunning(client: SoloMcpLike, running: RunningSubagent): Promise<void> {
	if (running.timerId != null) {
		try {
			await client.callTool("timer_cancel", { timer_id: running.timerId });
		} catch {
			// Best-effort duplicate prevention; the previous timer may already have fired
			// or may have been owned by the parent process before a restart.
		}
	}
	const wake = await scheduleIdleWake(
		client,
		running.processId,
		DEFAULT_MAX_WAIT_MS,
		running.wakeBody,
	);
	running.timerId = wake.timerId;
	running.wakeAlreadyDue = wake.alreadySatisfied;
}

async function emitSubagentResult(
	pi: ExtensionAPI,
	params: {
		kind: "done" | "interactive-ready";
		processId: number;
		name: string;
		agent?: string;
		scratchpadId?: number;
		scratchpadName?: string;
		id?: string;
	},
): Promise<void> {
	if (params.id) runningSubagents.delete(params.id);
	persistSubagentComplete(pi, { id: params.id, processId: params.processId });

	const llmBody = buildShortWakeBody({
		kind: params.kind,
		processId: params.processId,
		name: params.name,
		agent: params.agent,
		scratchpadId: params.scratchpadId,
		scratchpadName: params.scratchpadName,
	});

	await pi.sendMessage(
		{
			customType: "subagent_result",
			content: llmBody,
			display: true,
			details: {
				kind: params.kind,
				name: params.name,
				agent: params.agent,
				processId: params.processId,
				scratchpadId: params.scratchpadId,
				scratchpadName: params.scratchpadName,
			},
		},
		{ triggerTurn: true },
	);
}

function extractedScratchpadContent(result: {
	structuredContent?: unknown;
	content?: Array<{ type: string; text?: string }>;
}): string | undefined {
	const data = extractToolJson<any>(result);
	const content = data?.scratchpad?.content ?? data?.content;
	if (typeof content === "string") return content;
	return result.content?.find((item) => item.type === "text" && item.text)?.text;
}

async function scratchpadHasArtifact(client: SoloMcpLike, scratchpadId: number): Promise<boolean> {
	try {
		const result = await client.callTool("scratchpad_read", {
			scratchpad_id: scratchpadId,
			mode: "full",
		});
		if (result.isError) return false;
		const content = extractedScratchpadContent(result);
		return Boolean(content?.trim() && !content.includes(SCRATCHPAD_PLACEHOLDER_MARKER));
	} catch {
		return false;
	}
}

async function respawnSubagentFromState(
	client: SoloMcpLike,
	state: PersistedSubagentState,
	resumePrompt?: string,
): Promise<RunningSubagent> {
	const agentToolId = await resolvePiAgentToolId(client);
	const tagged = labelForSurface(state.name, state.agent);
	const launchArgs = state.launchArgs.length
		? state.launchArgs
		: buildSubagentLaunchArgs(
				state.agent ? loadAgentDefaults(state.agent) : null,
				state.childSessionFile,
			);
	const surface = await createAgentSurface(client, tagged, agentToolId, { extraArgs: launchArgs });
	await renameSurface(client, surface.processId, tagged);
	await waitForAgentReady(client, surface.processId);

	const running: RunningSubagent = {
		...runningFromPersisted(state),
		processId: surface.processId,
		timerId: undefined,
		startTime: Date.now(),
		runtimeState: "active",
		wakeAlreadyDue: false,
		launchArgs,
	};
	running.wakeBody = buildWakeBody({
		subagentName: running.name,
		agent: running.agent,
		processId: running.processId,
		scratchpadName: running.artifactScratchpadName,
		scratchpadId: running.artifactScratchpadId,
		interactive: running.interactive,
		maxWaitMs: DEFAULT_MAX_WAIT_MS,
	});

	await sendCommand(
		client,
		running.processId,
		buildResumePrompt({
			name: running.name,
			task: running.task,
			artifactScratchpadName: running.artifactScratchpadName,
			artifactScratchpadId: running.artifactScratchpadId,
			prompt: resumePrompt,
		}),
	);

	const becameBusy = await waitForAgentBusy(client, running.processId);
	if (becameBusy) await armWakeForRunning(client, running);
	else running.wakeAlreadyDue = true;
	runningSubagents.set(running.id, running);
	return running;
}

async function restorePersistedSubagent(
	pi: ExtensionAPI,
	client: SoloMcpLike,
	state: PersistedSubagentState,
): Promise<void> {
	if (runningSubagents.has(state.id)) return;

	const status = await getAgentProcessState(client, state.processId);
	if (status.exists && status.state !== "stopped") {
		const running = runningFromPersisted(state);
		running.runtimeState = status.state;
		runningSubagents.set(running.id, running);
		if (status.state === "idle") {
			await emitSubagentResult(pi, {
				kind: running.interactive ? "interactive-ready" : "done",
				processId: running.processId,
				name: running.name,
				agent: running.agent,
				scratchpadId: running.artifactScratchpadId,
				scratchpadName: running.artifactScratchpadName,
				id: running.id,
			});
			return;
		}
		await armWakeForRunning(client, running);
		persistRunningSubagent(pi, running);
		if (running.wakeAlreadyDue) {
			await emitSubagentResult(pi, {
				kind: running.interactive ? "interactive-ready" : "done",
				processId: running.processId,
				name: running.name,
				agent: running.agent,
				scratchpadId: running.artifactScratchpadId,
				scratchpadName: running.artifactScratchpadName,
				id: running.id,
			});
		}
		return;
	}

	if (
		state.artifactScratchpadId != null &&
		(await scratchpadHasArtifact(client, state.artifactScratchpadId))
	) {
		await emitSubagentResult(pi, {
			kind: state.interactive ? "interactive-ready" : "done",
			processId: state.processId,
			name: state.name,
			agent: state.agent,
			scratchpadId: state.artifactScratchpadId,
			scratchpadName: state.artifactScratchpadName,
			id: state.id,
		});
		return;
	}

	const running = await respawnSubagentFromState(client, state);
	persistRunningSubagent(pi, running);
	if (running.wakeAlreadyDue) {
		await emitSubagentResult(pi, {
			kind: running.interactive ? "interactive-ready" : "done",
			processId: running.processId,
			name: running.name,
			agent: running.agent,
			scratchpadId: running.artifactScratchpadId,
			scratchpadName: running.artifactScratchpadName,
			id: running.id,
		});
	}
}

async function restorePersistedSubagents(
	pi: ExtensionAPI,
	client: SoloMcpLike,
	ctx: ExtensionContext,
): Promise<void> {
	const states = reconstructPersistedSubagents(ctx.sessionManager.getBranch());
	for (const state of states.values()) {
		try {
			await restorePersistedSubagent(pi, client, state);
		} catch {
			// Resume is best-effort. The persisted entry remains, so the user can
			// retry with /solo-subagent-resume once Solo/MCP is available again.
		}
	}
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

function findPersistedSubagent(
	states: Map<string, PersistedSubagentState>,
	params: Static<typeof SubagentResumeParams>,
	cwd = process.cwd(),
): PersistedSubagentState | undefined {
	if (params.id?.trim()) return states.get(params.id.trim());
	const sessionPath = params.session?.trim()
		? resolveSessionPathForLaunch(params.session, cwd)
		: undefined;
	for (const running of runningSubagents.values()) {
		if (params.processId != null && running.processId === params.processId) {
			return toPersistedSubagent(running);
		}
		if (sessionPath && running.childSessionFile === sessionPath) {
			return toPersistedSubagent(running);
		}
	}
	for (const state of states.values()) {
		if (params.processId != null && state.processId === params.processId) return state;
		if (sessionPath && state.childSessionFile === sessionPath) return state;
	}
	return undefined;
}

async function spawnSubagentFromSession(
	client: SoloMcpLike,
	ctx: ExtensionContext,
	params: Static<typeof SubagentResumeParams>,
): Promise<RunningSubagent> {
	if (!params.session?.trim()) throw new Error("Provide a session path to spawn from.");
	const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
	const childSessionFile = resolveSessionPathForLaunch(params.session, ctx.cwd);
	const name =
		params.name?.trim() || safeSlug(childSessionFile.split("/").pop() ?? "session", "session");
	const launchArgs = buildSubagentLaunchArgs(agentDefs, childSessionFile);
	const agentToolId = await resolvePiAgentToolId(client);
	const tagged = labelForSurface(name, params.agent);
	const surface = await createAgentSurface(client, tagged, agentToolId, { extraArgs: launchArgs });
	await renameSurface(client, surface.processId, tagged);
	await waitForAgentReady(client, surface.processId);

	const running: RunningSubagent = {
		id: Math.random().toString(16).slice(2, 10),
		name,
		task: params.prompt?.trim() || "Resume the existing Pi session.",
		agent: params.agent,
		processId: surface.processId,
		startTime: Date.now(),
		interactive: params.interactive === true,
		runtimeState: "active",
		wakeBody: "",
		wakeAlreadyDue: false,
		childSessionFile,
		launchArgs,
	};
	running.wakeBody = buildWakeBody({
		subagentName: running.name,
		agent: running.agent,
		processId: running.processId,
		interactive: running.interactive,
		maxWaitMs: DEFAULT_MAX_WAIT_MS,
	});

	await sendCommand(
		client,
		running.processId,
		buildResumePrompt({ name: running.name, task: running.task, prompt: params.prompt }),
	);
	const becameBusy = await waitForAgentBusy(client, running.processId);
	if (becameBusy) await armWakeForRunning(client, running);
	else running.wakeAlreadyDue = true;
	runningSubagents.set(running.id, running);
	return running;
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
	pi.on("session_start", async (_event, ctx) => {
		if (!deps.isClientReady()) return;
		await restorePersistedSubagents(pi, deps.client, ctx);
	});

	pi.on("session_shutdown", () => {
		runningSubagents.clear();
	});

	pi.on("input", async (event) => {
		const marker = parseWakeMarker(event.text ?? "");
		if (!marker) return { action: "continue" };

		// Clean up internal tracking and recover the original launch params so
		// the renderer can show the artifact path and the LLM gets a tight body.
		let running: RunningSubagent | undefined;
		for (const [id, r] of runningSubagents) {
			if (r.processId === marker.processId) {
				running = r;
				runningSubagents.delete(id);
				break;
			}
		}

		try {
			await emitSubagentResult(pi, {
				kind: marker.kind,
				processId: marker.processId,
				name: running?.name ?? marker.name ?? `Solo #${marker.processId}`,
				agent: running?.agent ?? marker.agent,
				scratchpadId: marker.scratchpadId ?? running?.artifactScratchpadId,
				scratchpadName: running?.artifactScratchpadName,
				id: running?.id,
			});
			return { action: "handled" };
		} catch {
			return { action: "continue" };
		}
	});

	// ── subagent ──
	pi.registerTool({
		name: "subagent",
		label: "Solo Subagent",
		description:
			"Spawn a sub-agent as a real Solo agent process (kind=agent). " +
			"This is fire-and-forget: the call returns after the child is launched and an idle timer is scheduled. " +
			"When the child goes idle (or the timer hits its max wait), Solo injects a fresh user turn into the parent with the process id and scratchpad id. " +
			"Artifacts are saved to Solo scratchpads. Do not poll or fabricate results.",
		promptSnippet:
			"Spawn a Solo-native sub-agent. Fire-and-forget; Solo wakes the parent when the child goes idle. Artifacts go to Solo scratchpads.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!deps.isClientReady()) {
				return muxUnavailableResult(
					"Solo MCP not ready — make sure Solo is running and MCP is enabled (Settings → MCP).",
				);
			}

			const running = await launchSubagent(deps.client, params, ctx);
			persistRunningSubagent(pi, running);
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
					childSessionFile: running.childSessionFile,
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

	// ── subagent_resume ──
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Solo Subagent",
		description:
			"Resume a Solo subagent by pi-solo id, Solo process id, or Pi session file. " +
			"If the old Solo pane still exists, pi-solo re-attaches and re-arms the idle watcher. " +
			"If it is gone, pi-solo respawns Pi with the saved --session args and sends a resume prompt.",
		promptSnippet:
			"Resume a previously launched Solo subagent, preserving its Pi session and artifact scratchpad.",
		parameters: SubagentResumeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!deps.isClientReady()) {
				return muxUnavailableResult(
					"Solo MCP not ready — make sure Solo is running and MCP is enabled (Settings → MCP).",
				);
			}

			const states = reconstructPersistedSubagents(ctx.sessionManager.getBranch());
			const persisted = findPersistedSubagent(states, params, ctx.cwd);
			let running: RunningSubagent;

			if (persisted) {
				const live = runningSubagents.get(persisted.id);
				const candidate = live ?? runningFromPersisted(persisted);
				const status = await getAgentProcessState(deps.client, candidate.processId);
				if (status.exists && status.state !== "stopped") {
					running = candidate;
					running.runtimeState = status.state;
					runningSubagents.set(running.id, running);
					if (params.prompt?.trim()) {
						await sendCommand(deps.client, running.processId, params.prompt.trim());
						const becameBusy = await waitForAgentBusy(deps.client, running.processId);
						if (becameBusy) await armWakeForRunning(deps.client, running);
						else running.wakeAlreadyDue = true;
					} else if (status.state === "idle") {
						running.wakeAlreadyDue = true;
					} else {
						await armWakeForRunning(deps.client, running);
					}
				} else {
					running = await respawnSubagentFromState(deps.client, persisted, params.prompt);
				}
			} else if (params.session?.trim()) {
				running = await spawnSubagentFromSession(deps.client, ctx, params);
			} else {
				return {
					content: [
						{
							type: "text" as const,
							text: "No matching subagent found. Provide id, processId, or session.",
						},
					],
					details: { error: "not_found" },
				};
			}

			persistRunningSubagent(pi, running);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Sub-agent "${running.name}" resumed in Solo agent pane #${running.processId}. ` +
							(running.childSessionFile ? `Pi session: ${running.childSessionFile}. ` : "") +
							(running.wakeAlreadyDue
								? `It is idle now. Treat this as the wake-up body:\n\n${running.wakeBody}`
								: "Solo will wake the parent when it goes idle."),
					},
				],
				details: {
					id: running.id,
					name: running.name,
					agent: running.agent,
					processId: running.processId,
					timerId: running.timerId,
					childSessionFile: running.childSessionFile,
					artifactScratchpadName: running.artifactScratchpadName,
					artifactScratchpadId: running.artifactScratchpadId,
					wakeAlreadyDue: running.wakeAlreadyDue,
					status: "resumed",
				},
			};
		},
	});

	// ── subagent_interrupt ──
	pi.registerTool({
		name: "subagent_interrupt",
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

	// ── subagents_list ──
	pi.registerTool({
		name: "subagents_list",
		label: "List Solo Subagent Definitions",
		description:
			"List all available subagent definitions. Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. Project-local agents override global ones with the same name.",
		promptSnippet: "List the agent definitions available to subagent (scout, worker, planner, …).",
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
				`Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`,
			);
		},
	});

	pi.registerCommand("solo-subagent-resume", {
		description: "Resume a Solo subagent: /solo-subagent-resume <id|process-id|session> [prompt]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /solo-subagent-resume <id|process-id|session> [prompt]", "warning");
				return;
			}
			const spaceIdx = trimmed.indexOf(" ");
			const target = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
			const key = /^\d+$/.test(target)
				? "processId"
				: target.includes("/") || target.endsWith(".jsonl")
					? "session"
					: "id";
			const value = key === "processId" ? Number(target) : target;
			pi.sendUserMessage(
				`Use subagent_resume with ${key}: ${JSON.stringify(value)}${prompt ? ` and prompt: ${JSON.stringify(prompt)}` : ""}`,
			);
		},
	});

	pi.registerMessageRenderer("subagent_result", (message, _options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;

		const name = details.name ?? "subagent";
		const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
		const statusLabel = details.kind === "interactive-ready" ? "ready" : "done";
		const processId = details.processId;
		const soloRef = processId != null ? ` (Solo #${processId})` : "";
		const artifactTag =
			details.scratchpadName != null
				? theme.fg("dim", ` · artifact → ${details.scratchpadName}`)
				: details.scratchpadId != null
					? theme.fg("dim", ` · artifact → #${details.scratchpadId}`)
					: "";

		const headerLine =
			theme.fg("accent", "▸") +
			" " +
			theme.fg("toolTitle", theme.bold(name)) +
			agentTag +
			theme.fg("dim", ` — ${statusLabel}${soloRef}`) +
			artifactTag;

		// Match the visual frame of a successful tool call (toolSuccessBg) so
		// the wake-up reads as part of the subagent's tool stream rather than a
		// generic custom message in `customMessageBg`.
		const bgFn = (t: string) => theme.bg("toolSuccessBg", t);
		const box = new Box(1, 1, bgFn);
		box.addChild(new Text(headerLine, 0, 0, bgFn));
		return box;
	});
}

// Exported for tests
export const __test__ = {
	buildArtifactScratchpadName,
	buildChildSessionFile,
	buildResumePrompt,
	buildShortWakeBody,
	buildSubagentLaunchArgs,
	buildWakeBody,
	buildWrappedTask,
	discoverAgentDefinitions,
	formatElapsed,
	labelForSurface,
	loadAgentDefaults,
	normalizeThinkingLevel,
	parseAgentDefinition,
	parseModelSpec,
	parseWakeMarker,
	reconstructPersistedSubagents,
	resolveEffectiveInteractive,
	resolveInterruptTarget,
	resolveSessionPathForLaunch,
	runningSubagents,
	toPersistedSubagent,
	wantsScratchpad,
};
