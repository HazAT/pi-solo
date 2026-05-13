/**
 * Solo-native subagent orchestration.
 *
 * Inspired by pi-interactive-subagents but Solo-only: no cmux/tmux/zellij/
 * wezterm abstraction, no Claude Code path, no separate activity recorder.
 * Subagents run inside Solo terminal panes (visible in the sidebar) launched
 * via `spawn_process(kind="terminal")`, driven via `send_input`, and torn
 * down via `close_process`.
 *
 * Artifacts (plans, specs, scout context, reports) flow through Solo
 * scratchpads instead of local files — they're project-scoped, persistent
 * across sessions, and visible in Solo's UI. The orchestrator pre-creates an
 * empty scratchpad for each subagent and passes the name + id via env, so
 * the child knows exactly where to save its output.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type SoloMcpLike,
	createSurface,
	closeSurface,
	getRuntimeState,
	pollForExit,
	renameSurface,
	sendEscape,
	sendLongCommand,
	shellEscape,
} from "./solo-surface.ts";
import {
	findLastAssistantMessage,
	getNewEntries,
	readEntryCount,
	seedSubagentSessionFile,
} from "./session.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// ── /reload survival ─────────────────────────────────────────────────────
// /reload re-imports this module, but closures from the old module keep
// their timers and poll loops alive. Clear them on every module load.

const WIDGET_INTERVAL_KEY = Symbol.for("pi-solo-subagents/widget-interval");
const POLL_ABORT_KEY = Symbol.for("pi-solo-subagents/poll-abort-controller");

{
	const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
	if (prevInterval) {
		clearInterval(prevInterval);
		(globalThis as any)[WIDGET_INTERVAL_KEY] = null;
	}
	const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
	if (prevAbort) prevAbort.abort();
	(globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
	return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// ── Agent definitions ────────────────────────────────────────────────────

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";
type AgentSource = "global" | "project";

interface AgentDefaults {
	model?: string;
	tools?: string;
	skills?: string;
	thinking?: string;
	denyTools?: string;
	spawning?: boolean;
	autoExit?: boolean;
	interactive?: boolean;
	systemPromptMode?: "append" | "replace";
	sessionMode?: SubagentSessionMode;
	cwd?: string;
	body?: string;
	output?: string;
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

const SPAWNING_TOOLS = new Set([
	"solo_subagent",
	"solo_subagent_interrupt",
	"solo_subagents_list",
	"solo_subagent_resume",
]);

export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
	const denied = new Set<string>();
	if (!agentDefs) return denied;
	if (agentDefs.spawning === false) {
		for (const t of SPAWNING_TOOLS) denied.add(t);
	}
	if (agentDefs.denyTools) {
		for (const t of agentDefs.denyTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			denied.add(t);
		}
	}
	return denied;
}

function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1]!.trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
	if (value === "standalone" || value === "lineage-only" || value === "fork") return value;
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

	return {
		name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
		description: getFrontmatterValue(frontmatter, "description"),
		model: getFrontmatterValue(frontmatter, "model"),
		tools: getFrontmatterValue(frontmatter, "tools"),
		systemPromptMode:
			systemPromptMode === "replace"
				? "replace"
				: systemPromptMode === "append"
					? "append"
					: undefined,
		skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
		thinking: getFrontmatterValue(frontmatter, "thinking"),
		denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
		spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
		autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
		interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
		sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
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

function loadAgentDefaults(agentName: string): AgentDefaults | null {
	const configDir = getAgentConfigDir();
	const paths = [
		join(process.cwd(), ".pi", "agents", `${agentName}.md`),
		join(configDir, "agents", `${agentName}.md`),
	];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
		if (parsed) return parsed;
	}
	return null;
}

function resolveSubagentPaths(
	params: { cwd?: string },
	agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
	const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
	const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
	const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
	const effectiveCwd = rawCwd ? (rawCwd.startsWith("/") ? rawCwd : join(cwdBase, rawCwd)) : null;
	const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
	const effectiveAgentDir =
		localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
	return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

export function resolveEffectiveSessionMode(
	params: { fork?: boolean },
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	if (params.fork) return "fork";
	return agentDefs?.sessionMode ?? "standalone";
}

interface LaunchBehavior {
	sessionMode: SubagentSessionMode;
	seededSessionMode: "lineage-only" | "fork" | null;
	inheritsConversationContext: boolean;
	taskDelivery: "direct" | "artifact";
}

export function resolveLaunchBehavior(
	params: { fork?: boolean },
	agentDefs: AgentDefaults | null,
): LaunchBehavior {
	const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
	const inheritsConversationContext = sessionMode === "fork";
	return {
		sessionMode,
		seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
		inheritsConversationContext,
		taskDelivery: inheritsConversationContext ? "direct" : "artifact",
	};
}

export function resolveEffectiveInteractive(
	params: { interactive?: boolean },
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.interactive != null) return params.interactive;
	if (agentDefs?.interactive != null) return agentDefs.interactive;
	return !(agentDefs?.autoExit ?? false);
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
	name: string;
}

/**
 * Pre-create an empty Solo scratchpad to hold the subagent's artifact.
 *
 * Best-effort: if Solo's scratchpads are disabled or the call fails, we
 * return just the proposed name and let the child fall back to creating its
 * own scratchpad on save.
 */
