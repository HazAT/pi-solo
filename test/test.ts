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
	humanizeToolLabel,
	lineCount,
	markerFor,
	mcpContentToPi,
	normalizeInputSchema,
	pickSubject,
	str,
} from "../pi-extension/solo/index.ts";

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
// Solo-native subagents: agent definition parsing

import {
	__test__ as subagents,
	buildArtifactScratchpadName,
	buildWrappedTask,
	parseAgentDefinition,
	resolveDenyTools,
	resolveEffectiveInteractive,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveResultPresentation,
} from "../pi-extension/solo/subagents/index.ts";
import {
	SENTINEL_RE,
	interpretExitSidecar,
	shellEscape,
} from "../pi-extension/solo/subagents/solo-surface.ts";
import { findLastAssistantMessage } from "../pi-extension/solo/subagents/session.ts";

test("parseAgentDefinition — returns null without frontmatter", () => {
	assert.equal(parseAgentDefinition("# no frontmatter here", "foo"), null);
});

test("parseAgentDefinition — reads name, model, tools, body", () => {
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

// ---------------------------------------------------------------------------
// resolveDenyTools

test("resolveDenyTools — spawning:false hides all spawning tools", () => {
	const denied = resolveDenyTools({ spawning: false });
	assert.ok(denied.has("solo_subagent"));
	assert.ok(denied.has("solo_subagent_interrupt"));
	assert.ok(denied.has("solo_subagents_list"));
	assert.ok(denied.has("solo_subagent_resume"));
});

test("resolveDenyTools — deny-tools list adds names", () => {
	const denied = resolveDenyTools({ denyTools: "claude, write" });
	assert.deepEqual([...denied].sort(), ["claude", "write"]);
});

test("resolveDenyTools — null defaults to empty", () => {
	assert.equal(resolveDenyTools(null).size, 0);
});

// ---------------------------------------------------------------------------
// resolveEffectiveSessionMode / resolveLaunchBehavior / interactive

test("resolveEffectiveSessionMode — fork param wins", () => {
	assert.equal(resolveEffectiveSessionMode({ fork: true }, { sessionMode: "standalone" }), "fork");
});

test("resolveEffectiveSessionMode — falls through to agent default", () => {
	assert.equal(resolveEffectiveSessionMode({}, { sessionMode: "lineage-only" }), "lineage-only");
});

test("resolveEffectiveSessionMode — standalone when nothing specified", () => {
	assert.equal(resolveEffectiveSessionMode({}, null), "standalone");
});

test("resolveLaunchBehavior — standalone uses artifact handoff", () => {
	const lb = resolveLaunchBehavior({}, null);
	assert.equal(lb.sessionMode, "standalone");
	assert.equal(lb.taskDelivery, "artifact");
	assert.equal(lb.inheritsConversationContext, false);
	assert.equal(lb.seededSessionMode, null);
});

test("resolveLaunchBehavior — fork inherits context and uses direct delivery", () => {
	const lb = resolveLaunchBehavior({ fork: true }, null);
	assert.equal(lb.taskDelivery, "direct");
	assert.equal(lb.inheritsConversationContext, true);
	assert.equal(lb.seededSessionMode, "fork");
});

test("resolveEffectiveInteractive — param wins over agent", () => {
	assert.equal(resolveEffectiveInteractive({ interactive: false }, { interactive: true }), false);
});

test("resolveEffectiveInteractive — inverse of auto-exit by default", () => {
	assert.equal(resolveEffectiveInteractive({}, { autoExit: true }), false);
	assert.equal(resolveEffectiveInteractive({}, { autoExit: false }), true);
	assert.equal(resolveEffectiveInteractive({}, null), true);
});

// ---------------------------------------------------------------------------
// buildArtifactScratchpadName / buildWrappedTask

test("buildArtifactScratchpadName — sanitizes agent + name", () => {
	const stamped = buildArtifactScratchpadName("Planner!", "Refactor login flow");
	assert.match(stamped, /^planner\/\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-refactor-login-flow$/i);
});

test("buildArtifactScratchpadName — falls back when agent missing", () => {
	const stamped = buildArtifactScratchpadName(undefined, "");
	assert.match(stamped, /^subagent\/\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-task$/i);
});

test("buildWrappedTask — omits artifact block without scratchpad", () => {
	const wrapped = buildWrappedTask({
		task: "do the thing",
		roleBlock: "",
		autoExit: true,
	});
	assert.match(wrapped, /Complete your task autonomously/);
	assert.doesNotMatch(wrapped, /Artifact \(Solo scratchpad\)/);
});

test("buildWrappedTask — includes scratchpad block and forbids local files", () => {
	const wrapped = buildWrappedTask({
		task: "do the thing",
		roleBlock: "",
		autoExit: true,
		artifactScratchpadName: "planner/2026-05-13-plan",
		artifactScratchpadId: 42,
	});
	assert.match(wrapped, /Artifact \(Solo scratchpad\)/);
	assert.match(wrapped, /planner\/2026-05-13-plan/);
	assert.match(wrapped, /scratchpad_id: 42/);
	assert.match(wrapped, /Do NOT save plans, specs, or context documents to local files/);
});

test("buildWrappedTask — interactive variant tells the agent to call subagent_done", () => {
	const wrapped = buildWrappedTask({
		task: "do the thing",
		roleBlock: "role",
		autoExit: false,
	});
	assert.match(wrapped, /call the subagent_done tool/);
});

// ---------------------------------------------------------------------------
// resolveResultPresentation

test("resolveResultPresentation — success path mentions elapsed and summary", () => {
	const out = resolveResultPresentation(
		{ exitCode: 0, elapsed: 73, summary: "Did the thing", sessionFile: "/tmp/s.jsonl" },
		"Scout",
	);
	assert.match(out, /Sub-agent "Scout" completed \(1m 13s\)\./);
	assert.match(out, /Did the thing/);
	assert.match(out, /Session: \/tmp\/s\.jsonl/);
});

test("resolveResultPresentation — error path surfaces errorMessage", () => {
	const out = resolveResultPresentation(
		{ exitCode: 1, elapsed: 4, summary: "", errorMessage: "overload" },
		"Scout",
	);
	assert.match(out, /failed after 4s/);
	assert.match(out, /Error: overload/);
	assert.match(out, /solo_subagent_resume/);
});

test("resolveResultPresentation — includes scratchpad reference", () => {
	const out = resolveResultPresentation(
		{
			exitCode: 0,
			elapsed: 5,
			summary: "done",
			artifactScratchpadName: "planner/foo",
			artifactScratchpadId: 9,
		},
		"Planner",
	);
	assert.match(out, /Artifact scratchpad: planner\/foo \(id 9\)/);
});

// ---------------------------------------------------------------------------
// interpretExitSidecar + SENTINEL_RE

test("interpretExitSidecar — done", () => {
	assert.deepEqual(interpretExitSidecar({ type: "done" }), {
		reason: "done",
		exitCode: 0,
	});
});

test("interpretExitSidecar — ping carries name + message", () => {
	const r = interpretExitSidecar({ type: "ping", name: "scout", message: "stuck" });
	assert.equal(r.reason, "ping");
	assert.deepEqual(r.ping, { name: "scout", message: "stuck" });
});

test("interpretExitSidecar — error falls back to default message", () => {
	const r = interpretExitSidecar({ type: "error" });
	assert.equal(r.reason, "error");
	assert.equal(r.exitCode, 1);
	assert.match(r.errorMessage ?? "", /no errorMessage/);
});

test("interpretExitSidecar — unknown type defaults to done", () => {
	assert.equal(interpretExitSidecar({ type: "weird" }).reason, "done");
});

test("SENTINEL_RE — matches the shell-echoed sentinel", () => {
	const m = "some screen output\n__SUBAGENT_DONE_137__\n".match(SENTINEL_RE);
	assert.ok(m);
	assert.equal(m![1], "137");
});

// ---------------------------------------------------------------------------
// shellEscape

test("shellEscape — wraps simple string in quotes", () => {
	assert.equal(shellEscape("foo"), "'foo'");
});

test("shellEscape — escapes embedded single quotes", () => {
	assert.equal(shellEscape("it's fine"), "'it'\\''s fine'");
});

// ---------------------------------------------------------------------------
// findLastAssistantMessage

test("findLastAssistantMessage — picks latest assistant text", () => {
	const entries = [
		{
			type: "message",
			id: "1",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		},
		{
			type: "message",
			id: "2",
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		},
		{
			type: "message",
			id: "3",
			message: { role: "assistant", content: [{ type: "text", text: "final" }] },
		},
	];
	assert.equal(findLastAssistantMessage(entries as any), "final");
});

test("findLastAssistantMessage — falls back to errorMessage on stopReason=error", () => {
	const entries = [
		{
			type: "message",
			id: "1",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "overloaded",
			},
		},
	];
	assert.equal(findLastAssistantMessage(entries as any), "Subagent error: overloaded");
});

test("findLastAssistantMessage — null when no assistant messages", () => {
	assert.equal(findLastAssistantMessage([]), null);
});

// ---------------------------------------------------------------------------
// internal helpers (via __test__)

test("labelForSurface — prefixes with agent badge", () => {
	assert.equal(subagents.labelForSurface("Refactor", "planner"), "[planner] Refactor");
	assert.match(subagents.labelForSurface("Refactor"), /^🤖 Refactor$/);
});

test("buildPiPromptArgs — prepends empty separator when artifact handoff + skills", () => {
	const args = subagents.buildPiPromptArgs({
		effectiveSkills: "commit, release",
		taskDelivery: "artifact",
		taskArg: "@/tmp/task.md",
	});
	assert.deepEqual(args, ["", "/skill:commit", "/skill:release", "@/tmp/task.md"]);
});

test("buildPiPromptArgs — direct delivery doesn't prepend separator", () => {
	const args = subagents.buildPiPromptArgs({
		effectiveSkills: "commit",
		taskDelivery: "direct",
		taskArg: "do the thing",
	});
	assert.deepEqual(args, ["/skill:commit", "do the thing"]);
});

test("buildSubagentToolAllowlist — always preserves subagent_done + caller_ping", () => {
	const allow = subagents.buildSubagentToolAllowlist("read, bash");
	assert.match(allow!, /read/);
	assert.match(allow!, /bash/);
	assert.match(allow!, /subagent_done/);
	assert.match(allow!, /caller_ping/);
});

test("buildSubagentToolAllowlist — null when no tools requested", () => {
	assert.equal(subagents.buildSubagentToolAllowlist(undefined), null);
	assert.equal(subagents.buildSubagentToolAllowlist(""), null);
});

test("resolveInterruptTarget — error when no id/name", () => {
	const result = subagents.resolveInterruptTarget({});
	assert.ok("error" in result);
});

test("resolveInterruptTarget — error when id not found", () => {
	const result = subagents.resolveInterruptTarget({ id: "nope" });
	assert.ok("error" in result);
});
