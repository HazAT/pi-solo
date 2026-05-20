/**
 * Unit tests for pi-solo.
 *
 * Covers the pure helpers (renderer subjects, markers, schema normalization,
 * content adapters, JSON extraction) plus a smoke test that the extension
 * module parses and exports a default factory function.
 *
 * Run:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	applyDirectToolDefaults,
	createSerialQueue,
	extractStructured,
	extractTextJson,
	firstLine,
	getDirectToolDescriptionOverride,
	getMcpToolExposure,
	getSoloToolCategory,
	humanizeToolLabel,
	lineCount,
	listSoloCatalogTools,
	markerFor,
	mcpContentToPi,
	normalizeInputSchema,
	parseToolSurfaceProfile,
	pickSubject,
	str,
	gatewayCallRequiresReason,
	isSoloFailureText,
	SHORTCUT_TOOLS,
} from "../pi-extension/solo/index.ts";
import {
	buildSoloTerminalNotificationCommand,
	buildTerminalNotificationSequence,
	detectTerminalNotificationMethod,
	notificationModeIncludes,
	parseSoloNotificationMode,
	sanitizeNotificationText,
	summarizeSubagentNotifications,
} from "../pi-extension/solo/notifications.ts";
import { formatExpandedToolResult, formatExpandedValue } from "../pi-extension/solo/rendering.ts";

// ---------------------------------------------------------------------------
// Solo tool surface policy

test("parseToolSurfaceProfile — defaults to core", () => {
	assert.equal(parseToolSurfaceProfile(undefined), "core");
	assert.equal(parseToolSurfaceProfile(""), "core");
	assert.equal(parseToolSurfaceProfile("unexpected"), "core");
});

test("parseToolSurfaceProfile — accepts known values case-insensitively", () => {
	assert.equal(parseToolSurfaceProfile("core"), "core");
	assert.equal(parseToolSurfaceProfile(" FULL "), "full");
	assert.equal(parseToolSurfaceProfile("minimal"), "minimal");
});

test("getMcpToolExposure — core exposes only handoff and todo essentials", () => {
	assert.equal(getMcpToolExposure("scratchpad_write", "core"), "direct");
	assert.equal(getMcpToolExposure("scratchpad_read", "core"), "direct");
	assert.equal(getMcpToolExposure("scratchpad_list", "core"), "direct");
	assert.equal(getMcpToolExposure("todo_create", "core"), "direct");
	assert.equal(getMcpToolExposure("todo_list", "core"), "direct");
	assert.equal(getMcpToolExposure("todo_update", "core"), "direct");
	assert.equal(getMcpToolExposure("todo_complete", "core"), "direct");
	assert.equal(getMcpToolExposure("scratchpad_append", "core"), "gateway");
	assert.equal(getMcpToolExposure("scratchpad_load_from_file", "core"), "gateway");
	assert.equal(getMcpToolExposure("todo_get", "core"), "gateway");
	assert.equal(getMcpToolExposure("todo_add_tag", "core"), "gateway");
	assert.equal(getMcpToolExposure("lock_acquire", "core"), "gateway");
	assert.equal(getMcpToolExposure("get_project_stats", "core"), "gateway");
	assert.equal(getMcpToolExposure("list_processes", "core"), "gateway");
	assert.equal(getMcpToolExposure("help", "core"), "gateway");
});

test("getMcpToolExposure — full exposes all and minimal exposes none", () => {
	assert.equal(getMcpToolExposure("get_project_stats", "full"), "direct");
	assert.equal(getMcpToolExposure("todo_create", "minimal"), "gateway");
});

test("getSoloToolCategory — groups common Solo MCP tools", () => {
	assert.equal(getSoloToolCategory("todo_create"), "todos");
	assert.equal(getSoloToolCategory("scratchpad_write"), "scratchpads");
	assert.equal(getSoloToolCategory("lock_acquire"), "locks");
	assert.equal(getSoloToolCategory("timer_set"), "timers");
	assert.equal(getSoloToolCategory("kv_get"), "kv");
	assert.equal(getSoloToolCategory("list_processes"), "processes");
	assert.equal(getSoloToolCategory("wait_for_bound_port"), "readiness");
	assert.equal(getSoloToolCategory("get_project_stats"), "inspection");
	assert.equal(getSoloToolCategory("help"), "docs");
	assert.equal(getSoloToolCategory("whoami"), "session");
});

// ---------------------------------------------------------------------------
// Solo notifications

test("parseSoloNotificationMode — accepts documented modes and aliases", () => {
	assert.equal(parseSoloNotificationMode(undefined), null);
	assert.equal(parseSoloNotificationMode("off"), "off");
	assert.equal(parseSoloNotificationMode("on"), "subagent");
	assert.equal(parseSoloNotificationMode("subagents"), "subagent");
	assert.equal(parseSoloNotificationMode("agent_end"), "agent-end");
	assert.equal(parseSoloNotificationMode("all"), "all");
	assert.equal(parseSoloNotificationMode("surprise"), null);
});

test("notificationModeIncludes — scopes subagent vs generic agent_end", () => {
	assert.equal(notificationModeIncludes("off", "subagent"), false);
	assert.equal(notificationModeIncludes("subagent", "subagent"), true);
	assert.equal(notificationModeIncludes("subagent", "agent-end"), false);
	assert.equal(notificationModeIncludes("agent-end", "subagent"), false);
	assert.equal(notificationModeIncludes("agent-end", "agent-end"), true);
	assert.equal(notificationModeIncludes("all", "subagent"), true);
	assert.equal(notificationModeIncludes("all", "agent-end"), true);
});

test("detectTerminalNotificationMethod — detects direct local protocols", () => {
	assert.equal(detectTerminalNotificationMethod({ TERM_PROGRAM: "solo" }, "darwin"), "osc777");
	assert.equal(detectTerminalNotificationMethod({ TERM: "xterm-ghostty" }, "linux"), "osc777");
	assert.equal(detectTerminalNotificationMethod({ KITTY_WINDOW_ID: "1" }, "linux"), "osc99");
	assert.equal(detectTerminalNotificationMethod({ ITERM_SESSION_ID: "abc" }, "darwin"), "osc9");
	assert.equal(detectTerminalNotificationMethod({}, "darwin"), "macos");
	assert.equal(detectTerminalNotificationMethod({}, "linux"), "unsupported");
});

test("buildTerminalNotificationSequence — sanitizes OSC delimiters", () => {
	const title = sanitizeNotificationText("Pi;\u001b\u0007Solo");
	assert.equal(title, "Pi Solo");
	const seq = buildTerminalNotificationSequence("osc777", "Pi;Solo", "ready\nnow");
	assert.equal(seq, "\x1b]777;notify;Pi Solo;ready now\x07");
});

test("buildSoloTerminalNotificationCommand — sends OSC 777 from a real Solo terminal", () => {
	assert.equal(
		buildSoloTerminalNotificationCommand("Pi;Solo", "worker's done"),
		`printf '%b' '\\033]777;notify;Pi Solo;worker'"'"'s done\\007'`,
	);
});

test("summarizeSubagentNotifications — names a single finished worker", () => {
	const summary = summarizeSubagentNotifications([
		{ kind: "done", processId: 42, name: "Worker: Todo 7", agent: "worker" },
	]);
	assert.equal(summary.title, "Solo agent ready");
	assert.match(summary.body, /Worker: Todo 7 \(worker\) finished in Solo #42/);
	assert.match(summary.body, /waiting for input/);
});

test("listSoloCatalogTools — defaults to gateway entries", () => {
	const tools = listSoloCatalogTools([
		{ name: "todo_create", description: "Create a todo" },
		{ name: "get_project_stats", description: "Return CPU and memory usage" },
	]);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["get_project_stats"],
	);
	assert.equal(tools[0].piName, "get_project_stats");
	assert.equal(tools[0].category, "inspection");
});

test("listSoloCatalogTools — can include direct tools and filter by query", () => {
	const tools = listSoloCatalogTools(
		[
			{ name: "todo_create", description: "Create a todo" },
			{ name: "scratchpad_write", description: "Write a scratchpad" },
			{ name: "get_project_stats", description: "Return CPU and memory usage" },
		],
		{ include: "direct", query: "scratch" },
	);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["scratchpad_write"],
	);
});

// ---------------------------------------------------------------------------
// humanizeToolLabel

test("humanizeToolLabel — single word", () => {
	assert.equal(humanizeToolLabel("spawn"), "Spawn");
});

test("humanizeToolLabel — snake_case", () => {
	assert.equal(humanizeToolLabel("spawn_process"), "Spawn Process");
	assert.equal(humanizeToolLabel("get_process_status"), "Get Process Status");
});

test("humanizeToolLabel — empty segments preserved", () => {
	assert.equal(humanizeToolLabel("foo__bar"), "Foo  Bar");
});

// ---------------------------------------------------------------------------
// str / firstLine / lineCount

test("str — passthrough short", () => {
	assert.equal(str("hello"), "hello");
});

test("str — truncates with ellipsis", () => {
	assert.equal(str("x".repeat(80), 10), "xxxxxxxxx\u2026");
});

test("str — handles null/undefined", () => {
	assert.equal(str(null), "");
	assert.equal(str(undefined), "");
});

test("firstLine — picks first non-empty line", () => {
	assert.equal(firstLine("\n\nhello\nworld"), "hello");
});

test("firstLine — truncates long lines", () => {
	assert.equal(firstLine("x".repeat(200), 12), "xxxxxxxxxxx\u2026");
});

test("lineCount — multi-line", () => {
	assert.equal(lineCount("a\nb\nc"), 3);
	assert.equal(lineCount(""), 1); // empty string is one line per split
	assert.equal(lineCount(null), 0);
});

// ---------------------------------------------------------------------------
// pickSubject — heuristic argument-to-subject extraction

test("pickSubject — process_name beats process_id", () => {
	assert.equal(pickSubject("send_input", { process_name: "worker", process_id: 13 }), "worker");
});

test("pickSubject — process_id prefixed with #", () => {
	assert.equal(pickSubject("send_input", { process_id: 13 }), "#13");
});

test("pickSubject — scratchpad_id", () => {
	assert.equal(pickSubject("scratchpad_read", { scratchpad_id: 7 }), "scratchpad #7");
});

test("pickSubject — todo_id", () => {
	assert.equal(pickSubject("todo_complete", { todo_id: 4 }), "todo #4");
});

test("pickSubject — timer_id", () => {
	assert.equal(pickSubject("timer_cancel", { timer_id: 2 }), "timer #2");
});

test("pickSubject — lock_key", () => {
	assert.equal(pickSubject("lock_acquire", { lock_key: "deploy" }), "deploy");
});

test("pickSubject — search pattern in quotes", () => {
	assert.equal(pickSubject("search_output", { pattern: "ERROR" }), '"ERROR"');
});

test("pickSubject — falls back to tool name when no subject", () => {
	assert.equal(pickSubject("list_processes", {}), "list_processes");
});

// ---------------------------------------------------------------------------
// markerFor — visual category marker per tool name

test("markerFor — spawn uses ▸", () => {
	assert.equal(markerFor("spawn_process"), "\u25b8");
});

test("markerFor — close/delete/stop uses ✘", () => {
	assert.equal(markerFor("close_process"), "\u2718");
	assert.equal(markerFor("scratchpad_delete"), "\u2718");
	assert.equal(markerFor("todo_delete"), "\u2718");
	assert.equal(markerFor("stop_process"), "\u2718");
});

test("markerFor — send_input uses ⏵", () => {
	assert.equal(markerFor("send_input"), "\u23f5");
});

test("markerFor — restart uses ↻", () => {
	assert.equal(markerFor("restart_process"), "\u21bb");
	assert.equal(markerFor("wait_for_bound_port"), "\u21bb");
});

test("markerFor — list/get/search use ○ (read)", () => {
	assert.equal(markerFor("list_processes"), "\u25cb");
	assert.equal(markerFor("get_process_status"), "\u25cb");
	assert.equal(markerFor("search_output"), "\u25cb");
	assert.equal(markerFor("whoami"), "\u25cb");
});

test("markerFor — write/update/create/tag use ✎", () => {
	assert.equal(markerFor("scratchpad_write"), "\u270e");
	assert.equal(markerFor("todo_update"), "\u270e");
	assert.equal(markerFor("todo_create"), "\u270e");
	assert.equal(markerFor("todo_add_tag"), "\u270e");
});

test("markerFor — unknown tool falls back to · ", () => {
	assert.equal(markerFor("something_totally_unknown"), "\u00b7");
});

// ---------------------------------------------------------------------------
// normalizeInputSchema

test("normalizeInputSchema — undefined produces empty object schema", () => {
	const out = normalizeInputSchema(undefined);
	assert.deepEqual(out, { type: "object", properties: {}, additionalProperties: true });
});

test("normalizeInputSchema — preserves properties and required", () => {
	const out = normalizeInputSchema({
		type: "object",
		properties: { name: { type: "string" } },
		required: ["name"],
	});
	assert.equal(out.type, "object");
	assert.deepEqual(out.properties, { name: { type: "string" } });
	assert.deepEqual(out.required, ["name"]);
});

test("normalizeInputSchema — drops empty required arrays", () => {
	const out = normalizeInputSchema({ type: "object", properties: {}, required: [] });
	assert.equal("required" in out, false);
});

test("normalizeInputSchema — preserves $defs, $schema, oneOf, anyOf", () => {
	const schema = {
		$schema: "http://json-schema.org/draft-07/schema",
		type: "object" as const,
		properties: { mode: { $ref: "#/$defs/Mode" } },
		$defs: { Mode: { enum: ["full", "headings"] } },
		required: ["mode"],
		additionalProperties: false,
	};
	const out = normalizeInputSchema(schema);
	assert.deepEqual((out as any)["$defs"], { Mode: { enum: ["full", "headings"] } });
	assert.equal((out as any)["$schema"], "http://json-schema.org/draft-07/schema");
	assert.deepEqual(out.required, ["mode"]);
});

test("getSoloToolCategory — identify_session is session", () => {
	assert.equal(getSoloToolCategory("identify_session"), "session");
});

test("getSoloToolCategory — project tools are projects", () => {
	assert.equal(getSoloToolCategory("create_project"), "projects");
	assert.equal(getSoloToolCategory("rename_project"), "projects");
	assert.equal(getSoloToolCategory("delete_project"), "projects");
	assert.equal(getSoloToolCategory("get_project"), "projects");
});

test("getSoloToolCategory — spawn_agent is processes", () => {
	assert.equal(getSoloToolCategory("spawn_agent"), "processes");
});

test("SHORTCUT_TOOLS — includes spawn_agent", () => {
	assert.equal(SHORTCUT_TOOLS.has("spawn_agent"), true);
});

test("gatewayCallRequiresReason — read-only tools do not need reason", () => {
	assert.equal(gatewayCallRequiresReason("identify_session"), false);
	assert.equal(gatewayCallRequiresReason("scratchpad_find"), false);
	assert.equal(gatewayCallRequiresReason("scratchpad_tail"), false);
	assert.equal(gatewayCallRequiresReason("scratchpad_tags_list"), false);
	assert.equal(gatewayCallRequiresReason("list_projects"), false);
});

test("gatewayCallRequiresReason — mutating tools require reason", () => {
	assert.equal(gatewayCallRequiresReason("scratchpad_edit"), true);
	assert.equal(gatewayCallRequiresReason("scratchpad_append_section"), true);
	assert.equal(gatewayCallRequiresReason("spawn_agent"), true);
	assert.equal(gatewayCallRequiresReason("create_project"), true);
	assert.equal(gatewayCallRequiresReason("rename_project"), true);
	assert.equal(gatewayCallRequiresReason("delete_project"), true);
});

// ---------------------------------------------------------------------------
// mcpContentToPi — adapts MCP content array to Pi's text-only content shape

test("mcpContentToPi — empty/missing → placeholder", () => {
	assert.deepEqual(mcpContentToPi(undefined), [{ type: "text", text: "(no content)" }]);
	assert.deepEqual(mcpContentToPi([]), [{ type: "text", text: "(no content)" }]);
});

test("mcpContentToPi — passes through text", () => {
	assert.deepEqual(mcpContentToPi([{ type: "text", text: "hello" }]), [
		{ type: "text", text: "hello" },
	]);
});

test("mcpContentToPi — replaces image with placeholder", () => {
	const out = mcpContentToPi([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
	assert.equal(out.length, 1);
	assert.match(out[0].text, /image content omitted/);
	assert.match(out[0].text, /image\/png/);
});

test("mcpContentToPi — embeds resource uri and text", () => {
	const out = mcpContentToPi([
		{ type: "resource", resource: { uri: "file:///foo", text: "body" } },
	]);
	assert.equal(out.length, 1);
	assert.match(out[0].text, /file:\/\/\/foo/);
	assert.match(out[0].text, /body/);
});

test("formatExpandedValue — pretty-prints JSON-looking strings", () => {
	assert.equal(formatExpandedValue("input", '{"a":1}'), 'input:\n{\n  "a": 1\n}');
});

test("formatExpandedToolResult — includes full content and non-duplicated metadata", () => {
	const text = formatExpandedToolResult({
		content: [{ type: "text", text: '{"scratchpad_id":7,"revision":2}' }],
		details: {
			mcpTool: "scratchpad_write",
			structuredContent: { scratchpad_id: 7, revision: 2 },
		},
	});
	assert.match(text, /content:/);
	assert.match(text, /"scratchpad_id": 7/);
	assert.match(text, /details:/);
	assert.match(text, /"mcpTool": "scratchpad_write"/);
	assert.doesNotMatch(text, /structuredContent/);
});

// ---------------------------------------------------------------------------
// extractTextJson / extractStructured

test("extractTextJson — parses first text content as JSON", () => {
	const r = {
		content: [{ type: "text" as const, text: JSON.stringify({ id: 42, name: "x" }) }],
	};
	assert.deepEqual(extractTextJson<any>(r), { id: 42, name: "x" });
});

test("extractTextJson — returns undefined when text isn't JSON", () => {
	const r = { content: [{ type: "text" as const, text: "just a string" }] };
	assert.equal(extractTextJson(r), undefined);
});

test("extractTextJson — undefined when no text content", () => {
	assert.equal(extractTextJson({ content: [] }), undefined);
	assert.equal(extractTextJson({} as any), undefined);
});

test("extractStructured — prefers structuredContent when present", () => {
	const r = {
		content: [{ type: "text" as const, text: "{}" }],
		structuredContent: { wrapped: true },
	};
	assert.deepEqual(extractStructured<any>(r), { wrapped: true });
});

test("extractStructured — undefined when missing", () => {
	assert.equal(extractStructured({ content: [] }), undefined);
});

// ---------------------------------------------------------------------------
// Smoke: extension module loads and exports a default factory

test("smoke — extension module exports default function", async () => {
	const mod = await import("../pi-extension/solo/index.ts");
	assert.equal(typeof mod.default, "function", "expected default export to be a factory function");
});

// ---------------------------------------------------------------------------
// Solo-native subagents: agent definitions, task wrapping, wake-up timers

import {
	__test__ as subagents,
	buildArtifactScratchpadName,
	buildPiExtraArgs,
	buildWakeBody,
	buildWrappedTask,
	parseAgentDefinition,
	resolveEffectiveInteractive,
} from "../pi-extension/solo/subagents/index.ts";
import {
	createAgentSurface,
	getAgentProcessState,
	resetResolvedPiAgentToolIdForTests,
	resolvePiAgentToolId,
	scheduleIdleWake,
	waitForAgentBusy,
	waitForAgentReady,
} from "../pi-extension/solo/subagents/solo-surface.ts";

function mockClient(handlers: Record<string, any>) {
	const calls: Array<{ name: string; args: unknown }> = [];
	return {
		calls,
		async callTool(name: string, args: unknown) {
			calls.push({ name, args });
			const handler = handlers[name];
			if (typeof handler === "function") return await handler(args, calls.length);
			if (handler) return handler;
			throw new Error(`unexpected tool call: ${name}`);
		},
	};
}

function structured(value: unknown) {
	return { structuredContent: value };
}

test("parseAgentDefinition — returns null without frontmatter", () => {
	assert.equal(parseAgentDefinition("# no frontmatter here", "foo"), null);
});

test("parseAgentDefinition — reads honored fields and tolerates ignored v1 fields", () => {
	const src = `---
name: scout
description: fast reconnaissance
model: anthropic/claude-haiku-4-5
tools: read, bash
auto-exit: true
spawning: false
output: context.md
system-prompt: append
---

# Scout Agent

Body goes here.
`;
	const def = parseAgentDefinition(src, "scout")!;
	assert.equal(def.name, "scout");
	assert.equal(def.description, "fast reconnaissance");
	assert.equal(def.model, "anthropic/claude-haiku-4-5");
	assert.equal(def.tools, "read, bash");
	assert.equal(def.autoExit, true);
	assert.equal(def.spawning, false);
	assert.equal(def.output, "context.md");
	assert.equal(def.systemPromptMode, "append");
	assert.match(def.body ?? "", /Body goes here/);
});

test("parseAgentDefinition — fallback name when frontmatter omits it", () => {
	const src = `---
description: nameless
---
Body`;
	const def = parseAgentDefinition(src, "fallback-name")!;
	assert.equal(def.name, "fallback-name");
});

test("parseAgentDefinition — reads interactive true", () => {
	const def = parseAgentDefinition("---\ninteractive: true\n---\nBody", "planner")!;
	assert.equal(def.interactive, true);
});

test("parseAgentDefinition — reads output false as tolerated string", () => {
	const def = parseAgentDefinition("---\noutput: false\n---\nBody", "noop")!;
	assert.equal(def.output, "false");
});

// ---------------------------------------------------------------------------
// effective interactivity / scratchpad defaults

test("resolveEffectiveInteractive — param wins over agent", () => {
	assert.equal(resolveEffectiveInteractive({ interactive: false }, { interactive: true }), false);
	assert.equal(resolveEffectiveInteractive({ interactive: true }, { interactive: false }), true);
});

test("resolveEffectiveInteractive — defaults to autonomous", () => {
	assert.equal(resolveEffectiveInteractive({}, { autoExit: false }), false);
	assert.equal(resolveEffectiveInteractive({}, null), false);
});

test("wantsScratchpad — defaults to true", () => {
	assert.equal(subagents.wantsScratchpad({}, null), true);
});

test("wantsScratchpad — output:false opts out unless param overrides", () => {
	assert.equal(subagents.wantsScratchpad({}, { output: "false" }), false);
	assert.equal(subagents.wantsScratchpad({ scratchpad: true }, { output: "false" }), true);
	assert.equal(subagents.wantsScratchpad({ scratchpad: false }, null), false);
});

// ---------------------------------------------------------------------------
// buildArtifactScratchpadName / buildWrappedTask / buildWakeBody

test("buildArtifactScratchpadName — sanitizes agent + name", () => {
	const stamped = buildArtifactScratchpadName("Planner!", "Refactor login flow");
	assert.match(stamped, /^planner\/\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-refactor-login-flow$/i);
});

test("buildArtifactScratchpadName — falls back when agent missing", () => {
	const stamped = buildArtifactScratchpadName(undefined, "");
	assert.match(stamped, /^subagent\/\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-task$/i);
});

test("buildWrappedTask — includes Solo instructions, role, task, and stop instruction", () => {
	const wrapped = buildWrappedTask({
		agentInstructions: "[SOLO ORCHESTRATION CONTEXT]",
		roleBlock: "You are Scout.",
		task: "Map the auth module.",
	});
	assert.match(wrapped, /SOLO ORCHESTRATION CONTEXT/);
	assert.match(wrapped, /You are Scout\./);
	assert.match(wrapped, /Map the auth module\./);
	assert.match(wrapped, /simply stop and wait/);
	assert.doesNotMatch(wrapped, /subagent_done/);
	assert.doesNotMatch(wrapped, /auto-exit/i);
});

test("buildWrappedTask — omits artifact block without scratchpad", () => {
	const wrapped = buildWrappedTask({ task: "do the thing" });
	assert.doesNotMatch(wrapped, /Artifact \(Solo scratchpad\)/);
});

test("buildWrappedTask — includes scratchpad id and retry-on-mismatch guidance without revision", () => {
	const wrapped = buildWrappedTask({
		task: "do the thing",
		artifactScratchpadName: "planner/2026-05-13-plan",
		artifactScratchpadId: 42,
	});
	assert.match(wrapped, /Artifact \(Solo scratchpad\)/);
	assert.match(wrapped, /planner\/2026-05-13-plan/);
	assert.match(wrapped, /scratchpad_id: 42/);
	assert.doesNotMatch(wrapped, /expected_revision: \d+/);
	assert.match(wrapped, /revision-mismatch/);
	assert.match(wrapped, /retry once/);
	assert.doesNotMatch(wrapped, /subagent_done/);
});

test("buildWrappedTask — includes expected_revision when pre-created scratchpad revision is known", () => {
	const wrapped = buildWrappedTask({
		task: "do the thing",
		artifactScratchpadName: "worker/2026-05-13-plan",
		artifactScratchpadId: 42,
		artifactScratchpadRevision: 1,
	});
	assert.match(wrapped, /Artifact \(Solo scratchpad\)/);
	assert.match(wrapped, /scratchpad_id: 42/);
	assert.match(wrapped, /expected_revision: 1/);
	assert.match(wrapped, /revision-mismatch/);
	assert.match(wrapped, /retry once/);
	assert.doesNotMatch(wrapped, /you do not need expected_revision/);
});

test("buildWrappedTask — interactive variant tells child to wait for continuation", () => {
	const wrapped = buildWrappedTask({ task: "plan", interactive: true });
	assert.match(wrapped, /interactive subagent/);
	assert.match(wrapped, /wait in this pane/);
});

test("buildWakeBody — autonomous marker includes ids and close instruction", () => {
	const body = buildWakeBody({
		subagentName: "E2E Worker",
		agent: "worker",
		processId: 32,
		scratchpadId: 4,
		scratchpadName: "worker/result",
		interactive: false,
	});
	assert.match(
		body,
		/^\[pi-solo:subagent-done id=32 scratchpad=4 name="E2E Worker" agent="worker"\]/,
	);
	assert.match(body, /scratchpad_read\(scratchpad_id=4\)/);
	assert.match(body, /solo_tool\(\{ action: "call", name: "get_process_output"/);
	assert.match(body, /solo_tool\(\{ action: "call", name: "send_input"/);
	assert.match(body, /reason: "resume subagent after premature idle wake"/);
	assert.match(body, /solo_tool\(\{ action: "call", name: "close_process"/);
	assert.match(body, /reason: "close completed subagent pane"/);
});

test("buildWakeBody — interactive marker tells parent not to close", () => {
	const body = buildWakeBody({
		subagentName: "Planner",
		processId: 12,
		scratchpadName: "planner/spec",
		interactive: true,
	});
	assert.match(body, /^\[pi-solo:subagent-interactive-ready id=12 name="Planner"\]/);
	assert.match(body, /Do not close this pane automatically/);
	assert.doesNotMatch(body, /close_process/);
	assert.doesNotMatch(body, /name: "close_process"/);
});

test("buildWakeBody — escapes marker quotes", () => {
	const body = buildWakeBody({ subagentName: 'A "quoted" name', processId: 1, interactive: false });
	assert.match(body, /name="A \\"quoted\\" name"/);
});

// ---------------------------------------------------------------------------
// solo-surface helpers

test("resolvePiAgentToolId — selects enabled tool whose command is pi", async () => {
	resetResolvedPiAgentToolIdForTests();
	const client = mockClient({
		list_agent_tools: structured([
			{ id: 2, name: "Other", command: "other", enabled: true },
			{ id: 8, name: "Pi", command: "pi", enabled: true },
		]),
	});
	assert.equal(await resolvePiAgentToolId(client), 8);
});

test("resolvePiAgentToolId — falls back to tool named Pi", async () => {
	resetResolvedPiAgentToolIdForTests();
	const client = mockClient({
		list_agent_tools: structured([{ id: 9, name: "Pi", command: "wrapped-pi", enabled: true }]),
	});
	assert.equal(await resolvePiAgentToolId(client), 9);
});

test("resolvePiAgentToolId — ignores disabled Pi tool", async () => {
	resetResolvedPiAgentToolIdForTests();
	const client = mockClient({
		list_agent_tools: structured([{ id: 1, name: "Pi", command: "pi", enabled: false }]),
	});
	await assert.rejects(() => resolvePiAgentToolId(client), /add a Generic agent tool/);
});

test("resolvePiAgentToolId — caches after first lookup", async () => {
	resetResolvedPiAgentToolIdForTests();
	const client = mockClient({
		list_agent_tools: structured([{ id: 8, name: "Pi", command: "pi", enabled: true }]),
	});
	assert.equal(await resolvePiAgentToolId(client), 8);
	assert.equal(await resolvePiAgentToolId(client), 8);
	assert.equal(client.calls.filter((call) => call.name === "list_agent_tools").length, 1);
});

test("scheduleIdleWake — returns timer id for scheduled timer", async () => {
	const client = mockClient({
		timer_fire_when_idle_any: structured({ timer_id: 12, status: "scheduled" }),
	});
	const result = await scheduleIdleWake(client, 32, 1000, "body");
	assert.equal(result.timerId, 12);
	assert.equal(result.alreadySatisfied, false);
	assert.deepEqual(client.calls[0], {
		name: "timer_fire_when_idle_any",
		args: { processes: [32], max_wait_ms: 1000, body: "body" },
	});
});

test("scheduleIdleWake — treats missing timer as already satisfied", async () => {
	const client = mockClient({
		timer_fire_when_idle_any: structured({ status: "already_satisfied" }),
	});
	const result = await scheduleIdleWake(client, 32, 1000, "body");
	assert.equal(result.timerId, undefined);
	assert.equal(result.alreadySatisfied, true);
});

test("waitForAgentReady — resolves when agent_state.idle flips true", async () => {
	let count = 0;
	const client = mockClient({
		get_process_status: () => {
			count += 1;
			return structured({ agent_state: { idle: count >= 2 } });
		},
	});
	await waitForAgentReady(client, 5, { initialDelayMs: 0, intervalMs: 1, timeoutMs: 100 });
	assert.equal(count, 2);
});

test("waitForAgentReady — times out with process id in error", async () => {
	const client = mockClient({ get_process_status: structured({ agent_state: { idle: false } }) });
	await assert.rejects(
		() => waitForAgentReady(client, 77, { initialDelayMs: 0, intervalMs: 1, timeoutMs: 5 }),
		/agent #77/,
	);
});

test("waitForAgentBusy — resolves true when idle flips false", async () => {
	let count = 0;
	const client = mockClient({
		get_process_status: () => {
			count += 1;
			return structured({ agent_state: { idle: count < 2 } });
		},
	});
	assert.equal(
		await waitForAgentBusy(client, 5, { initialDelayMs: 0, intervalMs: 1, timeoutMs: 100 }),
		true,
	);
	assert.equal(count, 2);
});

test("waitForAgentBusy — returns false when process stays idle", async () => {
	const client = mockClient({ get_process_status: structured({ agent_state: { idle: true } }) });
	assert.equal(
		await waitForAgentBusy(client, 5, { initialDelayMs: 0, intervalMs: 1, timeoutMs: 5 }),
		false,
	);
});

// ---------------------------------------------------------------------------
// internal helpers (via __test__)

test("labelForSurface — prefixes with agent badge", () => {
	assert.equal(subagents.labelForSurface("Refactor", "planner"), "[planner] Refactor");
	assert.match(subagents.labelForSurface("Refactor"), /^🤖 Refactor$/);
});

test("parseWakeMarker — extracts kind, processId, scratchpadId, name, agent", () => {
	assert.deepEqual(
		subagents.parseWakeMarker(
			'[pi-solo:subagent-done id=44 scratchpad=9 name="Scout" agent="scout"]',
		),
		{
			kind: "done",
			processId: 44,
			scratchpadId: 9,
			name: "Scout",
			agent: "scout",
		},
	);
});

test("parseWakeMarker — recognizes interactive wake marker", () => {
	assert.deepEqual(
		subagents.parseWakeMarker('[pi-solo:subagent-interactive-ready id=45 name="Planner"]'),
		{
			kind: "interactive-ready",
			processId: 45,
			scratchpadId: undefined,
			name: "Planner",
			agent: undefined,
		},
	);
});

test("parseWakeMarker — tolerates Solo's `[Solo timer #N]` prefix", () => {
	const input =
		'[Solo timer #8] [wait for any: idle detected in [scout] Scout: x (64)] [pi-solo:subagent-done id=64 scratchpad=13 name="Scout: smoketest" agent="scout"]\n\nSub-agent ...';
	const parsed = subagents.parseWakeMarker(input);
	assert.equal(parsed?.processId, 64);
	assert.equal(parsed?.scratchpadId, 13);
	assert.equal(parsed?.name, "Scout: smoketest");
	assert.equal(parsed?.agent, "scout");
});

test("parseWakeMarker — returns null for ordinary input", () => {
	assert.equal(subagents.parseWakeMarker("hello"), null);
});

test("buildShortWakeBody — done variant references scratchpad and close_process", () => {
	const body = subagents.buildShortWakeBody({
		kind: "done",
		processId: 64,
		name: "Scout: x",
		scratchpadId: 13,
	});
	assert.match(body, /Sub-agent "Scout: x"/);
	assert.match(body, /Solo agent #64/);
	assert.match(body, /scratchpad #13/);
	assert.match(body, /solo_tool.*close_process.*process_id.*64/s);
});

test("buildShortWakeBody — interactive variant tells parent to keep pane open", () => {
	const body = subagents.buildShortWakeBody({
		kind: "interactive-ready",
		processId: 70,
		name: "Planner: pr",
		scratchpadId: 7,
	});
	assert.match(body, /waiting in its Solo pane/);
	assert.match(body, /Do not close the pane automatically/);
	assert.doesNotMatch(body, /close_process/);
});

test("resolveInterruptTarget — error when no id/name", () => {
	const result = subagents.resolveInterruptTarget({});
	assert.ok("error" in result);
});

test("resolveInterruptTarget — error when id not found", () => {
	const result = subagents.resolveInterruptTarget({ id: "nope" });
	assert.ok("error" in result);
});

// ---------------------------------------------------------------------------
// subagent launch args

test("parseModelSpec — splits provider/model and tolerates whitespace", () => {
	assert.deepEqual(subagents.parseModelSpec("anthropic/claude-haiku-4-5"), {
		provider: "anthropic",
		modelId: "claude-haiku-4-5",
		thinking: undefined,
	});
	assert.deepEqual(subagents.parseModelSpec("  openai/gpt-5  "), {
		provider: "openai",
		modelId: "gpt-5",
		thinking: undefined,
	});
});

test("parseModelSpec — honors `:thinking` suffix when valid", () => {
	assert.deepEqual(subagents.parseModelSpec("anthropic/claude-opus-4-7:high"), {
		provider: "anthropic",
		modelId: "claude-opus-4-7",
		thinking: "high",
	});
});

test("parseModelSpec — drops invalid `:thinking` suffix", () => {
	const parsed = subagents.parseModelSpec("anthropic/claude-opus-4-7:bogus");
	assert.equal(parsed?.thinking, undefined);
	assert.equal(parsed?.modelId, "claude-opus-4-7");
});

test("parseModelSpec — returns null for malformed input", () => {
	assert.equal(subagents.parseModelSpec(undefined), null);
	assert.equal(subagents.parseModelSpec(""), null);
	assert.equal(subagents.parseModelSpec("no-slash"), null);
	assert.equal(subagents.parseModelSpec("/leading-slash"), null);
	assert.equal(subagents.parseModelSpec("trailing-slash/"), null);
});

test("normalizeThinkingLevel — accepts known levels case-insensitively", () => {
	assert.equal(subagents.normalizeThinkingLevel("low"), "low");
	assert.equal(subagents.normalizeThinkingLevel("  XHIGH "), "xhigh");
	assert.equal(subagents.normalizeThinkingLevel("off"), "off");
});

test("normalizeThinkingLevel — rejects unknown values", () => {
	assert.equal(subagents.normalizeThinkingLevel(undefined), null);
	assert.equal(subagents.normalizeThinkingLevel(""), null);
	assert.equal(subagents.normalizeThinkingLevel("extreme"), null);
});

// buildPiExtraArgs and createAgentSurface

test("buildPiExtraArgs — returns empty for null defs", () => {
	assert.deepEqual(buildPiExtraArgs(null), []);
});

test("buildPiExtraArgs — passes --model when model is set", () => {
	assert.deepEqual(buildPiExtraArgs({ model: "anthropic/claude-haiku-4-5" }), [
		"--model",
		"anthropic/claude-haiku-4-5",
	]);
});

test("buildPiExtraArgs — passes --thinking separately when no :thinking suffix in model", () => {
	assert.deepEqual(buildPiExtraArgs({ model: "anthropic/claude-haiku-4-5", thinking: "medium" }), [
		"--model",
		"anthropic/claude-haiku-4-5",
		"--thinking",
		"medium",
	]);
});

test("buildPiExtraArgs — skips standalone thinking when model has :thinking suffix", () => {
	assert.deepEqual(buildPiExtraArgs({ model: "anthropic/claude-opus-4-7:high", thinking: "low" }), [
		"--model",
		"anthropic/claude-opus-4-7:high",
	]);
});

test("buildPiExtraArgs — passes only --thinking when model is absent", () => {
	assert.deepEqual(buildPiExtraArgs({ thinking: "low" }), ["--thinking", "low"]);
});

test("buildPiExtraArgs — ignores invalid thinking level", () => {
	assert.deepEqual(buildPiExtraArgs({ thinking: "extreme" }), []);
});

test("buildSubagentLaunchArgs — appends --session after model args", () => {
	assert.deepEqual(
		subagents.buildSubagentLaunchArgs(
			{ model: "anthropic/claude-haiku-4-5", thinking: "low" },
			"/tmp/child.jsonl",
		),
		["--model", "anthropic/claude-haiku-4-5", "--thinking", "low", "--session", "/tmp/child.jsonl"],
	);
});

test("buildChildSessionFile — creates a jsonl path in the parent session dir", () => {
	const path = subagents.buildChildSessionFile("/tmp/pi-sessions", "Scout: Auth Module")!;
	assert.match(path, /^\/tmp\/pi-sessions\//);
	assert.match(path, /scout-auth-module/);
	assert.match(path, /\.jsonl$/);
});

test("resolveSessionPathForLaunch — expands relative paths against cwd", () => {
	assert.equal(
		subagents.resolveSessionPathForLaunch("sessions/child.jsonl", "/Users/example/project"),
		"/Users/example/project/sessions/child.jsonl",
	);
});

test("buildResumePrompt — references existing session context and scratchpad", () => {
	const prompt = subagents.buildResumePrompt({
		name: "Worker",
		task: "Do work",
		artifactScratchpadName: "worker/result",
		artifactScratchpadId: 42,
		prompt: "continue",
	});
	assert.match(prompt, /same Pi --session file/);
	assert.match(prompt, /worker\/result/);
	assert.match(prompt, /Original task:\nDo work/);
	assert.match(prompt, /Additional resume instruction:\ncontinue/);
});

test("reconstructPersistedSubagents — applies upsert and complete events", () => {
	const running = {
		id: "abc123",
		name: "Scout",
		task: "scan",
		processId: 9,
		startTime: 1,
		interactive: false,
		wakeBody: "wake",
		wakeAlreadyDue: false,
		launchArgs: ["--session", "/tmp/child.jsonl"],
	};
	const persisted = subagents.toPersistedSubagent(running);
	const restored = subagents.reconstructPersistedSubagents([
		{
			type: "custom",
			customType: "pi-solo-subagent",
			data: { version: 1, event: "upsert", subagent: persisted, updatedAt: "now" },
		},
		{ type: "custom", customType: "other", data: {} },
	]);
	assert.equal(restored.get("abc123")?.processId, 9);

	const completed = subagents.reconstructPersistedSubagents([
		{
			type: "custom",
			customType: "pi-solo-subagent",
			data: { version: 1, event: "upsert", subagent: persisted, updatedAt: "now" },
		},
		{
			type: "custom",
			customType: "pi-solo-subagent",
			data: { version: 1, event: "complete", id: "abc123", completedAt: "later" },
		},
	]);
	assert.equal(completed.size, 0);
});

test("getAgentProcessState — maps active, idle, and error states", async () => {
	assert.deepEqual(
		await getAgentProcessState(
			mockClient({
				get_process_status: structured({ status: "running", agent_state: { thinking: true } }),
			}),
			1,
		),
		{ exists: true, state: "active", status: "running" },
	);
	assert.deepEqual(
		await getAgentProcessState(
			mockClient({
				get_process_status: structured({ status: "running", agent_state: { idle: true } }),
			}),
			2,
		),
		{ exists: true, state: "idle", status: "running" },
	);
	assert.equal(
		(
			await getAgentProcessState(
				mockClient({
					get_process_status: { isError: true, content: [{ type: "text", text: "missing" }] },
				}),
				3,
			)
		).exists,
		false,
	);
});

test("createAgentSurface — calls spawn_agent with agent_tool_id and name", async () => {
	const client = mockClient({
		spawn_agent: structured({ process_id: 42, name: "[worker] Task", agent_instructions: "hi" }),
	});
	const surface = await createAgentSurface(client, "[worker] Task", 7);
	assert.equal(surface.processId, 42);
	assert.equal(surface.agentInstructions, "hi");
	assert.deepEqual(client.calls[0], {
		name: "spawn_agent",
		args: { agent_tool_id: 7, name: "[worker] Task", include_agent_instructions: true },
	});
});

test("createAgentSurface — passes extra_args when provided", async () => {
	const client = mockClient({
		spawn_agent: structured({ process_id: 5, name: "scout" }),
	});
	await createAgentSurface(client, "scout", 3, { extraArgs: ["--model", "anthropic/haiku"] });
	assert.deepEqual(client.calls[0]?.args, {
		agent_tool_id: 3,
		name: "scout",
		include_agent_instructions: true,
		extra_args: ["--model", "anthropic/haiku"],
	});
});

test("createAgentSurface — omits extra_args when empty", async () => {
	const client = mockClient({
		spawn_agent: structured({ process_id: 5, name: "scout" }),
	});
	await createAgentSurface(client, "scout", 3, { extraArgs: [] });
	const args = client.calls[0]?.args as any;
	assert.equal("extra_args" in args, false);
});

// ---------------------------------------------------------------------------
// createSerialQueue — regression test for the Solo helper crash on
// back-to-back parallel `tools/call` requests (e.g. two todo_create in
// flight at once). Tool calls must run one-at-a-time.

test("createSerialQueue — runs queued work sequentially, never overlapping", async () => {
	const enqueue = createSerialQueue();
	let inFlight = 0;
	let maxInFlight = 0;
	const order: number[] = [];

	const make = (id: number, delay: number) =>
		enqueue(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, delay));
			order.push(id);
			inFlight--;
			return id;
		});

	const results = await Promise.all([make(1, 30), make(2, 5), make(3, 15)]);

	assert.equal(maxInFlight, 1, "queue must keep at most one call in flight");
	assert.deepEqual(order, [1, 2, 3], "queued work must run in submission order");
	assert.deepEqual(results, [1, 2, 3]);
});

test("createSerialQueue — a rejected call does not block subsequent calls", async () => {
	const enqueue = createSerialQueue();
	const order: string[] = [];

	const a = enqueue(async () => {
		order.push("a-start");
		throw new Error("boom");
	});
	const b = enqueue(async () => {
		order.push("b");
		return "b-ok";
	});

	await assert.rejects(a, /boom/);
	assert.equal(await b, "b-ok");
	assert.deepEqual(order, ["a-start", "b"]);
});

test("createSerialQueue — preserves submission order under microtask flooding", async () => {
	const enqueue = createSerialQueue();
	const order: number[] = [];
	const pending: Promise<unknown>[] = [];
	for (let i = 0; i < 25; i++) {
		pending.push(
			enqueue(async () => {
				order.push(i);
			}),
		);
	}
	await Promise.all(pending);
	assert.deepEqual(
		order,
		Array.from({ length: 25 }, (_, i) => i),
	);
});

// ---------------------------------------------------------------------------
// applyDirectToolDefaults / getDirectToolDescriptionOverride
//
// Regression coverage for Solo's silent headings-only auto-degradation on
// `scratchpad_read`. The direct tool defaults `mode="full"` so the obvious
// read returns body content instead of just an outline.

test("applyDirectToolDefaults — scratchpad_read gets mode=full when omitted", () => {
	const out = applyDirectToolDefaults("scratchpad_read", { scratchpad_id: 1 }) as Record<
		string,
		unknown
	>;
	assert.equal(out.mode, "full");
	assert.equal(out.scratchpad_id, 1);
});

test("applyDirectToolDefaults — honors an explicit mode (headings)", () => {
	const out = applyDirectToolDefaults("scratchpad_read", {
		scratchpad_id: 1,
		mode: "headings",
	}) as Record<string, unknown>;
	assert.equal(out.mode, "headings");
});

test("applyDirectToolDefaults — honors an explicit mode (section)", () => {
	const out = applyDirectToolDefaults("scratchpad_read", {
		scratchpad_id: 1,
		mode: "section",
		section_heading: "Intent",
	}) as Record<string, unknown>;
	assert.equal(out.mode, "section");
	assert.equal(out.section_heading, "Intent");
});

test("applyDirectToolDefaults — injects mode when mode is an empty string", () => {
	const out = applyDirectToolDefaults("scratchpad_read", {
		scratchpad_id: 1,
		mode: "",
	}) as Record<string, unknown>;
	assert.equal(out.mode, "full");
});

test("applyDirectToolDefaults — leaves unrelated tools untouched", () => {
	const args = { title: "hi", tags: ["x"] };
	assert.strictEqual(applyDirectToolDefaults("todo_create", args), args);
	assert.strictEqual(applyDirectToolDefaults("scratchpad_write", args), args);
});

test("applyDirectToolDefaults — handles non-object args defensively", () => {
	const out = applyDirectToolDefaults("scratchpad_read", null) as Record<string, unknown>;
	assert.equal(out.mode, "full");
});

test("getDirectToolDescriptionOverride — explains the scratchpad_read default", () => {
	const desc = getDirectToolDescriptionOverride("scratchpad_read");
	assert.ok(desc, "expected a description override for scratchpad_read");
	assert.match(desc!, /full body/i);
	assert.match(desc!, /headings/i);
});

test("getDirectToolDescriptionOverride — no override for tools we leave alone", () => {
	assert.equal(getDirectToolDescriptionOverride("todo_create"), undefined);
	assert.equal(getDirectToolDescriptionOverride("scratchpad_write"), undefined);
});

// isSoloFailureText
test("isSoloFailureText — detects Solo tool call failed prefix", () => {
	assert.ok(isSoloFailureText("Solo tool call failed: timeout"));
	assert.ok(isSoloFailureText("some preamble\nSolo tool call failed: something"));
});

test("isSoloFailureText — detects Validation failed for tool prefix", () => {
	assert.ok(isSoloFailureText("Validation failed for tool scratchpad_read: bad arg"));
});

test("isSoloFailureText — returns false for normal content", () => {
	assert.ok(!isSoloFailureText("All good"));
	assert.ok(!isSoloFailureText(undefined));
	assert.ok(!isSoloFailureText(""));
});

// normalizeInputSchema — schema regression: scratchpad_read mode ($defs + anyOf enum/null)
test("normalizeInputSchema — preserves $defs and anyOf nullable enum (scratchpad_read.mode style)", () => {
	const schema = {
		type: "object",
		$defs: {
			ScratchpadReadMode: { type: "string", enum: ["full", "headings", "section", "content"] },
		},
		properties: {
			scratchpad_id: { type: "integer" },
			mode: {
				anyOf: [{ $ref: "#/$defs/ScratchpadReadMode" }, { type: "null" }],
				description: "Read mode.",
			},
		},
		required: ["scratchpad_id"],
	};
	const out = normalizeInputSchema(schema) as any;
	assert.deepEqual(out.$defs, schema.$defs);
	assert.deepEqual(out.properties.mode.anyOf, schema.properties.mode.anyOf);
	assert.equal(out.properties.mode.description, "Read mode.");
	assert.deepEqual(out.required, ["scratchpad_id"]);
});

// normalizeInputSchema — schema regression: todo_complete response_mode (enum/null)
test("normalizeInputSchema — preserves anyOf nullable enum without $defs (todo_complete.response_mode style)", () => {
	const schema = {
		type: "object",
		$defs: {
			TodoWriteResponseMode: { type: "string", enum: ["slim", "rich"] },
		},
		properties: {
			todo_id: { type: "integer" },
			response_mode: {
				anyOf: [{ $ref: "#/$defs/TodoWriteResponseMode" }, { type: "null" }],
				default: null,
				description: "Optional response shape.",
			},
		},
		required: ["todo_id", "completed"],
	};
	const out = normalizeInputSchema(schema) as any;
	assert.deepEqual(out.$defs, schema.$defs);
	assert.deepEqual(out.properties.response_mode.anyOf, schema.properties.response_mode.anyOf);
	assert.equal(out.properties.response_mode.default, null);
});