async function preCreateArtifactScratchpad(
	client: SoloMcpLike,
	name: string,
	agentName: string | undefined,
	taskPreview: string,
): Promise<CreatedScratchpad> {
	const placeholder =
		`# ${name}\n\n` +
		`> Reserved by pi-solo subagent orchestration${agentName ? ` for the **${agentName}** agent` : ""}.\n` +
		`> This scratchpad will be overwritten when the subagent saves its artifact.\n\n` +
		`**Task preview:** ${taskPreview.slice(0, 400)}${taskPreview.length > 400 ? "…" : ""}\n`;

	try {
		const result = await client.callTool("scratchpad_write", {
			name,
			content: placeholder,
			tags: ["subagent-artifact", ...(agentName ? [agentName] : [])],
		});
		const text = result.content?.find((c) => c.type === "text" && c.text)?.text;
		let id: number | undefined;
		const sc = result.structuredContent as any;
		if (sc && typeof sc.scratchpad_id === "number") id = sc.scratchpad_id;
		if (id == null && text) {
			try {
				const parsed = JSON.parse(text);
				if (typeof parsed?.scratchpad_id === "number") id = parsed.scratchpad_id;
			} catch {}
		}
		return { scratchpadId: id, name };
	} catch {
		return { name };
	}
}

// ── Widget ──────────────────────────────────────────────────────────────

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

function formatElapsedMMSS(startTime: number): string {
	const seconds = Math.floor((Date.now() - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

function borderLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return `${ACCENT}│${RST}`;
	const contentWidth = Math.max(0, width - 2);
	const rightVis = visibleWidth(right);
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
	}
	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

function borderTop(title: string, info: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return `${ACCENT}╭${RST}`;
	const inner = Math.max(0, width - 2);
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
	return `${ACCENT}╭${content}╮${RST}`;
}

function borderBottom(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return `${ACCENT}╰${RST}`;
	const inner = Math.max(0, width - 2);
	return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function statusBadge(state: string): string {
	if (state === "active" || state === "running") return " running ";
	if (state === "idle") return " idle ";
	if (state === "starting") return " starting… ";
	if (state === "exited" || state === "stopped") return " exiting ";
	return " active ";
}

export function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
	const count = agents.length;
	const title = "Subagents (Solo)";
	const info = `${count} running`;
	const lines: string[] = [borderTop(title, info, width)];

	for (const agent of agents) {
		const elapsed = formatElapsedMMSS(agent.startTime);
		const agentTag = agent.agent ? ` (${agent.agent})` : "";
		const left = ` ${elapsed}  ${agent.name}${agentTag} `;
		const right = statusBadge(agent.runtimeState ?? "starting");
		lines.push(borderLine(left, right, width));
	}
	lines.push(borderBottom(width));
	return lines;
}

// ── Running-agent registry ──────────────────────────────────────────────

interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	processId: number;
	startTime: number;
	sessionFile: string;
	launchScriptFile?: string;
	abortController?: AbortController;
	interactive: boolean;
	runtimeState?: string;
	artifactScratchpadName?: string;
	artifactScratchpadId?: number;
	closeOnDone: boolean;
}

const runningSubagents = new Map<string, RunningSubagent>();

let latestCtx: ExtensionContext | null = null;
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function updateWidget() {
	if (!latestCtx?.hasUI) return;
	if (runningSubagents.size === 0) {
		latestCtx.ui.setWidget("solo-subagent-status", undefined);
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			(globalThis as any)[WIDGET_INTERVAL_KEY] = null;
		}
		return;
	}
	latestCtx.ui.setWidget(
		"solo-subagent-status",
		(_tui: any, _theme: any) => ({
			invalidate() {},
			render(width: number) {
				return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
			},
		}),
		{ placement: "aboveEditor" },
	);
}

