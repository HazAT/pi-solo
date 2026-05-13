# pi-solo

Native [Pi](https://pi.dev) extension for [Solo](https://soloterm.com), Aaron Francis's local agent + dev-stack workspace for macOS.

## What it does

- Auto-detects Solo's bundled MCP helper at `/Applications/Solo.app/Contents/MacOS/mcp`.
- Spawns it lazily and speaks JSON-RPC over stdio — no separate MCP server to configure.
- Queries Solo for its full tool catalog and registers every tool (`spawn_process`, `todo_create`, `scratchpad_write`, `timer_set`, `lock_acquire`, …) as a **first-class Pi tool**. No `mcp()` wrapper indirection.
- **Solo-native subagents.** Spawn `scout`, `worker`, `planner`, `reviewer` (or any `~/.pi/agent/agents/<name>.md` definition) in dedicated Solo terminal panes — visible in the sidebar, fire-and-forget, results delivered as a steer message when the subagent finishes. Artifacts (plans, specs, context documents) flow through Solo scratchpads instead of local files.
- **Auto-binds to `SOLO_PROCESS_ID`** when Pi runs as a Solo agent, so timers, locks, and todos owned by this Pi process behave correctly.
- **Idle-closes the helper** after 5 s of inactivity so it doesn't show up as a persistent subprocess under your Pi row in Solo's sidebar. Bursts of MCP calls reuse one warm helper; quiet periods cost zero subprocesses.
- **Renders keyboard shortcuts** on spawn/start/restart/status results so you can press `⌥3 · ⌘5` (or whatever the position resolves to) to jump straight to the relevant agent in Solo's sidebar.
- Polished `renderCall`/`renderResult` for every Solo tool — no raw JSON dumps in your tool log.
- Gracefully no-ops when Solo isn't installed or MCP is disabled in Solo settings.

## Install

```bash
pi install git:github.com/HazAT/pi-solo
```

Or pin a tag:

```bash
pi install git:github.com/HazAT/pi-solo@v0.1.0
```

For local development, symlink the extension subdir into your global extensions directory:

```bash
ln -s ~/Projects/pi-solo/pi-extension/solo ~/.pi/agent/extensions/solo
```

The extension is auto-discovered. Run `/reload` if Pi is already running.

## Setup

1. Install Solo from <https://soloterm.com>.
2. In Solo: `Cmd+,` → **MCP** tab → toggle MCP on.
3. _(Optional)_ Enable Todos, Scratchpads, Timers, Key-value in the same panel to expose those tool groups.
4. _(Optional, recommended)_ In Solo: `Cmd+,` → **Agents** tab → **Add tool**. Configure Pi as a Generic agent tool with command `pi`. This lets you spawn Pi sub-agents from inside Pi via `solo_spawn_process`.

## Commands

| Command                        | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `/solo`                        | Show connection status, tool count, bound project & process  |
| `/solo-tools`                  | List every Solo tool currently registered                    |
| `/solo-refresh`                | Re-query Solo for its current tool catalog (cheap)           |
| `/solo-reconnect`              | Force-restart the helper                                     |
| `/solo-bind <process-id>`      | Manually bind this Pi to a Solo process                      |
| `/solo-subagent <name> [task]` | Spawn a Solo subagent by agent name (scout, worker, …)       |
| `/solo-iterate [task]`         | Fork the current session into a Solo subagent for quick work |

## Solo subagents

Solo subagents are the same orchestration pattern as [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), but tailored for Solo: no cmux/tmux/zellij/wezterm abstraction, no per-pane placement heuristics, no Claude-Code path. Subagents run in real Solo terminal panes that you can see, attach to (`⌘N`), and re-focus from the sidebar.

### Tools

| Tool                      | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `solo_subagent`           | Spawn a sub-agent in a Solo pane. Fire-and-forget; result steered back.        |
| `solo_subagent_interrupt` | Send Escape to interrupt the active turn (session stays alive).                |
| `solo_subagent_resume`    | Resume a previous session in a new Solo pane.                                  |
| `solo_subagents_list`     | List available agent definitions from `~/.pi/agent/agents/` and `.pi/agents/`. |

### Agent definitions

Drop a `.md` file in `~/.pi/agent/agents/<name>.md` (or `.pi/agents/<name>.md` for project-local overrides) with frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance.
tools: read, bash
model: anthropic/claude-haiku-4-5
auto-exit: true
spawning: false
output: context.md # opts the agent into the scratchpad-artifact pattern
system-prompt: append
---

You are a codebase reconnaissance specialist. …
```

### Scratchpad artifacts

Whenever a subagent produces an artifact (plan, spec, scout report, review notes), it lands in a **Solo scratchpad** rather than a local file:

1. The orchestrator pre-creates an empty scratchpad named `<agent>/<timestamp>-<task-slug>` and passes its name + id to the subagent via env vars (`PI_SUBAGENT_ARTIFACT_SCRATCHPAD`, `PI_SUBAGENT_ARTIFACT_SCRATCHPAD_ID`).
2. The wrapped task tells the subagent to save the artifact via `solo_scratchpad_write` and mention the scratchpad id in its final summary.
3. The orchestrator includes the scratchpad name + id in the steered result so the next agent (worker, reviewer) can read it directly with `solo_scratchpad_read`.

This happens automatically when the agent definition has `output:` frontmatter, and can be forced or disabled with the `scratchpad: true|false` parameter on `solo_subagent`.

### Optional: hide generic process tools

Set `PI_SOLO_HIDE_PROCESS_TOOLS=1` to suppress `solo_spawn_process`, `solo_send_input`, `solo_list_agent_tools`, `solo_close_process`, and friends. Use this when you want the LLM to reach for `solo_subagent` instead of stitching together the generic process-management primitives. Status, output, search, and todo/scratchpad/timer/lock tools remain available.

## Configuration

| Env var                      | Default                                     | Purpose                                                          |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `SOLO_MCP_HELPER`            | `/Applications/Solo.app/Contents/MacOS/mcp` | Path to the bundled helper                                       |
| `SOLOTERM_APP_DATA_DIR`      | `~/.config/soloterm`                        | Solo's app data dir (passed through)                             |
| `SOLO_PROCESS_ID`            | —                                           | If set, Pi auto-binds to that Solo process                       |
| `PI_SOLO_DISABLED`           | —                                           | Set to `1` to disable the extension entirely                     |
| `PI_SOLO_HIDE_PROCESS_TOOLS` | —                                           | Set to `1` to hide generic process tools when subagents are used |

## How it works under the hood

Solo ships a bundled stdio MCP helper at `/Applications/Solo.app/Contents/MacOS/mcp`. The helper reads the shared MCP secret from `~/.config/soloterm/solo.db`, connects to Solo's local Unix socket at `~/.config/soloterm/solo-mcp.sock`, and bridges JSON-RPC over stdio. This extension just spawns that helper, speaks the standard MCP protocol over its pipes, and adapts each tool into a Pi tool.

There is **no separate MCP server** in this extension. We talk to Solo directly using the helper Solo already provides.

### Idle-close

Solo's sidebar shows every Pi process's subprocess tree. A long-running helper would show up there as a persistent child. To keep things clean, the extension keeps the helper warm only during burst activity and closes it 5 seconds after the last MCP call. The tool catalog stays cached, so subsequent calls re-warm the helper in ~30 ms — transparent to the LLM.

### Auto-binding

When Pi is launched as a Solo agent (Solo sets `SOLO_PROCESS_ID` in the environment), the extension automatically calls `bind_session_process` on initialization. This ties this Pi process's MCP session to its own Solo process row, so timers it sets, locks it acquires, and todos it owns all belong to the right Solo identity.

### Keyboard hints

After successful `spawn_process` / `start_process` / `restart_process` / `get_process_status` calls, the extension does two cheap follow-up MCP calls (`list_projects` + `list_processes`) to figure out where the target sits in Solo's sidebar, then renders the matching keyboard shortcut:

- Same project, position ≤ 9 → `⌘5 to jump`
- Different project, both ≤ 9 → `⌥3 · ⌘5 to jump`
- Position > 9 → `⌘E to jump` (Solo's universal cross-project picker)

## Repo layout

```
pi-solo/
├── pi-extension/solo/
│   ├── index.ts                 ← main extension (MCP client + tool registration)
│   └── subagents/
│       ├── index.ts             ← solo_subagent tools, commands, widget, lifecycle
│       ├── solo-surface.ts      ← thin Solo backend (spawn/send/read/close)
│       ├── session.ts           ← session-file helpers (shared with the child)
│       └── subagent-done.ts     ← in-child extension loaded via `pi -e`
├── test/test.ts                 ← unit tests (node:test)
├── vite.config.ts               ← Vite+ config (fmt / lint / staged)
├── .editorconfig                ← shared indent / line-ending rules
├── .vite-hooks/pre-commit       ← runs `vp staged` on every commit
├── .pi/
│   ├── settings.json            ← dev pointer: load the extension when pi runs in this repo
│   └── skills/release/SKILL.md  ← release workflow
├── LICENSE                      MIT
├── package.json                 scripts + peerDeps + `pi.extensions`
└── README.md
```

Mirrors the layout of [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).

## Development

The project uses [**Vite+**](https://viteplus.dev) (`vp`) as the unified entry point for formatting, linting, and commit-hook orchestration. There is **no bundling** — the Pi extension is loaded directly as TypeScript at runtime — so `vp` only runs Oxfmt + Oxlint here, not Vite’s build pipeline.

```bash
vp install      # install dev dependencies (npm under the hood)
vp config       # install the .vite-hooks/_ pre-commit shim (once per clone)
vp check        # format + lint the source tree
vp check --fix  # auto-fix formatting and lint issues
vp fmt          # run only Oxfmt
vp lint         # run only Oxlint
npm test        # run unit tests (node:test)
```

On every commit, the installed pre-commit hook runs `vp staged`, which executes `vp check --fix` against just the files in the index — trivial formatting drift is auto-fixed and re-staged before the commit lands.

To cut a release, ask Pi: “release 0.2.0” (the `.pi/skills/release/SKILL.md` skill drives the rest).

## Status

Built and tested on macOS 14+, Pi 0.74+, Solo 1.x. Linux/Windows: untested (Solo is macOS-only anyway).

## License

MIT
