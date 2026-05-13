/**
 * Session-file helpers shared by the parent and child of a subagent.
 *
 * The parent reads the child's session file to recover the final assistant
 * message after the child exits. For lineage-aware modes ("lineage-only" and
 * "fork") we also seed the child's session with a session header pointing at
 * the parent, so the child shows up correctly in `pi --session` and the
 * upcoming session-graph tooling can walk the parent ↔ child relationship.
 *
 * Ported from pi-interactive-subagents `pi-extension/subagents/session.ts`.
 */

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string;
	[key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	};
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
	const raw = readFileSync(parentSessionFile, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim());

	// Fork from just before the last user message — the child picks up from
	// the parent's last assistant turn and continues with a fresh task.
	let truncateAt = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]!);
			if (entry.type === "message" && entry.message?.role === "user") {
				truncateAt = i;
				break;
			}
		} catch {
			// ignore malformed lines
		}
	}

	return lines.slice(0, truncateAt).filter((line) => {
		try {
			// Drop the parent's session header — the child writes its own.
			return JSON.parse(line).type !== "session";
		} catch {
			return true;
		}
	});
}

export function seedSubagentSessionFile(params: {
	mode: SeededSubagentSessionMode;
	parentSessionFile: string;
	childSessionFile: string;
	childCwd: string;
}): void {
	const header = {
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd: params.childCwd,
		parentSession: params.parentSessionFile,
	};
	const contentLines = params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
	const lines = [JSON.stringify(header), ...contentLines];

	mkdirSync(dirname(params.childSessionFile), { recursive: true });
	writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

function readEntries(sessionFile: string): SessionEntry[] {
	const raw = readFileSync(sessionFile, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as SessionEntry);
}

/** Return entries added after `afterLine` (1-indexed count of existing entries). */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
	const raw = readFileSync(sessionFile, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim());
	return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of session entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error,
 * and without this fallback the parent would silently see a stale earlier
 * message and treat the failure as a success.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const msg = entry as MessageEntry;
		if (msg.message.role !== "assistant") continue;

		const texts = msg.message.content
			.filter(
				(block) =>
					block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
			)
			.map((block) => block.text as string);

		if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

		const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
		const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
		if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.trim() !== "") {
			return `Subagent error: ${errorMessage.trim()}`;
		}
	}
	return null;
}

/** Snapshot the session file for parallel-worker isolation. */
export function copySessionFile(sessionFile: string, destDir: string): string {
	const id = randomBytes(4).toString("hex");
	const dest = join(destDir, `subagent-${id}.jsonl`);
	mkdirSync(destDir, { recursive: true });
	copyFileSync(sessionFile, dest);
	return dest;
}

/** Append a branch_summary entry referencing the subagent's run. */
export function appendBranchSummary(
	sessionFile: string,
	branchPointId: string,
	fromId: string | null,
	summary: string,
): string {
	const id = randomBytes(4).toString("hex");
	const entry = {
		type: "branch_summary",
		id,
		parentId: branchPointId,
		timestamp: new Date().toISOString(),
		fromId: fromId ?? branchPointId,
		summary,
	};
	appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
	return id;
}

export function readEntryCount(sessionFile: string): number {
	try {
		return readEntries(sessionFile).length;
	} catch {
		return 0;
	}
}