function startWidgetRefresh(client: SoloMcpLike) {
	if (widgetInterval) return;
	updateWidget();
	widgetInterval = setInterval(async () => {
		// Refresh runtime state for visible agents — cheap and gives a live
		// idle/active indicator that comes straight from Solo.
		for (const agent of runningSubagents.values()) {
			try {
				agent.runtimeState = await getRuntimeState(client, agent.processId);
			} catch {
				agent.runtimeState = "unknown";
			}
		}
		updateWidget();
	}, 1500);
	widgetInterval.unref?.();
	(globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

// ── Task wrapper (with scratchpad artifact instructions) ────────────────

interface BuildTaskParams {
	task: string;
	roleBlock: string;
	autoExit: boolean;
	artifactScratchpadName?: string;
	artifactScratchpadId?: number;
}

export function buildWrappedTask(params: BuildTaskParams): string {
	const modeHint = params.autoExit
		? "Complete your task autonomously."
		: "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
	const summaryInstruction = params.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";

	const artifactBlock = params.artifactScratchpadName
		? [
				"",
				"### Artifact (Solo scratchpad)",
				"",
				`Save any artifact you produce (plan, spec, context, report, etc.) to the Solo scratchpad named **"${params.artifactScratchpadName}"**${
					params.artifactScratchpadId != null
						? ` (scratchpad_id: ${params.artifactScratchpadId})`
						: ""
				} using \`solo_scratchpad_write\`.`,
				params.artifactScratchpadId != null
					? `Pass \`scratchpad_id: ${params.artifactScratchpadId}\` and \`expected_revision\` from the most recent read so you replace the placeholder atomically.`
					: "If the scratchpad doesn't exist yet, create it by calling `solo_scratchpad_write` with just the name.",
				"Reference the scratchpad name (and id, once you know it) in your final summary so the parent can hand it to the next agent.",
				"Do NOT save plans, specs, or context documents to local files — Solo scratchpads are project-scoped, persistent, and visible in Solo's sidebar.",
			].join("\n")
		: "";

	return `${params.roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}${artifactBlock}`;
}

// ── Tool parameters ─────────────────────────────────────────────────────

const SubagentParams = Type.Object({
	name: Type.String({ description: "Display name for the subagent (shown in Solo's sidebar)" }),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	agent: Type.Optional(
		Type.String({
			description:
				"Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). " +
				"Reads ~/.pi/agent/agents/<name>.md for model, tools, skills, identity.",
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({ description: "Appended to system prompt (role instructions)" }),
	),
	model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
	skills: Type.Optional(
		Type.String({ description: "Comma-separated skills (overrides agent default)" }),
	),
	tools: Type.Optional(
		Type.String({ description: "Comma-separated tools (overrides agent default)" }),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions.",
		}),
	),
	fork: Type.Optional(
		Type.Boolean({
			description:
				"Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Mark the subagent as interactive (long-running, user-driven). When true, the parent isn't woken on quiet/active transitions, and Solo keeps the pane open after completion so the user can continue the conversation.",
		}),
	),
	scratchpad: Type.Optional(
		Type.Boolean({
			description:
				"Pre-create a Solo scratchpad for the subagent's artifact and instruct it to save output there. Defaults to true when the agent definition has `output:` frontmatter, false otherwise.",
		}),
	),
	resumeSessionId: Type.Optional(
		Type.String({
			description:
				"Resume a previous Pi session by file path or claude session id. Use this to retry cancelled runs or ask follow-up questions.",
		}),
	),
});

// ── Launch / watch ──────────────────────────────────────────────────────

function muxUnavailableResult(reason: string) {
	return {
		content: [{ type: "text" as const, text: reason }],
		details: { error: reason },
	};
}

function getArtifactDir(sessionDir: string, sessionId: string): string {
	return join(sessionDir, "artifacts", sessionId);
}

interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	errorMessage?: string;
	error?: string;
	ping?: { name: string; message: string };
	artifactScratchpadName?: string;
	artifactScratchpadId?: number;
}

async function launchSubagent(
	client: SoloMcpLike,
	params: Static<typeof SubagentParams>,
	ctx: {
		sessionManager: {
			getSessionFile(): string | null;
			getSessionId(): string;
			getSessionDir(): string;
		};
		cwd: string;
	},
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);

	const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
	const effectiveModel = params.model ?? agentDefs?.model;
	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const effectiveThinking = agentDefs?.thinking;
	const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
	const autoExit = agentDefs?.autoExit ?? false;

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("No session file");
	const sessionId = ctx.sessionManager.getSessionId();
	const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

	const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
		params,
		agentDefs,
	);
	const targetCwdForSession = effectiveCwd ?? ctx.cwd;
	const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
	const uuid = [
		id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

	const launchBehavior = resolveLaunchBehavior(params, agentDefs);
	if (launchBehavior.seededSessionMode) {
		seedSubagentSessionFile({
			mode: launchBehavior.seededSessionMode,
			parentSessionFile: sessionFile,
			childSessionFile: subagentSessionFile,
			childCwd: targetCwdForSession,
		});
	}

	// Pre-create the artifact scratchpad (only when the agent produces one).
	const wantsScratchpad = params.scratchpad ?? !!agentDefs?.output;
	let artifact: CreatedScratchpad | null = null;
	if (wantsScratchpad) {
		artifact = await preCreateArtifactScratchpad(
			client,
			buildArtifactScratchpadName(params.agent, params.name),
			params.agent,
			params.task,
		);
	}

	const identity = agentDefs?.body ?? params.systemPrompt ?? null;
	const systemPromptMode = agentDefs?.systemPromptMode;
	const identityInSystemPrompt = systemPromptMode && identity;
	const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";

	const fullTask = launchBehavior.inheritsConversationContext
		? params.task
		: buildWrappedTask({
				task: params.task,
				roleBlock,
				autoExit,
				artifactScratchpadName: artifact?.name,
				artifactScratchpadId: artifact?.scratchpadId,
			});

	// ── Spawn the Solo terminal ──
	const tagged = labelForSurface(params.name, params.agent);
	const surface = await createSurface(client, tagged);
	// Rename in case Solo trimmed the prefix during spawn.
	await renameSurface(client, surface.processId, tagged);

	// Build the pi command
	const parts: string[] = ["pi"];
	parts.push("--session", shellEscape(subagentSessionFile));

	const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
	parts.push("-e", shellEscape(subagentDonePath));

	if (effectiveModel) {
		const model = effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel;
		parts.push("--model", shellEscape(model));
	}

	// System prompt — pass via file so multiline content survives the shell.
	if (identityInSystemPrompt && identity) {
		const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
		const spTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const spSafe = params.name
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		const sp = join(artifactDir, `context/${spSafe || "subagent"}-sysprompt-${spTs}.md`);
		mkdirSync(dirname(sp), { recursive: true });
		writeFileSync(sp, identity, "utf8");
		parts.push(flag, shellEscape(sp));
	}

	const denySet = resolveDenyTools(agentDefs);
	const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
	if (toolAllowlist) parts.push("--tools", shellEscape(toolAllowlist));

	// Env prefix: identity + config-dir propagation + deny list
	const envParts: string[] = [];
	if (localAgentDir && existsSync(localAgentDir)) {
		envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
	} else if (process.env.PI_CODING_AGENT_DIR) {
		envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
	}
	if (denySet.size > 0) {
		envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
	}
	envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
	if (params.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
	if (autoExit) envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
	envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
	envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
	envParts.push(`PI_SUBAGENT_SOLO_PROCESS=${surface.processId}`);
	if (artifact?.name) {
		envParts.push(`PI_SUBAGENT_ARTIFACT_SCRATCHPAD=${shellEscape(artifact.name)}`);
	}
	if (artifact?.scratchpadId != null) {
		envParts.push(`PI_SUBAGENT_ARTIFACT_SCRATCHPAD_ID=${artifact.scratchpadId}`);
	}
	const envPrefix = envParts.join(" ") + " ";

	// Build positional args (task + optional skill prompts).
	let taskArg: string;
	if (launchBehavior.taskDelivery === "direct") {
		taskArg = fullTask;
	} else {
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const safe = params.name
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		const artifactPath = join(artifactDir, `context/${safe || "subagent"}-${ts}.md`);
		mkdirSync(dirname(artifactPath), { recursive: true });
		writeFileSync(artifactPath, fullTask, "utf8");
		taskArg = `@${artifactPath}`;
	}

	for (const arg of buildPiPromptArgs({
		effectiveSkills,
		taskDelivery: launchBehavior.taskDelivery,
		taskArg,
	})) {
		parts.push(shellEscape(arg));
	}

	const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
	const piCommand = cdPrefix + envPrefix + parts.join(" ");
	const command = `${piCommand}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;

	const scriptName = `${
		(params.name || "subagent")
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "subagent"
	}-${id}.sh`;
	const launchScriptFile = join(artifactDir, "subagent-scripts", scriptName);

	const scriptPath = await sendLongCommand(client, surface.processId, command, {
		scriptPath: launchScriptFile,
		scriptPreamble: [
			`# Solo subagent launch script for ${params.name}`,
			`# Generated: ${new Date().toISOString()}`,
			`# Session:   ${subagentSessionFile}`,
			`# Solo PID:  ${surface.processId}`,
			...(artifact
				? [
						`# Artifact:  ${artifact.name}${artifact.scratchpadId != null ? ` (#${artifact.scratchpadId})` : ""}`,
					]
				: []),
		].join("\n"),
	});

	const running: RunningSubagent = {
		id,
		name: params.name,
		task: params.task,
		agent: params.agent,
		processId: surface.processId,
		startTime,
		sessionFile: subagentSessionFile,
		launchScriptFile: scriptPath,
		interactive: effectiveInteractive,
		runtimeState: "starting",
		artifactScratchpadName: artifact?.name,
		artifactScratchpadId: artifact?.scratchpadId,
		closeOnDone: !effectiveInteractive,
	};
	runningSubagents.set(id, running);
	return running;
}

