import { defineConfig } from "vite-plus";

/**
 * Vite+ config for pi-solo.
 *
 * This is a runtime-loaded Pi extension (no bundling, no build step), so we
 * only use Vite+ as a code-quality and commit-hook orchestrator:
 *
 *   - `vp check` — runs format + lint across the source tree
 *   - `vp fmt`   — Oxfmt
 *   - `vp lint`  — Oxlint
 *   - `vp staged` — pre-commit hook (see .vite-hooks/) auto-fixes the
 *                   subset of files actually staged for commit
 *
 * Formatting style (tabs, double quotes) is set in `.editorconfig` so the
 * IDE and Oxfmt agree without restating the same rules in two places.
 */
export default defineConfig({
	fmt: {
		ignorePatterns: ["node_modules/**", ".vite-hooks/**", ".pi/**"],
	},
	lint: {
		ignorePatterns: ["node_modules/**", ".vite-hooks/**", ".pi/**"],
	},
	staged: {
		"*.{js,mjs,cjs,ts,tsx,json,md}": "vp check --fix",
	},
});
