type RenderableContentItem = {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
};

export type RenderableToolResult = {
	content?: RenderableContentItem[];
	details?: unknown;
};

function safeJson(value: unknown): string {
	try {
		const json = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}

function comparableJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
	} catch {
		return undefined;
	}
}

function parseJsonText(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function prettyText(text: string): string {
	const parsed = parseJsonText(text);
	return parsed === undefined ? text : safeJson(parsed);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleContentJson(items: RenderableContentItem[] | undefined): unknown | undefined {
	if (!items || items.length !== 1) return undefined;
	const [item] = items;
	if (item?.type !== "text" || typeof item.text !== "string") return undefined;
	return parseJsonText(item.text);
}

function detailsForExpandedResult(result: RenderableToolResult): unknown | undefined {
	const details = result.details;
	if (!isPlainRecord(details)) return details;

	const copy = { ...details };
	const parsedContent = singleContentJson(result.content);
	if (
		"structuredContent" in copy &&
		parsedContent !== undefined &&
		comparableJson(copy.structuredContent) === comparableJson(parsedContent)
	) {
		delete copy.structuredContent;
	}

	return Object.keys(copy).length > 0 ? copy : undefined;
}

function formatContentItem(item: RenderableContentItem): string {
	if (item.type === "text") return prettyText(item.text ?? "");
	if (item.type === "image") {
		const bytes = item.data ? ` ${item.data.length} bytes base64` : "";
		return `[image content, ${item.mimeType ?? "unknown"}${bytes}]`;
	}
	return `[${item.type} content]`;
}

export function styleExpandedBlock(text: string, theme: any): string {
	return text
		.split("\n")
		.map((line) =>
			/^[A-Za-z][A-Za-z0-9_ -]*:$/.test(line)
				? theme.fg("muted", line)
				: theme.fg("toolOutput", line),
		)
		.join("\n");
}

export function formatExpandedValue(label: string, value: unknown): string {
	return `${label}:\n${typeof value === "string" ? prettyText(value) : safeJson(value)}`;
}

export function formatExpandedToolResult(result: RenderableToolResult): string {
	const sections: string[] = [];
	const content = result.content ?? [];
	if (content.length > 0) {
		const contentText = content.map(formatContentItem).join("\n\n");
		if (contentText.trim()) sections.push(`content:\n${contentText}`);
	}

	const details = detailsForExpandedResult(result);
	if (details !== undefined) sections.push(formatExpandedValue("details", details));

	return sections.join("\n\n") || "(no result content)";
}