function exitStatusVar(): string {
	const shell = process.env.SHELL ?? "";
	return shell.endsWith("/fish") || shell === "fish" ? "$status" : "$?";
}

function labelForSurface(name: string, agent?: string): string {
	const agentTag = agent ? `[${agent}] ` : "🤖 ";
	return `${agentTag}${name}`;
}

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
	const requested = (effectiveTools ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	if (requested.length === 0) return null;
	const allow = new Set(requested);
	for (const tool of SUBAGENT_CONTROL_TOOLS) allow.add(tool);
	return [...allow].join(",");
}

function buildPiPromptArgs(params: {
	effectiveSkills?: string;
	taskDelivery: "direct" | "artifact";
	taskArg: string;
}): string[] {
	const skillPrompts = (params.effectiveSkills ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);

	const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;
	return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

async function watchSubagent(
	client: SoloMcpLike,
	running: RunningSubagent,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const { name, task, sessionFile, startTime, processId } = running;
	try {
		const result = await pollForExit(
			client,
			processId,
			AbortSignal.any([signal, getModuleAbortSignal()]),
			{
				interval: 1000,
				sessionFile,
				onTick() {
					// noop — widget poll handles the runtime state refresh
				},
			},
		);

		const elapsed = Math.floor((Date.now() - startTime) / 1000);

		// Extract summary from session file (final assistant message).
		let summary: string;
		if (existsSync(sessionFile)) {
			const allEntries = getNewEntries(sessionFile, 0);
			summary =
				findLastAssistantMessage(allEntries) ??
				(result.errorMessage
					? `Subagent error: ${result.errorMessage}`
					: result.exitCode !== 0
						? `Sub-agent exited with code ${result.exitCode}`
						: "Sub-agent exited without output");
		} else {
			summary = result.errorMessage
				? `Subagent error: ${result.errorMessage}`
				: result.exitCode !== 0
					? `Sub-agent exited with code ${result.exitCode}`
					: "Sub-agent exited without output";
		}

		if (running.closeOnDone) {
			await closeSurface(client, processId);
		}
		runningSubagents.delete(running.id);

		return {
			name,
			task,
			summary,
			sessionFile,
			exitCode: result.exitCode,
			elapsed,
			ping: result.ping,
			artifactScratchpadName: running.artifactScratchpadName,
			artifactScratchpadId: running.artifactScratchpadId,
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		};
	} catch (err: any) {
		try {
			if (running.closeOnDone) await closeSurface(client, processId);
		} catch {}
		runningSubagents.delete(running.id);
		if (signal.aborted) {
			return {
				name,
				task,
				summary: "Subagent cancelled.",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				error: "cancelled",
				sessionFile,
			};
		}
		return {
			name,
			task,
			summary: `Subagent error: ${err?.message ?? String(err)}`,
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			error: err?.message ?? String(err),
			sessionFile,
		};
	}
}

export function resolveResultPresentation(
	result: Pick<
		SubagentResult,
		| "exitCode"
		| "elapsed"
		| "summary"
		| "sessionFile"
		| "errorMessage"
		| "artifactScratchpadName"
		| "artifactScratchpadId"
	>,
	name: string,
): string {
	const sessionRef = result.sessionFile
		? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
		: "";
	const artifactRef = result.artifactScratchpadName
		? `\n\nArtifact scratchpad: ${result.artifactScratchpadName}${
				result.artifactScratchpadId != null ? ` (id ${result.artifactScratchpadId})` : ""
			}`
		: "";

	if (result.errorMessage) {
		return (
			`Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent or resume the session with solo_subagent_resume.${sessionRef}${artifactRef}`
		);
	}

	return result.exitCode !== 0
		? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}${artifactRef}`
		: `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}${artifactRef}`;
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
	if (!requestedName) {
		return { error: "Provide a running subagent id or exact display name." };
	}
	const matches = Array.from(runningSubagents.values()).filter((r) => r.name === requestedName);
	if (matches.length === 1) return { running: matches[0]! };
	if (matches.length === 0) return { error: `No running subagent named "${requestedName}".` };
	const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
	return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

// ── Public entry point ──────────────────────────────────────────────────

export interface SoloSubagentDeps {
	client: SoloMcpLike;
	isClientReady: () => boolean;
}

export function initSoloSubagents(pi: ExtensionAPI, deps: SoloSubagentDeps) {
	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			(globalThis as any)[WIDGET_INTERVAL_KEY] = null;
		}
		const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
		if (moduleAbort) moduleAbort.abort();
		for (const [, agent] of runningSubagents) agent.abortController?.abort();
		runningSubagents.clear();
	});

	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const shouldRegister = (name: string) => !deniedTools.has(name);

	// ── solo_subagent ──
	if (shouldRegister("solo_subagent"))
		pi.registerTool({
			name: "solo_subagent",
			label: "Solo Subagent",
			description:
				"Spawn a sub-agent in a dedicated Solo terminal pane. " +
				"This is a fire-and-forget async tool: the call returns immediately. " +
				"When the sub-agent finishes, its result is automatically delivered as a steer message that wakes you up. " +
				"Artifacts (plans, specs, context documents, reports) are saved to Solo scratchpads — the orchestrator pre-creates one and passes its name to the subagent. " +
				"DO NOT poll, sleep, or check status — the harness handles delivery. " +
				"DO NOT fabricate results — you have no idea what the sub-agent will produce.",
			promptSnippet:
				"Spawn a Solo-native sub-agent. Fire-and-forget: returns immediately, result steered back when done. " +
				"Use for scout/worker/reviewer/planner agents. Artifacts go to Solo scratchpads.",
			parameters: SubagentParams,

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const currentAgent = process.env.PI_SUBAGENT_AGENT;
				if (params.agent && currentAgent && params.agent === currentAgent) {
					return {
						content: [
							{
								type: "text",
								text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
							},
						],
						details: { error: "self-spawn blocked" },
					};
				}

				if (!deps.isClientReady()) {
					return muxUnavailableResult(
						"Solo MCP not ready — make sure Solo is running and MCP is enabled (Settings → MCP).",
					);
				}
				if (!ctx.sessionManager.getSessionFile()) {
					return muxUnavailableResult(
						"No pi session file. Start pi with a persistent session to use Solo subagents.",
					);
				}

				const running = await launchSubagent(deps.client, params, ctx);

				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;

				startWidgetRefresh(deps.client);

				watchSubagent(deps.client, running, watcherAbort.signal)
					.then((result) => {
						updateWidget();
						if (result.ping) {
							const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
							pi.sendMessage(
								{
									customType: "solo_subagent_ping",
									content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
									display: true,
									details: {
										name: result.ping.name,
										message: result.ping.message,
										agent: running.agent,
										sessionFile: result.sessionFile,
									},
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
							return;
						}
						const presentation = resolveResultPresentation(result, running.name);
						pi.sendMessage(
							{
								customType: "solo_subagent_result",
								content: presentation,
								display: true,
								details: {
									name: running.name,
									task: running.task,
									agent: running.agent,
									exitCode: result.exitCode,
									elapsed: result.elapsed,
									sessionFile: result.sessionFile,
									processId: running.processId,
									artifactScratchpadName: result.artifactScratchpadName,
									artifactScratchpadId: result.artifactScratchpadId,
									...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
								},
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
					})
					.catch((err) => {
						updateWidget();
						pi.sendMessage(
							{
								customType: "solo_subagent_result",
								content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
								display: true,
								details: { name: running.name, task: running.task, error: err?.message },
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
					});

				return {
					content: [
						{
							type: "text",
							text:
								`Sub-agent "${params.name}" launched in Solo pane #${running.processId}. ` +
								`It will run in the background; the result will be delivered to you automatically as a steer message when it finishes. ` +
								(running.artifactScratchpadName
									? `Its artifact will land in Solo scratchpad "${running.artifactScratchpadName}"${running.artifactScratchpadId != null ? ` (id ${running.artifactScratchpadId})` : ""}. `
									: "") +
								`Do NOT poll or guess results. Either work on other things or end your turn.`,
						},
					],
					details: {
						id: running.id,
						name: params.name,
						task: params.task,
						agent: params.agent,
						processId: running.processId,
						sessionFile: running.sessionFile,
						launchScriptFile: running.launchScriptFile,
						artifactScratchpadName: running.artifactScratchpadName,
						artifactScratchpadId: running.artifactScratchpadId,
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
				const cwdHint =
					typeof partial.cwd === "string" && partial.cwd
						? theme.fg("dim", ` in ${partial.cwd}`)
						: "";
				let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;
				if (task) {
					const first = task.split("\n").find((l: string) => l.trim()) ?? "";
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
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", ` — started (Solo #${details.processId})`) +
							artifactTag,
						0,
						0,
					);
				}
				const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
				return new Text(theme.fg("dim", text), 0, 0);
			},
		});

	// ── solo_subagent_interrupt ──
	if (shouldRegister("solo_subagent_interrupt"))
		pi.registerTool({
			name: "solo_subagent_interrupt",
			label: "Interrupt Solo Subagent",
			description:
				"Send Escape to a running Solo subagent. " +
				"The Solo pane, session, watcher, and registry entry stay alive; this only interrupts the active turn.",
			promptSnippet:
				"Interrupt the active turn of a running Solo subagent without killing the session.",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
				name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
			}),
			async execute(_toolCallId, params) {
				const resolved = resolveInterruptTarget(params);
				if ("error" in resolved) {
					return {
						content: [{ type: "text", text: resolved.error }],
						details: { error: resolved.error },
					};
				}
				const running = resolved.running;
				try {
					await sendEscape(deps.client, running.processId);
					return {
						content: [
							{ type: "text", text: `Interrupt requested for subagent "${running.name}".` },
						],
						details: { id: running.id, name: running.name, status: "interrupt_requested" },
					};
				} catch (err: any) {
					return {
						content: [
							{ type: "text", text: `Failed to send Escape: ${err?.message ?? String(err)}` },
						],
						details: { id: running.id, name: running.name, error: err?.message },
					};
				}
			},
			renderResult(result, _opts, theme) {
				const details = result.details as any;
				if (details?.status === "interrupt_requested") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
							theme.fg("dim", " — interrupt requested"),
						0,
						0,
					);
				}
				const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
				return new Text(theme.fg("dim", text), 0, 0);
			},
		});

	// ── solo_subagents_list ──
	if (shouldRegister("solo_subagents_list"))
		pi.registerTool({
			name: "solo_subagents_list",
			label: "List Solo Subagent Definitions",
			description:
				"List all available subagent definitions. " +
				"Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
				"Project-local agents override global ones with the same name.",
			promptSnippet:
				"List the agent definitions available to solo_subagent (scout, worker, planner, …).",
			parameters: Type.Object({}),
			async execute() {
				const list = discoverAgentDefinitions().filter((a) => !a.disableModelInvocation);
				if (list.length === 0) {
					return {
						content: [{ type: "text", text: "No subagent definitions found." }],
						details: { agents: [] },
					};
				}
				const lines = list.map((a) => {
					const badge = a.source === "project" ? " (project)" : "";
					const desc = a.description ? ` — ${a.description}` : "";
					const model = a.model ? ` [${a.model}]` : "";
					return `• ${a.name}${badge}${model}${desc}`;
				});
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agents: list },
				};
			},
		});

	// ── solo_subagent_resume ──
	if (shouldRegister("solo_subagent_resume"))
		pi.registerTool({
			name: "solo_subagent_resume",
			label: "Resume Solo Subagent",
			description:
				"Resume a previous sub-agent session in a new Solo pane. " +
				"Fire-and-forget; result is delivered as a steer message when the resumed session finishes.",
			promptSnippet: "Resume a cancelled or completed Solo subagent session in a new Solo pane.",
			parameters: Type.Object({
				sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
				name: Type.Optional(Type.String({ description: "Display name. Default: 'Resume'" })),
				message: Type.Optional(
					Type.String({ description: "Optional follow-up message to send after resuming" }),
				),
				autoExit: Type.Optional(
					Type.Boolean({
						description:
							"Whether the resumed session should auto-exit after completing its response. Defaults to true.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!deps.isClientReady()) {
					return muxUnavailableResult("Solo MCP not ready.");
				}
				if (!existsSync(params.sessionPath)) {
					return {
						content: [
							{ type: "text", text: `Error: session file not found: ${params.sessionPath}` },
						],
						details: { error: "session not found" },
					};
				}
				const name = params.name ?? "Resume";
				const autoExit = params.autoExit ?? true;
				const interactive = !autoExit;
				const id = Math.random().toString(16).slice(2, 10);
				const startTime = Date.now();
				const entryCountBefore = readEntryCount(params.sessionPath);

				const surface = await createSurface(deps.client, labelForSurface(name));
				await renameSurface(deps.client, surface.processId, labelForSurface(name));

				const parts = ["pi", "--session", shellEscape(params.sessionPath)];
				const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
				parts.push("-e", shellEscape(subagentDonePath));

				let resumeMsgFile: string | undefined;
				const sessionId = ctx.sessionManager.getSessionId();
				const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
				if (params.message) {
					const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
					resumeMsgFile = join(
						artifactDir,
						"subagent-resume",
						`${
							name
								.toLowerCase()
								.replace(/[^a-z0-9\s-]/g, "")
								.replace(/\s+/g, "-")
								.replace(/-+/g, "-")
								.replace(/^-|-$/g, "") || "resume"
						}-${ts}.md`,
					);
					mkdirSync(dirname(resumeMsgFile), { recursive: true });
					writeFileSync(resumeMsgFile, params.message, "utf8");
					parts.push(shellEscape(`@${resumeMsgFile}`));
				}

				const envParts: string[] = [];
				if (process.env.PI_CODING_AGENT_DIR) {
					envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
				}
				envParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
				envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
				envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
				envParts.push(`PI_SUBAGENT_SOLO_PROCESS=${surface.processId}`);
				if (autoExit) envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
				const envPrefix = envParts.join(" ") + " ";

				const command = `${envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
				const launchScriptFile = join(
					artifactDir,
					"subagent-scripts",
					`${
						name
							.toLowerCase()
							.replace(/[^a-z0-9\s-]/g, "")
							.replace(/\s+/g, "-")
							.replace(/-+/g, "-")
							.replace(/^-|-$/g, "") || "resume"
					}-resume-${Date.now()}.sh`,
				);
				const scriptPath = await sendLongCommand(deps.client, surface.processId, command, {
					scriptPath: launchScriptFile,
					scriptPreamble: [
						`# Solo subagent resume script for ${name}`,
						`# Generated: ${new Date().toISOString()}`,
						`# Session:   ${params.sessionPath}`,
						`# Solo PID:  ${surface.processId}`,
						...(resumeMsgFile ? [`# Message:   ${resumeMsgFile}`] : []),
					].join("\n"),
				});

				const running: RunningSubagent = {
					id,
					name,
					task: params.message ?? "resumed session",
					processId: surface.processId,
					startTime,
					sessionFile: params.sessionPath,
					launchScriptFile: scriptPath,
					interactive,
					runtimeState: "starting",
					closeOnDone: !interactive,
				};
				runningSubagents.set(id, running);
				startWidgetRefresh(deps.client);

				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;

				watchSubagent(deps.client, running, watcherAbort.signal)
					.then((result) => {
						updateWidget();
						if (result.ping) {
							const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
							pi.sendMessage(
								{
									customType: "solo_subagent_ping",
									content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
									display: true,
									details: {
										name: result.ping.name,
										message: result.ping.message,
										sessionFile: params.sessionPath,
									},
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
							return;
						}
						const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
						const summary =
							findLastAssistantMessage(allEntries) ??
							(result.errorMessage
								? `Subagent error: ${result.errorMessage}`
								: result.exitCode !== 0
									? `Resumed session exited with code ${result.exitCode}`
									: "Resumed session exited without new output");
						const presentation = resolveResultPresentation(
							{ ...result, summary, sessionFile: params.sessionPath },
							name,
						);
						pi.sendMessage(
							{
								customType: "solo_subagent_result",
								content: presentation,
								display: true,
								details: {
									name,
									task: params.message ?? "resumed session",
									exitCode: result.exitCode,
									elapsed: result.elapsed,
									sessionFile: params.sessionPath,
									processId: surface.processId,
									...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
								},
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
					})
					.catch((err) => {
						updateWidget();
						pi.sendMessage(
							{
								customType: "solo_subagent_result",
								content: `Resume error: ${err?.message ?? String(err)}`,
								display: true,
								details: { name, error: err?.message },
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
					});

				return {
					content: [
						{ type: "text", text: `Session "${name}" resumed in Solo pane #${surface.processId}.` },
					],
					details: {
						id,
						name,
						sessionPath: params.sessionPath,
						processId: surface.processId,
						launchScriptFile: scriptPath,
						status: "started",
					},
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

	// ── /solo-iterate ──
	pi.registerCommand("solo-iterate", {
		description: "Fork session into a Solo subagent for focused work (bugfixes, iteration)",
		handler: async (args, _ctx) => {
			const task = args.trim();
			const toolCall = task
				? `Use solo_subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
				: `Use solo_subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
			pi.sendUserMessage(toolCall);
		},
	});

	// ── Custom message renderers ─────────────────────────────────────────

	pi.registerMessageRenderer("solo_subagent_result", (message, options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;
		return {
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
				const failed = exitCode !== 0 || !!errorMessage;
				const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
				const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const status = errorMessage
					? "failed (provider/agent error)"
					: failed
						? `failed (exit ${exitCode})`
						: "completed";
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const processTag =
					details.processId != null ? theme.fg("dim", ` · Solo #${details.processId}`) : "";
				const artifactTag = details.artifactScratchpadName
					? theme.fg("accent", ` · 📝 ${details.artifactScratchpadName}`)
					: "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${processTag}${artifactTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent = typeof message.content === "string" ? message.content : "";

				const summary = rawContent
					.replace(/\n\nSession: .+\nResume: .+(\n\nArtifact scratchpad: .+)?$/s, "")
					.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
					.replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

				const contentLines = [header];

				if (options.expanded) {
					if (summary) {
						for (const line of summary.split("\n")) contentLines.push(line.slice(0, width - 6));
					}
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
						contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
					}
					if (details.artifactScratchpadName) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Artifact: ${details.artifactScratchpadName}`) +
								(details.artifactScratchpadId != null
									? theme.fg("dim", ` (id ${details.artifactScratchpadId})`)
									: ""),
						);
					}
				} else {
					if (summary) {
						const preview = summary.split("\n").slice(0, 5);
						for (const line of preview)
							contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
						const totalLines = summary.split("\n").length;
						if (totalLines > 5)
							contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
					}
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer("solo_subagent_ping", (message, options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;
		return {
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);
				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;
				const contentLines = [header];
				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.message ?? "");
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
					}
				} else {
					const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}

// Exported for tests
export const __test__ = {
	buildArtifactScratchpadName,
	buildPiPromptArgs,
	buildSubagentToolAllowlist,
	buildWrappedTask,
	discoverAgentDefinitions,
	labelForSurface,
	loadAgentDefaults,
	parseAgentDefinition,
	renderSubagentWidgetLines,
	resolveDenyTools,
	resolveEffectiveInteractive,
	resolveEffectiveSessionMode,
	resolveInterruptTarget,
	resolveLaunchBehavior,
	resolveResultPresentation,
	runningSubagents,
	formatElapsed,
};
