# Performance reproduction matrix

Twelve scenarios, each with the exact `perf-seed` invocation that builds its
fixture and the capture marks that prove it ran. Operator-run: nothing here is
asserted in CI, because every threshold worth measuring is device-dependent.

Two things are automated: `scripts/perf-seed-plan.test.ts` (32 unit tests over
the pure planning logic) and `tests/browser/perf-capture.spec.ts`, which proves
the capture plumbing works end to end and carries no content. Neither asserts
timings.

## Running a scenario

```bash
# 1. Start the local stack with pinned ports (pin all six — unpinned ports shadow).
#    GLOBAL_RATE_LIMIT_MAX lifts the per-IP cap that binds seeding (playwright.config.ts
#    starts its stack the same way); without it the seeder retries into failure.
GLOBAL_RATE_LIMIT_MAX=10000 \
DEV_TEST_BACKEND_PORT=4001 DEV_TEST_CONTROL_PLANE_PORT=4002 DEV_TEST_ROUTER_PORT=4003 \
DEV_TEST_FRONTEND_PORT=4004 DEV_TEST_BACKOFFICE_ROUTER_PORT=4005 DEV_TEST_BACKOFFICE_PORT=4006 \
  bun run dev:test

# 2. Seed. Idempotent — re-run to top a fixture up.
DEV_TEST_BACKEND_PORT=4001 bun scripts/perf-seed.ts --workspace <workspaceId> --profile large-stream

# 3. Measure. Arm the dev capture, drive the scenario, export.
open 'http://localhost:4004/w/<workspaceId>?perfCapture=1'
#    then in the devtools console:  copy(JSON.stringify(__threaPerfCapture.export()))
```

`--dry-run` prints the outstanding operations without writing. `--help` lists
every profile. The script targets a local stack only; it has no API-key path.
Fixture streams are matched by their `perf-*` slug alone — run against a
throwaway workspace, not one holding channels that happen to share those names.

Message creation is rate-limited per user (120/min), so seeding posts as six
stub authors derived from `--email` (`--authors` to change it). The global
per-IP cap (300/min) binds regardless of author count — hence
`GLOBAL_RATE_LIMIT_MAX` above. `large-stream` still takes several minutes; the
rest are seconds to a minute.

Dev arming (`?perfCapture=1`, or `localStorage['threa:perf:capture'] = '1'`)
measures locally and never uploads — upload requires the consent preference.

## Profiles

| Profile                                     | Builds                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `large-stream`                              | `#perf-large-stream` with 5,000 messages                                                                                      |
| `thread-100` / `thread-500` / `thread-2000` | a channel with one anchor message, and a thread under it with N replies                                                       |
| `missed-entries=<N>`                        | advances the sync log by at least N entries (batches overshoot; the printed delta is authoritative) in `#perf-missed-entries` |
| `drafts`                                    | four empty channels, each holding a staged draft of 1 KB / 10 KB / 100 KB / 256 KB                                            |
| `board-large`                               | 24 channels (four full `BOARD_SYNC_CONCURRENCY = 6` waves), 3 messages each                                                   |

### Hitting a missed-entry boundary

`missed-entries=<N>` is head-delta driven, not arithmetic. The seeder reads the
workspace sync head, posts batches, re-reads the head, and stops once the head
has advanced by **at least N**; it prints the delta it actually achieved.

There is no fixed entries-per-message factor to compute against. One posted
message writes three or more sync-log entries (the message projection, the
user-scoped `activity:created` row, and the conversation attach's stream-scoped
rows), and the count is workload-dependent. Anything that needs an exact
boundary — the 200-entry collapse case in scenario 2 — should read the printed
delta and adjust N, not predict it.

Repeating the profile opens a **fresh** gap: each run marks its messages with a
per-run marker, so `missed-entries=50` twice advances the head by ≥50 twice.
(The other profiles keep top-up idempotency.)

Seed while the client under test is disconnected (close the tab, or seed from a
terminal while parked on another workspace), or the entries arrive live and
there is no gap to catch up on.

## The twelve scenarios

