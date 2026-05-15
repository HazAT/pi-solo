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
	extractStructured,
	extractTextJson,
	firstLine,
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
} from "../pi-extension/solo/index.ts";

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
	buildWakeBody,
	buildWrappedTask,
	parseAgentDefinition,
	resolveEffectiveInteractive,
} from "../pi-extension/solo/subagents/index.ts";
import {
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

test("buildWrappedTask — includes scratchpad id and expected revision", () => {
	const wrapped = buildWrappedTask({
		task: "do the thing",
		artifactScratchpadName: "planner/2026-05-13-plan",
		artifactScratchpadId: 42,
		artifactScratchpadRevision: 3,
	});
	assert.match(wrapped, /Artifact \(Solo scratchpad\)/);
	assert.match(wrapped, /planner\/2026-05-13-plan/);
	assert.match(wrapped, /scratchpad_id: 42/);
	assert.match(wrapped, /expected_revision: 3/);
	assert.doesNotMatch(wrapped, /subagent_done/);
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

test("parseWakeMarker — recognizes autonomous wake marker", () => {
	assert.deepEqual(
		subagents.parseWakeMarker('[pi-solo:subagent-done id=44 scratchpad=9 name="x"]'),
		{
			processId: 44,
		},
	);
});

test("parseWakeMarker — recognizes interactive wake marker", () => {
	assert.deepEqual(
		subagents.parseWakeMarker('[pi-solo:subagent-interactive-ready id=45 name="x"]'),
		{ processId: 45 },
	);
});

test("parseWakeMarker — returns null for ordinary input", () => {
	assert.equal(subagents.parseWakeMarker("hello"), null);
});

test("resolveInterruptTarget — error when no id/name", () => {
	const result = subagents.resolveInterruptTarget({});
	assert.ok("error" in result);
});

test("resolveInterruptTarget — error when id not found", () => {
	const result = subagents.resolveInterruptTarget({ id: "nope" });
	assert.ok("error" in result);
});
