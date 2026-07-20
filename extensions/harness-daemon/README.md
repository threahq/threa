# harness-daemon

Local supervisor for Threa-linked agent sessions (Claude Code channel + Pi remote). `spawn` creates worktree + tmux window + harness and records the launch in `~/.threa/harnessd/inventory.sqlite`; `up` and the `watch-unarchived` LaunchAgent revive recorded sessions safely. Run `threa-harnessd help` for the full command list.

## `up` (alias `resume-active`)

Brings every eligible recorded session back up. Safe to rerun: each pass is a no-op for anything already running, and the decision is driven by the **live scratchpad state on Threa**, never by which local directories happen to exist.

A session starts only when ALL of these hold; otherwise it is reported with a skip status:

| status                        | meaning                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `started`                     | revived into a new tmux window                                                                                                     |
| `already running`             | surviving tmux window found — never double-starts                                                                                  |
| `would start`                 | dry-run only: passed every eligibility check                                                                                       |
| `failed`                      | launch attempt errored (recorded in inventory as `error`)                                                                          |
| `skipped stopped`             | explicitly stopped via `threa-harnessd stop`                                                                                       |
| `skipped missing link`        | no/invalid scratchpad URL recorded                                                                                                 |
| `skipped missing credentials` | no workspace id / API key configured                                                                                               |
| `skipped archived`            | linked scratchpad is archived on Threa                                                                                             |
| `skipped inaccessible`        | stream 403/404 — deleted or out of scope                                                                                           |
| `skipped unavailable`         | Threa unreachable (5xx/timeout, or 429 after retries) — pass stops early                                                           |
| `skipped missing session id`  | Pi without its original `--session-id` / remote link, or half-recorded Claude identity                                             |
| `skipped missing cwd`         | worktree dir gone (see `--recreate-worktree`)                                                                                      |
| `skipped identity mismatch`   | scratchpad origin/workspace differs from config, Pi link bound to another stream, or preflight returned a different `rootStreamId` |

Flags:

- `--dry-run` — print the per-agent decisions and stop before any side effect. Exits before the bot-runtime preflight (that POST registers the session server-side), so it can't detect a preflight-level identity mismatch — everything else is exact.
- `--recreate-worktree` — opt in to restoring a pruned worktree from the recorded repo + branch. Default is `skipped missing cwd`.
- `--tmux <session>` — target tmux session.

Hard guarantees, regardless of flags:

- Eligibility is checked against `GET /api/v1/workspaces/:ws/streams/:id`; archived, deleted, and inaccessible scratchpads never start.
- Revival preflights `POST /api/v1/workspaces/:ws/bot-runtime/sessions` with `ifArchived: "wait"` and `ifMissing: "error"`, and requires the returned `rootStreamId` to equal the recorded stream — it never creates a replacement scratchpad; a would-be different stream is refused as `skipped identity mismatch`.
- Claude sessions launch against the `threa-channel` MCP server (stale `threa` registrations are rewritten, `THREA_CHANNEL_SERVER_KEY=threa-channel` enforced) with `--dangerously-skip-permissions` unless the original launch recorded `--no-yolo`.
- Pi sessions only reattach with their exact recorded `--session-id` and an enabled remote link bound to the same root stream.

`watch-unarchived` / `boot-resume` run the same pass from the supervisor socket and DO restore pruned worktrees: unarchiving a scratchpad on Threa is an explicit revive request.

## Why `up` is strict (2026-07-20 incident)

"Kick the Claude sessions" was handled by hand: the genuinely live sessions were restarted correctly, but a second pass then relaunched every recent Claude worktree whose directory still existed — without checking whether the linked scratchpads were archived. Five archived/parked sessions (hide-drafts-archived-streams, hide-drafts-archived-streams-follow-up, make-staging-cheaper, deepen-github-integration, seer-support-multiple-users) came back to life and had to be killed again.

The lesson `up` encodes: a local worktree directory is not evidence a session should run — the scratchpad's live state on Threa is. Inventory rows are only candidates; the stream lookup decides, archived/inaccessible streams never start, missing worktrees are a skip rather than a trigger to rebuild, and nothing (scratchpads, streams, sessions) is ever created as a side effect of bringing things back up.
