# Threa harness daemon

Local supervisor for Threa-controlled coding agents.

## V1 intent

Start by moving the existing global spawn-skill behavior into a Bun CLI. The daemon is not a new Threa backend primitive yet; it is a local lifecycle manager over git worktrees, tmux, and the existing bot-runtime/session-link APIs.

## CLI

Initial binary lives at `extensions/harness-daemon/src/index.ts`:

```bash
bun extensions/harness-daemon/src/index.ts doctor
bun extensions/harness-daemon/src/index.ts spawn pi --name explore-foo --branch explore/foo
bun extensions/harness-daemon/src/index.ts spawn claude --name fix-bar --branch fix/bar
bun extensions/harness-daemon/src/index.ts do "spawn a pi agent for long chat performance"
bun extensions/harness-daemon/src/index.ts list
bun extensions/harness-daemon/src/index.ts revive-unarchived [--dry-run]
bun extensions/harness-daemon/src/index.ts attach <agent-id-or-name>
bun extensions/harness-daemon/src/index.ts stop <agent-id-or-name>
```

The CLI owns the spawn flows directly:

- keeps the entrypoint thin (`src/index.ts`) and splits inventory, tmux, worktree, runtime spawners, shell helpers, and command dispatch into separate modules,
- creates a git worktree from the configured repo/base ref,
- optionally runs `bun run setup:worktree`,
- launches Pi or Claude Code in a tmux window,
- links Pi with `/remote-control`,
- installs/registers the Claude channel and pre-links its scratchpad when credentials are available.

Runtime binary overrides:

- `THREA_HARNESSD_PI_BIN`
- `THREA_HARNESSD_CLAUDE_BIN`

## Inventory

V1 inventory is SQLite at `~/.threa/harnessd/inventory.sqlite` unless overridden by `THREA_HARNESSD_INVENTORY`.

`attach` switches the current tmux client to the managed agent window when already inside tmux. Outside tmux, it selects the window and attaches to the recorded tmux session.

Tracked fields:

- id/name/runtime/status
- worktree/branch
- tmux session/window
- scratchpad URL when available from Pi pane capture or Claude pre-link
- command used to spawn
- runtime instance/session IDs needed to reattach the same scratchpad
- last output tail for debugging

`revive-unarchived` checks each offline inventory entry's scratchpad through the public API and skips archived, inaccessible, or missing streams. For an active stream it restores the original worktree when possible, preflights the stored runtime identity with `ifArchived: "wait"`, verifies the returned root stream, then relaunches Claude with `server:threa-channel` or Pi with its original `--session-id`. Every skip is logged with its reason.

The first version briefly used JSON, but SQLite is the intended default because lifecycle reconciliation needs atomic updates and queryable state.

## Minimal inference layer

`harnessd do <text>` intentionally stays shallow:

- list/status/inventory -> `list`
- stop/kill/archive `<ref>` -> `stop`
- spawn/start/create/new -> `spawn`
- runtime defaults to Pi unless the text mentions Claude
- branch defaults to `explore/<name>`, with simple `fix/` and `refactor/` hints

This is command smoothing, not planning.

## Next steps

1. Add a manager/control scratchpad that runs Pi + OpenCode Go and calls this CLI.
2. Add reconciliation: inspect tmux windows and mark dead agents offline.
3. Add stream/archive cleanup once we have a reliable event source or command path.
4. Add handoff/switching: stop old runtime, start new runtime, reuse/rebind scratchpad where backend support is sufficient.
