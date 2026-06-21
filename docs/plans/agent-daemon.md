# Threa agent daemon

Local supervisor for Threa-controlled coding agents.

## V1 intent

Start by formalizing the existing global spawn skills into a Bun CLI. The daemon is not a new Threa backend primitive yet; it is a local lifecycle manager over tmux plus the existing bot-runtime/session-link APIs.

## CLI

Initial binary lives at `apps/agent-daemon/src/index.ts`:

```bash
bun apps/agent-daemon/src/index.ts doctor
bun apps/agent-daemon/src/index.ts spawn pi --name explore-foo --branch explore/foo
bun apps/agent-daemon/src/index.ts spawn claude --name fix-bar --branch fix/bar
bun apps/agent-daemon/src/index.ts do "spawn a pi agent for long chat performance"
bun apps/agent-daemon/src/index.ts list
bun apps/agent-daemon/src/index.ts attach <agent-id-or-name>
bun apps/agent-daemon/src/index.ts stop <agent-id-or-name>
```

The CLI delegates to the existing global skill scripts:

- `/Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-pi-remote-worktree/spawn.sh`
- `/Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-claude-channel-worktree/spawn.sh`

## Inventory

V1 inventory is SQLite at `~/.threa/agentd/inventory.sqlite` unless overridden by `THREA_AGENTD_INVENTORY`.

Tracked fields:

- id/name/runtime/status
- worktree/branch
- tmux session/window
- scratchpad URL when parseable from the spawn output
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
