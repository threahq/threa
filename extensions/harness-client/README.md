# @threahq/harness-client

Helpers shared by the Threa harness daemon (harnessd) and the tmux-driven runtimes it supervises, such as
`@threahq/claude-code-remote` and `@threahq/pi-remote`. A connector uses it to record its harness link, ask harnessd to
kick, reconnect, clear or spawn a session, send an allowlisted key to its own tmux pane, and listen on the supervisor
socket.

Most code wants [`@threahq/remote-session`](https://www.npmjs.com/package/@threahq/remote-session) or
[`@threahq/bot-runtime-client`](https://www.npmjs.com/package/@threahq/bot-runtime-client) instead. This package only
matters to a runtime harnessd runs.

## Finding harnessd

harnessd runs from a checkout of the Threa repo and sets `THREA_HARNESSD_ENTRYPOINT` and `THREA_HARNESSD_BUN_BIN` for
every runtime it launches. A runtime started any other way finds no harnessd: `harnessReconnectAvailable()` is false
and `runHarnessKick` fails with an error naming the entrypoint it looked for.

## State on disk

Link records, presence snapshots and wake notes live under `~/.threa/harnessd/` (`links/`, `presence/`, `wake/`).
`THREA_HARNESS_LINKS_DIR`, `THREA_HARNESS_PRESENCE_DIR` and `THREA_HARNESS_WAKE_NOTES_DIR` move each one.
