# pi-solo

Native [Pi](https://pi.dev) extension for [Solo](https://soloterm.com), Aaron Francis's local agent + dev-stack workspace for macOS.

<img width="1822" height="1185" alt="SCR-20260516-irqz" src="https://github.com/user-attachments/assets/e537bf3c-2007-4915-a1a1-c85d86b9fdca" />

## What it does

- **PI SOLO header banner** with a live status line beneath it: connection state (starting / warming / connected / disabled / error), catalog size split into direct vs. gateway tools, the active surface profile, and the current model. Replaces pi's built-in header on `session_start` and re-renders on model changes and on every Solo MCP client transition — so the very first thing you see on startup already advertises what the extension is contributing.
- **Bundled `solo` theme** — a GitHub-dark-derived palette shipped with the extension via `pi.themes`. Installing the package makes the theme available in `/settings`; select it with `"theme": "solo"` in your pi `settings.json`.
- Auto-detects Solo's bundled MCP helper at `/Applications/Solo.app/Contents/MacOS/mcp`.
- Spawns it lazily and speaks JSON-RPC over stdio — no separate MCP server to configure.
- Queries Solo for its full tool catalog and exposes a curated tool surface. By default, only the handoff/workflow essentials (`scratchpad_write`, `scratchpad_read`, `scratchpad_list`, `todo_create`, `todo_list`, `todo_update`, `todo_complete`) are **first-class Pi tools**; lower-frequency cleanup/admin tools stay discoverable and callable through `solo_tool`.
- **Solo-native, resumable subagents.** Spawn `scout`, `worker`, `planner`, `reviewer` (or any `~/.pi/agent/agents/<name>.md` definition) as real Solo agent processes via Solo's native `spawn_agent` MCP tool — visible in the sidebar with Solo's agent state, fire-and-forget, and woken via Solo's idle timer. Agent frontmatter `model` and `thinking` are forwarded as per-launch Pi `extra_args`, and every child gets a dedicated Pi `--session` JSONL file, so pi-solo can re-attach or respawn it after the parent restarts. Artifacts (plans, specs, context documents) flow through Solo scratchpads instead of local files.
- **Optional Solo notifications** when a Solo subagent finishes and the parent Pi is ready for input. Enable with `/solo-notify subagent`, `PI_SOLO_NOTIFY=subagent`, or `"piSolo": { "notifications": "subagent" }` in Pi settings. Notifications are sent through a dedicated Solo terminal so they use Solo's in-app notification path, not macOS system notifications.
- **Auto-binds to `SOLO_PROCESS_ID`** via Solo's canonical `identify_session` tool when Pi runs as a Solo agent, so timers, locks, and todos owned by this Pi process behave correctly.
- **Idle-closes the helper** after 5 s of inactivity so it doesn't show up as a persistent subprocess under your Pi row in Solo's sidebar. Bursts of MCP calls reuse one warm helper; quiet periods cost zero subprocesses.
- **Renders keyboard shortcuts** on spawn/start/restart/status results so you can press `⌥3 · ⌘5` (or whatever the position resolves to) to jump straight to the relevant agent in Solo's sidebar.
- Polished `renderCall`/`renderResult` for direct Solo tools — no raw JSON dumps in your tool log.
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

## Theme

The package ships a `solo` theme (a GitHub-dark-derived palette tuned for the banner gradient) under `themes/solo.json` and registers it via `pi.themes` in `package.json`. After installing the extension:

- Pick it interactively with `/settings` → Theme → `solo`, **or**
- Set it globally in `~/.pi/agent/settings.json`:

  ```json
  { "theme": "solo" }
  ```

The currently active custom theme hot-reloads on edit, so tweaking `themes/solo.json` in a clone gives immediate visual feedback.

## Header

When the extension loads it replaces pi's built-in header with a gradient `PI SOLO` block-letter banner plus a live status line:

```
● solo connected · 76 tools (7 direct · 69 gateway · core) · model claude-sonnet-4-6
```

The status dot reflects the SoloMcpClient state — green when connected, yellow while warming or when MCP is toggled off in Solo settings, red on error — and the line re-renders on every model change and every MCP client transition. The previously transient `Solo connected — …` notification is gone; the same information now lives permanently in the header.

## Setup

1. Install Solo from <https://soloterm.com>.
2. In Solo: `Settings → MCP` → toggle MCP on.
3. _(Optional)_ Enable Todos, Scratchpads, Timers, Key-value in the same panel to expose those tool groups.
4. **Required for subagents:** In Solo: `Settings → Agents` → **Add tool**. Configure Pi as a Generic agent tool with command `pi`. `subagent` resolves this tool and launches it through Solo's native `spawn_agent`.

## Commands

| Command                                                               | Purpose                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/solo`                                                               | Show connection status, catalog/direct/gateway counts, bound project & process |
| `/solo-tools`                                                         | List Solo MCP catalog tools and whether they are direct or gateway-only        |
| `/solo-refresh`                                                       | Re-query Solo for its current tool catalog (cheap)                             |
| `/solo-reconnect`                                                     | Force-restart the helper                                                       |
| `/solo-bind <process-id>`                                             | Manually bind this Pi to a Solo process                                        |
| `/solo-subagent <name> [task]`                                        | Spawn a Solo subagent by agent name (scout, worker, …)                         |
| `/solo-subagent-resume <id\|process-id\|session> [prompt]`            | Resume/re-attach a subagent or respawn Pi with an existing `--session` file    |
| `/solo-notify [status\|test [method]\|off\|subagent\|agent-end\|all]` | Configure/test Solo notifications for completed Solo work                      |

## Solo subagents

Solo subagents lean into Solo's own primitives. Subagents are spawned with Solo's native `spawn_agent` MCP tool. Agent definition `model:` and `thinking:` frontmatter are passed to Pi as per-launch `extra_args`; Solo's saved agent tool defaults are not mutated. You can see, attach to (`⌘N`), and re-focus children from the sidebar. Solo provides the agent icon and `agent_state` tracking; `timer_fire_when_idle_any` wakes the parent when the child goes idle or hits the max wait.

### Tools

| Tool                 | Purpose                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `solo_tool`          | List, inspect, or call Solo MCP catalog tools that are hidden from the direct surface. |
| `subagent`           | Spawn a sub-agent in a Solo agent pane. Fire-and-forget; parent wakes on idle.         |
| `subagent_resume`    | Re-attach to a live subagent or respawn Pi with a saved child `--session` file.        |
| `subagent_interrupt` | Send Escape to interrupt the active turn (pane stays alive).                           |
| `subagents_list`     | List available agent definitions from `~/.pi/agent/agents/` and `.pi/agents/`.         |

### Agent definitions

Drop a `.md` file in `~/.pi/agent/agents/<name>.md` (or `.pi/agents/<name>.md` for project-local overrides). The frontmatter carries `name`, `description`, `interactive`, `output`, `model`, and `thinking`, and the markdown body is inlined into the first prompt as the agent's identity. `model` (with an optional `:<thinking>` suffix) and a standalone `thinking:` field are translated into Pi CLI flags (`--model <spec>`, `--thinking <level>`) and handed to Solo's `spawn_agent` as `extra_args`, so the child starts on the right model/thinking from launch — no child-side override step. Per-spawn `tools`, `skills`, `cwd`, and session-mode fields are tolerated for existing files but are not honored because Solo runs the configured agent tool command (`pi`) directly.

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
2. The child is launched with a dedicated Pi `--session <jsonl>` file and the first prompt tells it the scratchpad name, id, and placeholder revision so it can overwrite the artifact via `scratchpad_write`.
3. The Solo idle timer injects a wake-up body into the parent with the process id and scratchpad id so the parent can read it directly with `scratchpad_read`.
4. The parent persists the child session path, process id, timer id, and artifact references in the parent Pi session. On restart, pi-solo validates the old Solo process; if it is still alive, it re-arms the idle watcher, and if it is gone, it respawns Pi with the same child `--session` file and sends a resume prompt.

This happens by default for every subagent. Set `output: false` in the agent definition or pass `scratchpad: false` to opt out of the scratchpad artifact; the child Pi session still exists for resumption.

### Solo MCP tool surface

`PI_SOLO_TOOL_SURFACE` controls how much of Solo's MCP catalog is registered directly in Pi:

| Profile   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`    | Default. Direct-register only the curated handoff/workflow essentials — `scratchpad_write`, `scratchpad_read`, `scratchpad_list`, `todo_create`, `todo_list`, `todo_update`, and `todo_complete` — and route every other MCP catalog tool through `solo_tool`. New Solo 0.7.1 tools (`spawn_agent`, `identify_session`, `scratchpad_find`, `scratchpad_tail`, `scratchpad_edit`, `scratchpad_append_section`, project admin) stay available via the gateway and are intentionally not promoted to direct. |
| `full`    | Direct-register every Solo MCP catalog tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `minimal` | Direct-register no Solo MCP catalog tools; use `solo_tool` for all catalog access.                                                                                                                                                                                                                                                                                                                                                                                                                        |

Hand-written tools remain direct in every profile: `solo_tool`, `subagent`, `subagent_interrupt`, and `subagents_list`.

Use the gateway to discover and call hidden tools:

```typescript
solo_tool({ action: "list", query: "process" });
solo_tool({ action: "schema", name: "get_project_stats" });
solo_tool({ action: "call", name: "get_project_stats", arguments: {} });
```

State-changing gateway calls require a short reason:

```typescript
solo_tool({
	action: "call",
	name: "close_process",
	arguments: { process_id: 42 },
	reason: "close completed worker pane",
});
```

## Configuration

| Env var                 | Default                                     | Purpose                                                      |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `SOLO_MCP_HELPER`       | `/Applications/Solo.app/Contents/MacOS/mcp` | Path to the bundled helper                                   |
| `SOLOTERM_APP_DATA_DIR` | `~/.config/soloterm`                        | Solo's app data dir (passed through)                         |
| `SOLO_PROCESS_ID`       | —                                           | If set, Pi auto-binds to that Solo process                   |
| `PI_SOLO_DISABLED`      | —                                           | Set to `1` to disable the extension entirely                 |
| `PI_SOLO_TOOL_SURFACE`  | `core`                                      | Tool surface profile: `core`, `full`, or `minimal`           |
| `PI_SOLO_NOTIFY`        | `off`                                       | Solo notifications: `off`, `subagent`, `agent-end`, or `all` |

Notification modes can also be set in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
	"piSolo": {
		"notifications": "subagent"
	}
}
```

Use `/solo-notify test` to verify Solo shows the notification before leaving it on. The default test creates/reuses a `Pi Solo Notifications` terminal and sends OSC 777 from there; `/solo-notify test macos` is available only as a diagnostic fallback.

## How it works under the hood

Solo ships a bundled stdio MCP helper at `/Applications/Solo.app/Contents/MacOS/mcp`. The helper reads the shared MCP secret from `~/.config/soloterm/solo.db`, connects to Solo's local Unix socket at `~/.config/soloterm/solo-mcp.sock`, and bridges JSON-RPC over stdio. This extension spawns that helper, speaks the standard MCP protocol over its pipes, direct-registers the selected profile's tools, and keeps the rest reachable through `solo_tool`.

There is **no separate MCP server** in this extension. We talk to Solo directly using the helper Solo already provides.

### Idle-close

Solo's sidebar shows every Pi process's subprocess tree. A long-running helper would show up there as a persistent child. To keep things clean, the extension keeps the helper warm only during burst activity and closes it 5 seconds after the last MCP call. The tool catalog stays cached, so subsequent calls re-warm the helper in ~30 ms — transparent to the LLM.

### Auto-binding

When Pi is launched as a Solo agent (Solo sets `SOLO_PROCESS_ID` in the environment), the extension calls Solo's canonical `identify_session` on initialization, passing `solo_process_id` when available. The response populates the bound process/project so timers it sets, locks it acquires, and todos it owns all belong to the right Solo identity. No fallback to the older `whoami` / `bind_session_process` flow is kept — Solo 0.7.1+ is the supported baseline.

### Subagent wake-up

`subagent` launches the configured Pi agent tool through Solo's native `spawn_agent`, forwarding any `model` / `thinking` from the agent definition plus a child Pi session file as `extra_args` (`--model …`, `--thinking …`, `--session …`). It then waits until Solo reports `agent_state.idle`, schedules `timer_fire_when_idle_any`, and sends the wrapped task as one user turn. When the child later goes idle (or reaches the 30 minute max wait), Solo injects a plain wake-up body into the parent Pi process with the child `process_id` and scratchpad id. The parent records the subagent complete in its session state, reads the scratchpad, and closes the child pane when finished.

### Keyboard hints

After successful `spawn_agent` / `spawn_process` / `start_process` / `restart_process` / `get_process_status` calls, the extension does two cheap follow-up MCP calls (`list_projects` + `list_processes`) to figure out where the target sits in Solo's sidebar, then renders the matching keyboard shortcut:

- Same project, position ≤ 9 → `⌘5 to jump`
- Different project, both ≤ 9 → `⌥3 · ⌘5 to jump`
- Position > 9 → `⌘E to jump` (Solo's universal cross-project picker)

## Repo layout

```
pi-solo/
├── pi-extension/solo/
│   ├── index.ts                 ← main extension (MCP client + tool registration)
│   ├── header.ts                ← PI SOLO banner + live status subtitle
│   └── subagents/
│       ├── index.ts             ← subagent tools, commands, task/wake text
│       └── solo-surface.ts      ← thin Solo backend (agent spawn/send/timer/close)
├── themes/
│   └── solo.json                ← bundled `solo` theme (GitHub-dark palette)
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

Built and tested on macOS 14+, Pi 0.74+, **Solo 0.7.1+** (the supported and tested baseline; older Solo versions are not supported). Linux/Windows: untested (Solo is macOS-only anyway).

## License

MIT