| #   | Scenario                                                  | Seed                                                                  | Marks that prove it                                                                                                                         |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Warm cached hard refresh, no gap                          | `--profile large-stream`                                              | `bootstrap.fetch`, `bootstrap.preRead`, `bootstrap.tx`, `bootstrap.cleanup`, `bootstrap.seed`, `bootstrap.publish`, `bootstrap.rowsWritten` |
| 2   | Warm refresh with 10 / 50 / 199 / 200 missed entries      | `--profile missed-entries=10` (then 50, 199, 200)                     | `catchup.entryApply`, `catchup.replay`, `catchup.collapse`, `catchup.serialReplay` — collapse should appear only at the boundary case       |
| 3   | Cold start, empty IDB                                     | `--profile large-stream`, then clear site data                        | `bootstrap.*` (all phases), `bootstrap.rowsWritten`                                                                                         |
| 4   | Live 10 msg/s burst while typing                          | `--profile large-stream`, then post from a second client while typing | `stream.eventApply`, `stream.idbTransaction`, `draft.staging`, `observer.eventDuration`, `observer.frameGap`                                |
| 5   | Drafts 1 KB / 10 KB / 100 KB / 256 KB                     | `--profile drafts`, then type into each channel's composer            | `draft.staging`, `draft.stagedChars` (absent above the staging cap — that is the signal, not a gap), `editor.externalSync`                  |
| 6   | Shallow vs deep retained history                          | `--profile large-stream` vs a freshly created channel                 | `bootstrap.fetch`, `bootstrap.tx`, `bootstrap.rowsWritten`                                                                                  |
| 7   | Threads 100 / 500 / 2000 events                           | `--profile thread-100` / `thread-500` / `thread-2000`                 | `timeline.windowItems` (must stay viewport-bounded as N grows), `stream.eventApply`, `liveQuery.load`                                       |
| 8   | Board, small vs large stream sets                         | `--profile board-large` vs the default workspace                      | `stream.subscriptions`, `liveQuery.rerun`, `catchup.replay`                                                                                 |
| 9   | Resume with keyboard open, board and panels mounted       | `--profile board-large`                                               | `observer.frameGap`, `observer.eventDuration`, `timeline.windowItems`                                                                       |
| 10  | First code-heavy message vs warmed highlighter            | none — paste a large fenced code block by hand                        | `observer.longTask` (the first paint should be the outlier), `timeline.windowItems`                                                         |
| 11  | Large stash restore through real TipTap                   | `--profile drafts`, reload on the 256 KB channel, then type into it   | `editor.externalSync`, `draft.staging`, `observer.longTask`                                                                                 |
| 12  | Restore → switch stream → return → navigate away and back | `--profile drafts` plus `--profile large-stream`                      | `editor.externalSync`, `stream.subscriptions`, `liveQuery.rerun`, `bootstrap.publish`                                                       |

Scenario 10 has no profile on purpose: what it exercises is one pasted document,
not a seeded shape.

Scenarios 5 and 11 need the operator at the keyboard: `draft.staging` and
`draft.stagedChars` are recorded by `stageDraftContent` on keystrokes. The seed
only builds the bodies to type against — a seeded draft alone emits neither mark.

## Targets

From the performance handover — read these against a capture, never against
desktop feel:

- No bootstrap or catch-up task over 50 ms.
- Frame gaps ≥25 ms (the observer's recording floor — the distribution is censored below it): near zero during bootstrap, none while typing.
- Typing INP p95 under 100 ms on the target mobile device (`observer.eventDuration` records interactions ≥16 ms, so the target is measurable).
- Listener count independent of stream count.
- An unchanged warm bootstrap does zero semantic writes and causes no broad commit.
- Catch-up publishes at most once per bounded chunk.
- Staging duration is not O(document) per keystroke.
- Thread mounted-row count is bounded by the viewport.
- A failed draft restore is visible and recoverable.

## What is deliberately absent

No CI perf assertions, no device-throttling harness (use Chrome DevTools CPU
throttling by hand), no load generator, and nothing that points at staging or
production.
