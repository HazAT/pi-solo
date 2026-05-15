/**
 * Animated "PI · SOLO" header with live Solo connection status.
 *
 * Replaces pi's built-in header with a block-letter banner whenever the
 * Solo extension is loaded. The subtitle line shows the current Solo
 * connection state, the catalog size (direct vs. gateway tools), and
 * the active model — so the very first thing the user sees on startup
 * already advertises what the extension brings to the table.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

type Rgb = [number, number, number];

const PALETTE: Rgb[] = [
	[22, 83, 189],
	[48, 129, 247],
	[93, 171, 255],
	[151, 205, 255],
	[93, 171, 255],
	[48, 129, 247],
];

const TITLE_LINES = [
	"██████╗ ██╗    ███████╗ ██████╗ ██╗      ██████╗ ",
	"██╔══██╗██║    ██╔════╝██╔═══██╗██║     ██╔═══██╗",
	"██████╔╝██║    ███████╗██║   ██║██║     ██║   ██║",
	"██╔═══╝ ██║    ╚════██║██║   ██║██║     ██║   ██║",
	"██║     ██║    ███████║╚██████╔╝███████╗╚██████╔╝",
	"╚═╝     ╚═╝    ╚══════╝ ╚═════╝ ╚══════╝ ╚═════╝ ",
];

export type SoloHeaderState =
	| { kind: "starting" }
	| { kind: "warming" }
	| { kind: "disabled" }
	| {
			kind: "connected";
			total: number;
			direct: number;
			gateway: number;
			profile: string;
	  }
	| { kind: "error"; message: string };

const state: { value: SoloHeaderState; model: string } = {
	value: { kind: "starting" },
	model: "no model selected",
};

let requestRender: (() => void) | undefined;

function mix(a: number, b: number, t: number) {
	return Math.round(a + (b - a) * t);
}

function sampleGradient(position: number): Rgb {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * PALETTE.length;
	const index = Math.floor(scaled);
	const next = (index + 1) % PALETTE.length;
	const t = scaled - index;
	const a = PALETTE[index]!;
	const b = PALETTE[next]!;
	return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function fg([r, g, b]: Rgb, text: string) {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);
	return chars.map((c, i) => (c === " " ? c : fg(sampleGradient(i / span + phase), c))).join("");
}

function visualLen(text: string) {
	// Strip ANSI for width math.
	return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function center(text: string, width: number) {
	const len = visualLen(text);
	if (len >= width) return text;
	return `${" ".repeat(Math.floor((width - len) / 2))}${text}`;
}

function renderStatusLine(theme: Theme): string {
	const s = state.value;
	const dot = (color: string, glyph = "●") => theme.fg(color, glyph);
	const dim = (t: string) => theme.fg("dim", t);
	const muted = (t: string) => theme.fg("muted", t);
	const accent = (t: string) => theme.fg("accent", t);
	const sep = dim(" · ");

	let badge: string;
	let detail: string;
	switch (s.kind) {
		case "starting":
			badge = `${dot("muted", "○")} ${muted("solo starting")}`;
			detail = "";
			break;
		case "warming":
			badge = `${dot("warning", "◐")} ${muted("solo warming up")}`;
			detail = "";
			break;
		case "disabled":
			badge = `${dot("warning")} ${muted("solo connected — MCP disabled in Solo settings")}`;
			detail = "";
			break;
		case "error":
			badge = `${dot("error")} ${muted(`solo offline — ${s.message}`)}`;
			detail = "";
			break;
		case "connected":
			badge = `${dot("success")} ${muted("solo connected")}`;
			detail =
				`${accent(String(s.total))} ${muted("tools")}` +
				dim(" (") +
				`${theme.fg("success", String(s.direct))} ${muted("direct")}` +
				dim(" · ") +
				`${theme.fg("accent", String(s.gateway))} ${muted("gateway")}` +
				dim(" · ") +
				muted(s.profile) +
				dim(")");
			break;
	}

	const tail = `${muted("model")} ${theme.fg("text", state.model)}`;
	return [badge, detail, tail].filter(Boolean).join(sep);
}

function renderBanner(width: number, theme: Theme): string[] {
	const lines = TITLE_LINES.map((line, row) => gradientText(center(line, width), row * 0.045));
	const status = renderStatusLine(theme);
	return ["", ...lines, "", center(`${BOLD}${status}${RESET}`, width), ""];
}

export function installSoloHeader(ctx: ExtensionContext, pi: ExtensionAPI) {
	if (!ctx.hasUI) return;
	state.model = ctx.model?.id ?? "no model selected";

	ctx.ui.setHeader((tui, theme) => {
		requestRender = () => tui.requestRender();
		return {
			render(width: number) {
				return renderBanner(width, theme);
			},
			invalidate() {
				tui.requestRender();
			},
		};
	});

	pi.on("model_select", (event) => {
		state.model = event.model.id;
		requestRender?.();
	});
}

export function setSoloHeaderStatus(next: SoloHeaderState) {
	state.value = next;
	requestRender?.();
}
