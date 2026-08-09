# Performance reproduction matrix

Thirteen scenarios, each with the exact `perf-seed` invocation that builds its
fixture and the capture marks that prove it ran. Operator-run: nothing here is
asserted in CI, because every threshold worth measuring is device-dependent.

Two things are automated: `scripts/perf-seed-plan.test.ts` (unit tests over the
pure planning logic) and `tests/browser/perf-capture.spec.ts`, which proves
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

| Profile                                     | Builds                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `large-stream`                              | `#perf-large-stream` with 5,000 messages                                                                                          |
| `thread-100` / `thread-500` / `thread-2000` | a channel with one anchor message, and a thread under it with N replies                                                           |
| `missed-entries=<N>`                        | advances the sync log by at least N entries (batches overshoot; the printed delta is authoritative) in `#perf-missed-entries`     |
| `drafts`                                    | four empty channels, each holding a staged draft of 1 KB / 10 KB / 100 KB / 256 KB                                                |
| `board-large`                               | 24 channels (four full `BOARD_SYNC_CONCURRENCY = 6` waves), 3 messages each                                                       |
| `workspace-wide`                            | 60 channels (`WORKSPACE_WIDE_STREAM_COUNT`, above Dexie's 50-row FULL_RANGE threshold), 1 message each so every row has a preview |

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

## The fifteen scenarios

| #   | Scenario                                                  | Seed                                                                                           | Marks that prove it                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Warm cached hard refresh, no gap                          | `--profile large-stream`                                                                       | `bootstrap.fetch`, `bootstrap.preRead`, `bootstrap.tx`, `bootstrap.cleanup`, `bootstrap.seed`, `bootstrap.publish`, `bootstrap.rowsWritten`                                                                                                                   |
| 2   | Warm refresh with 10 / 50 / 199 / 200 missed entries      | `--profile missed-entries=10` (then 50, 199, 200)                                              | `catchup.entryApply`, `catchup.replay`, `catchup.collapse`, `catchup.serialReplay` — collapse should appear only at the boundary case                                                                                                                         |
| 3   | Cold start, empty IDB                                     | `--profile large-stream`, then clear site data                                                 | `bootstrap.*` (all phases), `bootstrap.rowsWritten`                                                                                                                                                                                                           |
| 4   | Live 10 msg/s burst while typing                          | `--profile large-stream`, then post from a second client while typing                          | `stream.eventApply`, `stream.idbTransaction`, `draft.staging`, `observer.eventDuration`, `observer.frameGap`                                                                                                                                                  |
| 5   | Drafts 1 KB / 10 KB / 100 KB / 256 KB                     | `--profile drafts`, then type into each channel's composer                                     | `draft.staging`, `draft.stagedChars` (absent above the staging cap — that is the signal, not a gap), `editor.externalSync`                                                                                                                                    |
| 6   | Shallow vs deep retained history                          | `--profile large-stream` vs a freshly created channel                                          | `bootstrap.fetch`, `bootstrap.tx`, `bootstrap.rowsWritten`                                                                                                                                                                                                    |
| 7   | Threads 100 / 500 / 2000 events                           | `--profile thread-100` / `thread-500` / `thread-2000`                                          | `timeline.windowItems` (must stay viewport-bounded as N grows), `stream.eventApply`, `liveQuery.load`                                                                                                                                                         |
| 8   | Board, small vs large stream sets                         | `--profile board-large` vs the default workspace                                               | `stream.subscriptions`, `liveQuery.rerun`, `catchup.replay`                                                                                                                                                                                                   |
| 9   | Resume with keyboard open, board and panels mounted       | `--profile board-large`                                                                        | `observer.frameGap`, `observer.eventDuration`, `timeline.windowItems`                                                                                                                                                                                         |
| 10  | First code-heavy message vs warmed highlighter            | none — paste a large fenced code block by hand                                                 | `observer.longTask` (the first paint should be the outlier), `timeline.windowItems`                                                                                                                                                                           |
| 11  | Large stash restore through real TipTap                   | `--profile drafts`, reload on the 256 KB channel, then type into it                            | `editor.externalSync`, `draft.staging`, `observer.longTask`                                                                                                                                                                                                   |
| 12  | Restore → switch stream → return → navigate away and back | `--profile drafts` plus `--profile large-stream`                                               | `editor.externalSync`, `stream.subscriptions`, `liveQuery.rerun`, `bootstrap.publish`                                                                                                                                                                         |
| 13  | Unchanged warm refresh, wide workspace                    | `--profile workspace-wide`, then hard-refresh twice with no new messages (read the third load) | `bootstrap.preRead` + `bootstrap.tx` (the comparable number), `bootstrap.rowsWritten`, `bootstrap.rowsSkipped`, `bootstrap.diff`, `bootstrap.storePublish`, `bootstrap.cachePublish`, `bootstrap.cleanup`                                                     |
| 14  | One incoming message into a deep scroll-back window       | `--profile large-stream`, scroll up ten pages, then post from a second client                  | `timeline.tailLoad` (bounded and flat as the scroll-back deepens), `liveQuery.load`, `timeline.derive` (samples sum to the whole derivation chain — one per memo in it), `timeline.windowItems` (identical between arms — a change here is a correctness bug) |
| 15  | One incoming message into an open member stream           | `--profile large-stream`, open the channel, then post from a second client (phone)             | `stream.eventApply`, `stream.eventTx`, `stream.contextRows`, `stream.activityApply`, `stream.liveCommitFold`, `stream.eventDuplicate`, `stream.idbTransaction`                                                                                                |

### Reading `liveQuery.rerun` / `liveQuery.load` (scenarios 7, 8, 14)

Both marks aggregate across every mounted `useStreamEvents` instance — five on a
stream page, twenty-four or more on the board — so a sample cannot be attributed
to one timeline. Disambiguating would mean a per-caller mark name and the
registry is closed on purpose (D15), so read them as a page total.

They also cover only part of a floored read: the window is split into an
immutable tail and a widening prefix, and only the prefix emits
`liveQuery.rerun`/`liveQuery.load`. `timeline.tailLoad` is the tail read's own
mark — its duration is the cost of the read a live arrival triggers. Any
comparison against a capture taken before the split (pre-#1745) is prefix-only
after against whole-read before, not the same population.

### Reading `stream.idbTransaction` / `stream.activityApply` (scenarios 4, 15)

`stream.idbTransaction` counts the per-message write transactions the sync path
opens: the event-write transaction (`stream-sync.ts`), the local context-row
transaction (`putLocalContextRows`), and the single `LiveCommitBatch.commit`
that carries the counter and preview together. It does not count catch-up
flushes — those are per window, not per message — so read it only in a
live-delivery scenario.

`stream.activityApply` is the handler body — one sample per `stream:activity`,
covering two buffer pushes, so it is near zero. Read it as "what the handler
costs the task", never as the cost of the write.

The fold has its own name, `stream.liveCommitFold` — one sample per flush,
covering the awaited transaction and the single bootstrap publication. Its count
against the `stream.activityApply` count is the coalescing ratio. The two names
are separate populations on purpose: mixed under one name, N near-zero handler
samples plus one awaited fold sample makes the path look faster or slower
depending on which statistic the reader takes.

Caveat for scenario 15: one binding per (event source, stream) means the cheap
duplicate apply is gone, so the mean of `stream.eventApply` reads **higher** than
a pre-#1764 capture even though the total work halved. Compare sample counts ×
mean, not means.

### Scenario 13 — reading the unchanged warm refresh

`workspace-wide` is the only profile that crosses Dexie's 50-row threshold in
`streams` and `streamMemberships`, which is the amplifier the bootstrap diff
removes. The diff is now unconditional, so this is a single-arm reading — load,
hard-refresh, hard-refresh again, then idle, and read `bootstrap.preRead`,
`bootstrap.diff` and the written/skipped row counts on the third load:

```bash
open 'http://localhost:4004/w/<workspaceId>?perfCapture=1'
#    devtools console, on the third load: copy(JSON.stringify(__threaPerfCapture.export()))
```

A before/after against the pre-diff behaviour needs a build swap (the flag that
used to provide it was deleted once the rollout finished).

What to read — the _third_ load's samples. Load 2 still writes: the first load's
read watermark and `counterTouchedAt` settle against the previous fetch window,
so its rows differ for a real reason; load 3 is the honest unchanged arm.

| Claim                                  | Mark                                 | Expected                                   |
| -------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Zero semantic row writes               | `bootstrap.rowsWritten`              | `0`                                        |
| The skip is real, not an empty payload | `bootstrap.rowsSkipped`              | ≈ the payload's row count                  |
| Transaction cost collapses             | `bootstrap.preRead` + `bootstrap.tx` | reads only; see the caveat below           |
| The diff is not the new cost           | `bootstrap.diff`                     | small relative to the `tx` delta           |
| No coarse cache publication            | `bootstrap.storePublish`             | absent                                     |
| No TanStack bootstrap replacement      | `bootstrap.cachePublish`             | absent                                     |
| Cleanup untouched                      | `bootstrap.cleanup`                  | unchanged between arms — a change is a bug |

Three caveats, all load-bearing:

- **Read the third load, not the second.** Reading load 2 reports settling as a
  regression and hides the steady state the flag is supposed to reach.

- **`preRead + tx` is the comparable number.** With the diff on, every table's
  read moves inside the `rw` transaction so read → compare → write is atomic, so
  `bootstrap.preRead` folds into `bootstrap.tx`. Comparing `tx` alone across the
  arms compares different spans.
- **"Unchanged" means no new messages since the previous apply.** A stream row's
  `lastMessagePreview` is written at a different fidelity by the socket path than
  by the bootstrap payload, so a workspace with activity since the last apply
  genuinely rewrites those rows — a heal, not a false diff. On a live workspace
  expect a large reduction, not a zero.

`stream.eventApply` is wall clock around a handler that awaits, so it includes
main-thread contention from the renders its own writes wake — its samples do not
sum from `stream.eventTx` + `stream.contextRows`.

Three things to check before reading a scenario-15 capture, each of which
otherwise produces a confident wrong conclusion:

- `stream.eventDuplicate` counts **every** delivery whose event row already
  existed — the double-registered twin, the gate's resume-splice redelivery, and
  the ordinary bootstrap/catch-up overlap. Read it only on a live message with no
  reconnect inside the capture window; a non-zero count after a reconnect does not
  mean a de-duplication failed.
- The ring holds 2000 non-`bootstrap.` samples, and an open double-registered
  stream now emits ~12 per message. That is roughly 150 messages, and a 200-entry
  catch-up overflows it. Capture scenario 15 over a short freshly-armed window, or
  export immediately (`__threaPerfCapture.export()`), rather than reading marks off
  a long session.
- The region backend drops samples whose names its build does not know
  (`features/perf-diagnostics/handlers.ts`), and Pages deploys ahead of Railway. In
  that window an uploaded capture shows the sub-marks as **absent**, which looks
  identical to "they measured ~0". Confirm the backend is on this build, or read the
  capture from devtools instead of the uploaded row.

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
