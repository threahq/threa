# harness-daemon

Local supervisor for Threa-linked agent sessions (Claude Code channel + Pi remote). `spawn` creates worktree + tmux window + harness and records the launch in `~/.threa/harnessd/inventory.sqlite`; `up` and the `watch-unarchived` LaunchAgent revive recorded sessions safely; `adopt` brings a hand-started Claude session into inventory, live or cold. `kick <ref>` sends Enter to a managed session (the same nudge exposed as `/kick` in its linked scratchpad). If a Claude channel session was launched by the standalone worktree helper and has no inventory row, `kick` can still resolve its exact runtime session ID from a live `server:threa-channel` tmux pane and nudge it without adopting or reviving it. Run `threa-harnessd help` for the full command list.

## Live reconnect

`threa-harnessd reconnect <runtime-session-id> --root-stream-id <stream-id> [--force]` replaces a live Pi or Claude process in its existing tmux pane and resumes the same native session. It accepts only the narrow Threa launch shapes, preflights the exact linked root with create/replace disabled, then revalidates the pane generation before `tmux respawn-pane`. Claude reconnect additionally requires an idle, exact live registry entry and transcript, and verifies the replacement kept the same native UUID and cwd; `--force` permits replacing a busy Claude session. Managed inventory is preferred; a matching standalone pane may be used without writing or adopting it. Missing, ambiguous, stale, unsupported, or mismatched targets fail without launching a fresh session.

## Adoption and cold takeover

`threa-harnessd adopt <runtime-session-id> --root-stream-id <stream-id> [--cwd <path>] [--name <name>] [--claude-session-id <uuid>] [--tmux <session>] [--dry-run] [--force] [--no-yolo]`

Brings a Claude channel session harnessd never launched under management. A hand-started session can have a valid deterministic identity, a live scratchpad and a full transcript and still be invisible: `reconnect` needs a live pane, `up` needs an inventory row, and a session with neither falls between them the moment its process exits.

One explicit target per invocation, identified by runtime session id **and** root stream id. Nothing here sweeps: a local Claude directory has never been evidence that a session should run.

Two paths, chosen by what is live:

- **live pane** — the session is running. It is recorded in inventory and left alone; no relaunch, no keystrokes.
- **cold takeover** — the pane and process are gone. The newest transcript under the cwd's `~/.claude/projects` directory is resumed (`--claude-session-id` pins a specific one) in a new tmux window, with harnessd's Claude command and `--mcp-config` wiring, `THREA_COLD_START_IF_ARCHIVED=wait` / `IF_MISSING=error` pinned to the given root, and the boot dialogs cleared by the same polling loop `spawn` and `reconnect` use. Bypass follows the adopted session — the live pane's own launch first, then what the row recorded — and `--no-yolo` overrides.

Everything is validated before anything changes. `--cwd`, the live pane, the harness link record (`~/.threa/harnessd/links/<session>.json`) and any inventory row must agree on the working directory; the link record and the row must agree with `--root-stream-id`; the instance id must be consistent across every source that names one; the scratchpad must read active. Only then does the bot-runtime preflight run (`ifArchived: "wait"`, `ifMissing: "error"`, returned root must equal the recorded one). A refusal writes no inventory, launches nothing, and never touches the scratchpad. `--dry-run` stops before the preflight, because that POST registers the session server-side.

Identity must be _attested_, not merely derivable. The cwd derivation (`sha256("<host>:<cwd>")`) is the usual attestation, but a session started under a different hostname keeps its original id for life, so the link record or an existing row attests it instead. What is refused is a target nothing on this machine binds to that directory.

Idempotent: a second run against the same live pane reuses the row (`already managed`) rather than adding one, and a name already taken by a different session refuses with `--name` as the fix.

| status                                                              | meaning                                                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `adopted live`                                                      | unmanaged live pane, now recorded; nothing relaunched                                                                             |
| `already managed`                                                   | the row already tracks this live pane                                                                                             |
| `taken over`                                                        | pane and process gone; the transcript was resumed in a new window                                                                 |
| `would adopt live` / `would take over`                              | `--dry-run`                                                                                                                       |
| `refused live without pane`                                         | a Claude process still runs in the cwd with no tmux pane — resuming would give two Claudes one conversation (`--force` overrides) |
| `refused missing transcript`                                        | no `~/.claude/projects` transcript for the cwd, or the pinned uuid has none                                                       |
| `refused identity mismatch`                                         | sources disagree on cwd, root stream, or instance id; or nothing binds the id to the directory                                    |
| `refused ambiguous`                                                 | two inventory rows, two panes, or a name collision                                                                                |
| `refused archived` / `refused inaccessible` / `refused unavailable` | scratchpad state, before or during the takeover (mid-takeover kills the new window)                                               |
| `refused missing cwd` / `refused missing credentials`               | no directory or no Threa credentials                                                                                              |
| `failed`                                                            | the launch or the post-launch inventory write errored; the window is killed rather than left untracked                            |

