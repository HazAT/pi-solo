# pi-solo

Native [Pi](https://pi.dev) extension for [Solo](https://soloterm.com), Aaron Francis's local agent + dev-stack workspace for macOS.

## What it does

- Auto-detects Solo's bundled MCP helper at `/Applications/Solo.app/Contents/MacOS/mcp`.
- Spawns it lazily and speaks JSON-RPC over stdio — no separate MCP server to configure.
- Queries Solo for its full tool catalog and registers every tool (`spawn_process`, `todo_create`, `scratchpad_write`, `timer_set`, `lock_acquire`, …) as a **first-class Pi tool**. No `mcp()` wrapper indirection.
- **Solo-native subagents.** Spawn `scout`, `worker`, `planner`, `reviewer` (or any `~/.pi/agent/agents/<name>.md` definition) as real Solo agent processes — visible in the sidebar with Solo's agent state, fire-and-forget, and woken via Solo's idle timer. Artifacts (plans, specs, context documents) flow through Solo scratchpads instead of local files.
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
4. **Required for subagents:** In Solo: `Cmd+,` → **Agents** tab → **Add tool**. Configure Pi as a Generic agent tool with command `pi`. `solo_subagent` resolves this tool and spawns it with `kind="agent"`.

## Commands

| Command                        | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `/solo`                        | Show connection status, tool count, bound project & process |
| `/solo-tools`                  | List every Solo tool currently registered                   |
| `/solo-refresh`                | Re-query Solo for its current tool catalog (cheap)          |
| `/solo-reconnect`              | Force-restart the helper                                    |
| `/solo-bind <process-id>`      | Manually bind this Pi to a Solo process                     |
| `/solo-subagent <name> [task]` | Spawn a Solo subagent by agent name (scout, worker, …)      |

## Solo subagents

Solo subagents lean into Solo's own primitives: no cmux/tmux/zellij/wezterm abstraction, no shell launch scripts, no session-file sidecars, and no child-only extension. Subagents run as real Solo agent processes (`spawn_process(kind="agent")`) that you can see, attach to (`⌘N`), and re-focus from the sidebar. Solo provides the agent icon and `agent_state` tracking; `timer_fire_when_idle_any` wakes the parent when the child goes idle or hits the max wait.

### Tools

| Tool                      | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `solo_subagent`           | Spawn a sub-agent in a Solo agent pane. Fire-and-forget; parent wakes on idle. |
| `solo_subagent_interrupt` | Send Escape to interrupt the active turn (pane stays alive).                   |
| `solo_subagents_list`     | List available agent definitions from `~/.pi/agent/agents/` and `.pi/agents/`. |

### Agent definitions

Drop a `.md` file in `~/.pi/agent/agents/<name>.md` (or `.pi/agents/<name>.md` for project-local overrides). v2 uses the frontmatter for `name`, `description`, `interactive`, and `output`, and inlines the markdown body into the first prompt as the agent's identity. Per-spawn `model`, `tools`, `skills`, `cwd`, and session-mode fields are tolerated for existing files but are not honored because Solo runs the configured agent tool command (`pi`) directly.

```markdown
---
name: scout
description: Fast codebase reconnaissance.
output: context.md # anything other than false keeps the scratchpad artifact pattern enabled
interactive: false
---

You are a codebase reconnaissance specialist. …
```

### Scratchpad artifacts

Whenever a subagent produces an artifact (plan, spec, scout report, review notes), it lands in a **Solo scratchpad** rather than a local file:

1. The orchestrator pre-creates an empty scratchpad named `<agent>/<timestamp>-<task-slug>`.
2. The first prompt tells the subagent the scratchpad name, id, and placeholder revision so it can overwrite the artifact via `solo_scratchpad_write`.
3. The Solo idle timer injects a wake-up body into the parent with the process id and scratchpad id so the parent can read it directly with `solo_scratchpad_read`.

This happens by default for every subagent. Set `output: false` in the agent definition or pass `scratchpad: false` to opt out.

### Optional: hide generic process tools

Set `PI_SOLO_HIDE_PROCESS_TOOLS=1` to suppress `solo_spawn_process`, `solo_send_input`, `solo_list_agent_tools`, `solo_close_process`, and friends from the LLM-facing tool list. `solo_subagent` still calls the underlying raw MCP tools internally. Status, output, search, and todo/scratchpad/timer/lock tools remain available.

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

### Subagent wake-up

`solo_subagent` launches the configured Pi agent tool as `spawn_process(kind="agent")`, waits until Solo reports `agent_state.idle`, schedules `timer_fire_when_idle_any`, and then sends the wrapped task as one user turn. When the child later goes idle (or reaches the 30 minute max wait), Solo injects a plain wake-up body into the parent Pi process with the child `process_id` and scratchpad id. The parent reads the scratchpad and closes the child pane when finished.

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
│       ├── index.ts             ← solo_subagent tools, commands, task/wake text
│       └── solo-surface.ts      ← thin Solo backend (agent spawn/send/timer/close)
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
