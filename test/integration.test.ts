/**
 * Integration tests against the real Solo MCP helper.
 *
 * Each test spawns a fresh `SoloMcpClient`, which in turn spawns the bundled
 * Solo helper subprocess (`/Applications/Solo.app/Contents/MacOS/mcp`),
 * exercises real round-trips against Solo state, then tears everything down
 * — including any artifacts created in Solo — via `t.after(...)` cleanup
 * hooks. A safety-net sweep at the file level catches leaks from crashed
 * tests.
 *
 * Test artifacts are tagged with a unique per-run prefix (`RUN_TAG`) so we
 * can find and remove exactly what we created, without touching anything
 * else in the user's Solo project.
 *
 * Skipped automatically when the Solo helper binary isn't present (CI
 * environments without Solo installed).
 *
 * The "regression" tests are tied to the bug fixed by `createSerialQueue`:
 * two large `todo_create` calls in flight at once used to crash the helper
 * with exit code 1. These tests pin the contract that parallel tool calls
 * are now safe.
 *
 * Run:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
	applyDirectToolDefaults,
	extractStructured,
	extractTextJson,
	SoloMcpClient,
} from "../pi-extension/solo/index.ts";

const HELPER_PATH = process.env.SOLO_MCP_HELPER ?? "/Applications/Solo.app/Contents/MacOS/mcp";
const HELPER_AVAILABLE = existsSync(HELPER_PATH);
const SKIP_REASON = HELPER_AVAILABLE ? undefined : `Solo helper not found at ${HELPER_PATH}`;

// One tag for the whole test run — lets the file-level sweep clean up any
// artifacts left behind by a crashed test.
const RUN_TAG = `pi-solo-it-${randomUUID()}`;

function makeClient(): SoloMcpClient {
	return new SoloMcpClient(
		() => {},
		() => {},
	);
}

// Parse the structured JSON payload returned by a tool call. Solo emits
// `structuredContent` on newer tools and a JSON-as-text content block on
// older ones; try both.
function payload<T>(result: any): T {
	const s = extractStructured<T>(result);
	if (s) return s;
	const t = extractTextJson<T>(result);
	if (t) return t;
	throw new Error(`No structured payload in tool result: ${JSON.stringify(result).slice(0, 240)}`);
}

async function deleteAllTaggedTodos(client: SoloMcpClient, tag: string): Promise<void> {
	const list = await client.callTool("todo_list", { tags: [tag] });
	const data = payload<{ todos?: Array<{ id: number; project_id: number }> }>(list);
	for (const todo of data.todos ?? []) {
		try {
			await client.callTool("todo_delete", {
				todo_id: todo.id,
				project_id: todo.project_id,
			});
		} catch {
			// best-effort cleanup
		}
	}
}

async function deleteAllTaggedScratchpads(client: SoloMcpClient, tag: string): Promise<void> {
	const list = await client.callTool("scratchpad_list", { tags: [tag] });
	const data = payload<{
		scratchpads?: Array<{ id: number; project_id: number; revision: number }>;
	}>(list);
	for (const pad of data.scratchpads ?? []) {
		try {
			await client.callTool("scratchpad_delete", {
				scratchpad_id: pad.id,
				project_id: pad.project_id,
				expected_revision: pad.revision,
			});
		} catch {
			// best-effort cleanup
		}
	}
}

// ---------------------------------------------------------------------------
// Smoke

test("integration: helper handshake + tool catalog", { skip: SKIP_REASON }, async (t) => {
	const client = makeClient();
	t.after(() => client.stop());

	await client.start();

	assert.equal(client.state, "ready", "client should reach ready state after start()");
	assert.ok(client.tools.length > 0, "tool catalog should be non-empty");
	assert.ok(
		client.tools.find((tool) => tool.name === "todo_create"),
		"catalog should include todo_create",
	);
	assert.ok(
		client.tools.find((tool) => tool.name === "scratchpad_write"),
		"catalog should include scratchpad_write",
	);
});

// ---------------------------------------------------------------------------
// Todo round-trip

test("integration: todo round-trip — create, list, delete", { skip: SKIP_REASON }, async (t) => {
	const client = makeClient();
	t.after(async () => {
		await deleteAllTaggedTodos(client, RUN_TAG);
		client.stop();
	});
	await client.start();

	const created = payload<{ project_id: number; todo_id: number }>(
		await client.callTool("todo_create", {
			title: "pi-solo integration test todo",
			tags: [RUN_TAG],
			priority: "low",
			body: "Created by pi-solo integration test. Safe to delete.",
		}),
	);
	assert.ok(created.todo_id, "todo_create should return a todo_id");

	const listed = payload<{ todos: Array<{ id: number; title: string }> }>(
		await client.callTool("todo_list", { tags: [RUN_TAG] }),
	);
	assert.equal(listed.todos.length, 1, "exactly one tagged todo should exist");
	assert.equal(listed.todos[0].id, created.todo_id);

	const del = await client.callTool("todo_delete", {
		todo_id: created.todo_id,
		project_id: created.project_id,
	});
	assert.ok(!del.isError, `todo_delete should succeed: ${JSON.stringify(del).slice(0, 200)}`);

	const after = payload<{ todos: unknown[] }>(
		await client.callTool("todo_list", { tags: [RUN_TAG] }),
	);
	assert.equal(after.todos.length, 0, "tagged todo should be gone after delete");
});

// ---------------------------------------------------------------------------
// Scratchpad round-trip

test(
	"integration: scratchpad round-trip — write, read, delete",
	{ skip: SKIP_REASON },
	async (t) => {
		const client = makeClient();
		t.after(async () => {
			await deleteAllTaggedScratchpads(client, RUN_TAG);
			client.stop();
		});
		await client.start();

		const name = `pi-solo-it-${RUN_TAG}`;
		const marker = `MARKER-${RUN_TAG}`;
		const content = `# Integration test\n\n${marker}\n\nSafe to delete.\n`;

		const created = payload<{ project_id: number; scratchpad_id: number; revision: number }>(
			await client.callTool("scratchpad_write", { name, content, tags: [RUN_TAG] }),
		);
		assert.ok(created.scratchpad_id, "scratchpad_write should return a scratchpad_id");
		assert.ok(created.revision >= 1);

		const readResult = await client.callTool("scratchpad_read", {
			scratchpad_id: created.scratchpad_id,
			mode: "full",
		});
		const readText = JSON.stringify(readResult);
		assert.ok(readText.includes(marker), "scratchpad content should round-trip");

		const del = await client.callTool("scratchpad_delete", {
			scratchpad_id: created.scratchpad_id,
			project_id: created.project_id,
			expected_revision: created.revision,
		});
		assert.ok(
			!del.isError,
			`scratchpad_delete should succeed: ${JSON.stringify(del).slice(0, 200)}`,
		);
	},
);

// ---------------------------------------------------------------------------
// Regression tests for the helper-crash-on-parallel-calls bug.

test(
	"integration: regression — two parallel todo_create calls both succeed (no helper crash)",
	{ skip: SKIP_REASON },
	async (t) => {
		const client = makeClient();
		t.after(async () => {
			await deleteAllTaggedTodos(client, RUN_TAG);
			client.stop();
		});
		await client.start();

		// ~7 KB body each — close to the payload size that crashed the helper
		// in the original failure (two ~5–6 KB todo_create calls in flight).
		const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(120);

		const [resA, resB] = await Promise.all([
			client.callTool("todo_create", {
				title: "parallel-A",
				tags: [RUN_TAG],
				priority: "low",
				body,
			}),
			client.callTool("todo_create", {
				title: "parallel-B",
				tags: [RUN_TAG],
				priority: "low",
				body,
			}),
		]);

		assert.ok(!resA.isError, `parallel A errored: ${JSON.stringify(resA).slice(0, 200)}`);
		assert.ok(!resB.isError, `parallel B errored: ${JSON.stringify(resB).slice(0, 200)}`);

		const a = payload<{ todo_id: number }>(resA);
		const b = payload<{ todo_id: number }>(resB);
		assert.ok(a.todo_id && b.todo_id);
		assert.notEqual(a.todo_id, b.todo_id);

		// Helper must still be alive and serving requests afterwards.
		assert.equal(client.state, "ready");

		const listed = payload<{ todos: Array<{ id: number }> }>(
			await client.callTool("todo_list", { tags: [RUN_TAG] }),
		);
		const ids = new Set(listed.todos.map((t) => t.id));
		assert.ok(ids.has(a.todo_id) && ids.has(b.todo_id));
	},
);

test(
	"integration: regression — burst of mixed parallel tool calls all succeed",
	{ skip: SKIP_REASON },
	async (t) => {
		const client = makeClient();
		t.after(async () => {
			await deleteAllTaggedTodos(client, RUN_TAG);
			await deleteAllTaggedScratchpads(client, RUN_TAG);
			client.stop();
		});
		await client.start();

		const body = "x".repeat(2000);
		const calls = [
			client.callTool("todo_create", {
				title: "burst-todo-1",
				tags: [RUN_TAG],
				priority: "low",
				body,
			}),
			client.callTool("todo_create", {
				title: "burst-todo-2",
				tags: [RUN_TAG],
				priority: "low",
				body,
			}),
			client.callTool("todo_create", {
				title: "burst-todo-3",
				tags: [RUN_TAG],
				priority: "low",
				body,
			}),
			client.callTool("scratchpad_write", {
				name: `pi-solo-burst-${RUN_TAG}-1`,
				content: `# burst 1\n${body}`,
				tags: [RUN_TAG],
			}),
			client.callTool("scratchpad_write", {
				name: `pi-solo-burst-${RUN_TAG}-2`,
				content: `# burst 2\n${body}`,
				tags: [RUN_TAG],
			}),
		];

		const results = await Promise.all(calls);
		for (const [i, r] of results.entries()) {
			assert.ok(!r.isError, `burst call #${i} errored: ${JSON.stringify(r).slice(0, 200)}`);
		}
		assert.equal(client.state, "ready", "helper should still be ready after burst");
	},
);

// ---------------------------------------------------------------------------
// Regression for the scratchpad_read silent auto-degradation bug.
//
// Solo's helper silently downgrades a default `scratchpad_read` of a large
// scratchpad to a headings-only outline and does NOT include the hint its
// docs promise. pi-solo's direct tool defaults `mode="full"` so the obvious
// read returns the body. This test pins both behaviors:
//   1. The raw Solo call (no defaults) degrades — confirms the bug still
//      exists upstream so this regression test would catch it if Solo's
//      contract changed.
//   2. The pi-solo wrapper (applyDirectToolDefaults → callTool) returns the
//      full body — confirms our fix works end-to-end.

function onlyHeadings(markdown: string): boolean {
	const lines = markdown
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return false;
	return lines.every((l) => l.startsWith("#"));
}

test(
	"integration: regression — scratchpad_read default returns full body, not headings",
	{ skip: SKIP_REASON },
	async (t) => {
		const client = makeClient();
		t.after(async () => {
			await deleteAllTaggedScratchpads(client, RUN_TAG);
			client.stop();
		});
		await client.start();

		// Build a scratchpad large enough to trip Solo's auto-degradation
		// threshold (~25 KB observed in real planner sessions). Use clearly
		// distinguishable headings + body so we can tell outline from full body.
		const sectionBody = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40);
		const sections = Array.from({ length: 12 }, (_, i) => i + 1);
		const marker = `MARKER-${RUN_TAG}`;
		const content = [
			`# Large scratchpad ${RUN_TAG}`,
			"",
			`Body marker: ${marker}`,
			"",
			...sections.flatMap((i) => [
				`## Section ${i}`,
				"",
				`Body of section ${i} — ${marker}`,
				"",
				sectionBody,
				"",
			]),
		].join("\n");
		assert.ok(content.length > 25_000, "test fixture should exceed degrade threshold");

		const name = `pi-solo-it-large-${RUN_TAG}`;
		const created = payload<{ project_id: number; scratchpad_id: number; revision: number }>(
			await client.callTool("scratchpad_write", { name, content, tags: [RUN_TAG] }),
		);
		assert.ok(created.scratchpad_id);

		// Control: raw read with no mode reproduces Solo's degraded outline.
		const rawResult = await client.callTool("scratchpad_read", {
			scratchpad_id: created.scratchpad_id,
		});
		const raw = payload<{ scratchpad: { content: string } }>(rawResult);
		assert.ok(
			onlyHeadings(raw.scratchpad.content),
			"control: raw scratchpad_read should degrade to headings-only on a large pad",
		);
		assert.ok(
			!raw.scratchpad.content.includes(marker),
			"control: degraded outline should not include the body marker",
		);

		// pi-solo wrapper: applyDirectToolDefaults injects mode="full".
		const wrappedArgs = applyDirectToolDefaults("scratchpad_read", {
			scratchpad_id: created.scratchpad_id,
		}) as Record<string, unknown>;
		assert.equal(wrappedArgs.mode, "full", "wrapper should inject mode=full");

		const wrappedResult = await client.callTool("scratchpad_read", wrappedArgs);
		const wrapped = payload<{ scratchpad: { content: string } }>(wrappedResult);
		assert.ok(
			wrapped.scratchpad.content.includes(marker),
			"pi-solo wrapper: full read should include the body marker",
		);
		assert.ok(
			!onlyHeadings(wrapped.scratchpad.content),
			"pi-solo wrapper: full read should include body lines, not just headings",
		);

		// Explicit mode="headings" still works through the wrapper — callers
		// who actually want the outline are not blocked by our default.
		const headingsArgs = applyDirectToolDefaults("scratchpad_read", {
			scratchpad_id: created.scratchpad_id,
			mode: "headings",
		}) as Record<string, unknown>;
		assert.equal(headingsArgs.mode, "headings", "wrapper should respect explicit mode");
		const headingsResult = await client.callTool("scratchpad_read", headingsArgs);
		const headings = payload<{ scratchpad: { content: string } }>(headingsResult);
		assert.ok(
			onlyHeadings(headings.scratchpad.content),
			"explicit mode=headings should still return outline-only",
		);
	},
);

// ---------------------------------------------------------------------------
// Safety net: file-level sweep removes anything still tagged with RUN_TAG
// after all tests have run. Catches leaks from a test that crashed before
// its own `t.after` could complete.

test(
	"integration: cleanup — final sweep of any leaked artifacts",
	{ skip: SKIP_REASON },
	async () => {
		const client = makeClient();
		try {
			await client.start();
			await deleteAllTaggedTodos(client, RUN_TAG);
			await deleteAllTaggedScratchpads(client, RUN_TAG);
		} finally {
			client.stop();
		}
	},
);