An adopted session is an ordinary inventory row afterwards, so `up`, `kick`, `stop` and the watcher all apply — and since `up` now resumes the worktree's conversation too, the history survives an automatic revival as well.

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
| `skipped occupied`            | a live Claude process already sits in the worktree (process table, not tmux) — never launch a second one on one conversation       |
| `skipped identity mismatch`   | scratchpad origin/workspace differs from config, Pi link bound to another stream, or preflight returned a different `rootStreamId` |

Flags:

- `--dry-run` — print the per-agent decisions and stop: no launches, no worktree changes, no server-state mutation, no lock taken, and a missing inventory file is never created. Exits before the bot-runtime preflight (that POST registers the session server-side), so it can't detect a preflight-level identity mismatch — everything else is exact, including restorability of a missing worktree. (A legacy inventory already on disk may still be schema-migrated in place when read.)
- `--recreate-worktree` — opt in to restoring a pruned worktree from the recorded repo + branch. Default is `skipped missing cwd`.
- `--tmux <session>` — target tmux session.

Hard guarantees, regardless of flags:

- Eligibility is checked against `GET /api/v1/workspaces/:ws/streams/:id`; archived, deleted, and inaccessible scratchpads never start.
- Revival preflights `POST /api/v1/workspaces/:ws/bot-runtime/sessions` with `ifArchived: "wait"` and `ifMissing: "error"`, and requires the returned `rootStreamId` to equal the recorded stream — it never creates a replacement scratchpad; a would-be different stream is refused as `skipped identity mismatch`.
- Claude sessions launch against the `threa-channel` MCP server (stale `threa` registrations are rewritten, `THREA_CHANNEL_SERVER_KEY=threa-channel` enforced) with `--dangerously-skip-permissions` unless the original launch recorded `--no-yolo`.
- A Claude revival **resumes the worktree's conversation** (`--resume <newest transcript>`), so "back up" includes the history rather than an empty session on the same scratchpad. A transcript a live process still holds is skipped, never shared; a worktree with no transcript starts fresh.
- Liveness has two independent sources: the tmux pane, and the Claude process table (`~/.claude/sessions/<pid>.json` corroborated against `ps -o lstart`). Either one saying "alive" refuses the launch. The pane check alone let nine consecutive passes each start another Claude in one worktree on 2026-07-28.
- Nothing is typed into a revived session beyond the boot dialogs. Claude's own `/remote-control` (the mobile app / claude.ai/code) is **not** how a session reaches Threa — the channel MCP server is — and sending it parked every revival in a modal dialog (`"waitingFor":"dialog open"`). Set `THREA_HARNESSD_CLAUDE_REMOTE_CONTROL=1` to opt back in.
- Pi sessions only reattach with their exact recorded `--session-id` and an enabled remote link bound to the same root stream.
- After a launch, the scratchpad is re-checked: archived/inaccessible mid-launch → the new window is killed and the agent recorded `error`, never `online` (a wedged runtime would otherwise read as `already running` forever). If the post-launch inventory write fails, the window is killed rather than left running untracked under stale inventory fields.
- Passes serialize through a pid-owned file lock (`resume-active.lock` beside the inventory) with stale-holder recovery — a crashed pass's lock is stolen on the next run instead of wedging every future revival (the old tmux `wait-for` lock survived its owner until the tmux server restarted).

`watch-unarchived` / `boot-resume` run the same pass from the supervisor socket and DO restore pruned worktrees: unarchiving a scratchpad on Threa is an explicit revive request.

## Why `up` is strict (2026-07-20 incident)

"Kick the Claude sessions" was handled by hand: the genuinely live sessions were restarted correctly, but a second pass then relaunched every recent Claude worktree whose directory still existed — without checking whether the linked scratchpads were archived. Five archived/parked sessions (hide-drafts-archived-streams, hide-drafts-archived-streams-follow-up, make-staging-cheaper, deepen-github-integration, seer-support-multiple-users) came back to life and had to be killed again.

The lesson `up` encodes: a local worktree directory is not evidence a session should run — the scratchpad's live state on Threa is. Inventory rows are only candidates; the stream lookup decides, archived/inaccessible streams never start, missing worktrees are a skip rather than a trigger to rebuild, and nothing (scratchpads, streams, sessions) is ever created as a side effect of bringing things back up.
