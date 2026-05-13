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
