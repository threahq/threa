# Threa agent daemon

Local supervisor for Threa-controlled coding agents.

## V1 intent

Start by moving the existing global spawn-skill behavior into a Bun CLI. The daemon is not a new Threa backend primitive yet; it is a local lifecycle manager over git worktrees, tmux, and the existing bot-runtime/session-link APIs.

## CLI

Initial binary lives at `extensions/agent-daemon/src/index.ts`:

```bash
bun extensions/agent-daemon/src/index.ts doctor
bun extensions/agent-daemon/src/index.ts spawn pi --name explore-foo --branch explore/foo
bun extensions/agent-daemon/src/index.ts spawn claude --name fix-bar --branch fix/bar
bun extensions/agent-daemon/src/index.ts do "spawn a pi agent for long chat performance"
bun extensions/agent-daemon/src/index.ts list
bun extensions/agent-daemon/src/index.ts attach <agent-id-or-name>
bun extensions/agent-daemon/src/index.ts stop <agent-id-or-name>
```

The CLI owns the spawn flows directly:

- creates a git worktree from the configured repo/base ref,
- optionally runs `bun run setup:worktree`,
- launches Pi or Claude Code in a tmux window,
- links Pi with `/remote-control`,
- installs/registers the Claude channel and pre-links its scratchpad when credentials are available.

Runtime binary overrides:

- `THREA_AGENTD_PI_BIN`
- `THREA_AGENTD_CLAUDE_BIN`

## Inventory

V1 inventory is SQLite at `~/.threa/agentd/inventory.sqlite` unless overridden by `THREA_AGENTD_INVENTORY`.

`attach` switches the current tmux client to the managed agent window when already inside tmux. Outside tmux, it selects the window and attaches to the recorded tmux session.

Tracked fields:

- id/name/runtime/status
- worktree/branch
- tmux session/window
- scratchpad URL when available from Pi pane capture or Claude pre-link
- command used to spawn
- last output tail for debugging

The first version briefly used JSON, but SQLite is the intended default because lifecycle reconciliation needs atomic updates and queryable state.

## Minimal inference layer

`agentd do <text>` intentionally stays shallow:

- list/status/inventory -> `list`
- stop/kill/archive `<ref>` -> `stop`
- spawn/start/create/new -> `spawn`
- runtime defaults to Pi unless the text mentions Claude
- branch defaults to `explore/<name>`, with simple `fix/` and `refactor/` hints

This is command smoothing, not planning.

## Next steps

1. Add a manager/control scratchpad that runs Pi + OpenCode Go and calls this CLI.
2. Add reconciliation: inspect tmux windows, mark dead agents offline, preserve inventory across crashes.
3. Add stream/archive cleanup once we have a reliable event source or command path.
4. Add handoff/switching: stop old runtime, start new runtime, reuse/rebind scratchpad where backend support is sufficient.
