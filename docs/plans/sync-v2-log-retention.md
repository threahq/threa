# Sync v2 — sync_log retention

Design for bounding `sync_log` growth, the gating precondition the deletion
inventory names for the two big healing deletions (reconnect-bootstrap slimming
and the `usePageResumeRefresh` redesign). Decisions recorded here were made with
the owner on 2026-06-13; the implementation ships as one PR with this doc as its
plan.

## Problem

`sync_log` holds one row per client-routed outbox event, forever
(`20260611080000_sync_log.sql`). Catch-up reads entries after a client's cursor
(`listEntriesForUser`) and returns them with no notion of a floor — so the table
grows without bound, and `isLegacyUnreadCounterEntry` exists only because
pre-absolute-field counter entries replay out of the log indefinitely ("no log
retention exists", the comment in `unread-counters.ts`). Until the oldest
entries can age out, that legacy fallback can't die and the engine's reconnect
workspace bootstrap stays the unconditional authority.

Retention is not a one-liner because pruning is unsafe on its own: if entries
below some horizon are deleted, a client whose cursor sits below the pruned
range would have catch-up silently return only the survivors — a data-loss gap.
Pruning must ship together with a floor signal that turns "your cursor predates
the retained log" into a full bootstrap (the authority for everything `<= head`).

## Decisions (owner, 2026-06-13)

1. **30-day horizon with a per-workspace minimum-count floor.** Delete entries
   older than 30 days, but always keep at least the most recent `minKeep`
   (~2,000) per workspace. Time and count have opposite failure modes — pure
   time grows unbounded for a firehose workspace, pure count shrinks the
   healing window for one — and you cannot guarantee both a 30-day window and a
   hard storage cap for an arbitrarily busy workspace. The floor's only job is
   to stop a quiet workspace's returning client from a needless full bootstrap
   when total history is trivially small; the 30-day bound bites first for any
   active workspace. No count _ceiling_ (INV-36: add it only if a runaway
   workspace's storage is ever shown to be a problem, and accept it shortens
   that workspace's window).
2. **Ship the floor-fallback in the same PR.** Pruning + the per-workspace
   `retained_from` watermark + catch-up's `requiresBootstrap` signal + the
   client's below-floor bootstrap fallback are one self-contained, safe slice.
   The actual deletions (`isLegacyUnreadCounterEntry`, bootstrap slimming) remain
   their own follow-up PRs.
3. **No leader election.** Same posture as the reconciliation sweep: the prune
   is one set-based, idempotent DELETE and the floor advances with GREATEST, so
   every backend instance can run its own ticker — after one instance prunes a
   window, the others find nothing due.

## Server design

### Schema (`20260613064500_sync_log_retention.sql`)

- `sync_log_retention_state (workspace_id PK, retained_from BIGINT, updated_at)`
  — `retained_from` is the highest sync_id pruned for the workspace. Entries
  `<= retained_from` are gone; a cursor strictly below it cannot heal from the
  log. Monotonic.
- `idx_sync_log_workspace_created_at` — serves the prune's time-window scan.
  The count floor needs no index: sync ids are dense per workspace, so
  `head - minKeep` is arithmetic.

### `SyncLogRetentionWorker` (new, `features/sync/retention-worker.ts`)

A `Ticker`-driven structural twin of the reconciliation/heartbeat workers
(INV-51), constructed in `server.ts` beside them, interval from
`SYNC_LOG_RETENTION_INTERVAL_MS` (default **1h** — retention is slow-moving, not
latency-bound), horizon from `SYNC_LOG_RETENTION_MS` (default 30 days), floor
from `SYNC_LOG_RETENTION_MIN_KEEP` (default 2,000).

Each tick loops bounded batches (`batchSize` 5,000, `maxBatchesPerRun` 50),
calling `SyncLogRepository.pruneExpiredEntries({ cutoff, minKeep, limit })` and
stopping when a batch's `deletedCount < batchSize` (window drained). One
statement does both the delete and the floor advance:

- victims are rows with `created_at < cutoff` AND `sync_id <= head - minKeep`,
  where `head` comes from `workspace_sync_sequences.next_sequence - 1` (the
  dense allocator, so no MAX-over-log aggregate). `LIMIT`-bounded via a `ctid`
  subquery so a first run over months of backlog doesn't hold one long
  transaction.
- a data-modifying `advanced` CTE upserts each touched workspace's
  `retained_from` with GREATEST (idempotent across runs/instances). Folding it
  into the same statement as the DELETE is load-bearing for catch-up safety
  (below): the delete and the floor advance commit atomically, so a reader that
  observes pruned rows is guaranteed to observe the advanced floor too.

The prunable set is a contiguous sync_id prefix per workspace, so a partial run
is simply retried next tick, and a stale-high floor can only force an
unnecessary bootstrap — never hide a gap.

### Catch-up floor signal (`SyncService.catchUp`)

Read the entries page FIRST, then `getHeadAndRetainedFrom(workspaceId)` (head +
floor in one round trip — the same 2-query cost catch-up had before retention).
If `after < retainedFrom`, return `{ entries: [], head, requiresBootstrap: true }`
(head still read so head-probe seed calls work below the floor). `after ==
retainedFrom` is in-window: the floor is the highest _pruned_ id, so everything
strictly above it still exists. `requiresBootstrap?: boolean` is added to
`SyncCatchUpResponse` (omitted when false, so older clients ignore it).

**Read order is load-bearing (INV-20).** A prune that races a catch-up advances
the floor atomically with deleting the entries. Reading the floor _after_ the
entries guarantees that whenever the entries read observed the deletion, the
floor read observes the advance — so the cursor-below-floor check fires and the
client bootstraps, instead of returning a page that silently omits the pruned
span. Reading the floor first would reopen that gap.

## Client design

In `SyncEngine.performActiveCatchUp` (active mode only — all catch-up triggers
funnel through it, so connect/reconnect/resume/heartbeat are all covered). When
a page comes back with `requiresBootstrap`:

1. `cursorStore.advance(response.head)` — jump the cursor to head. Monotonic
   forward (head `> retainedFrom > after`). Read-before-stamp holds:
   `response.head` was read before the bootstrap fired here, so the stamped
   cursor is a lower bound of the upcoming snapshot (the race falls on the
   duplicate side, never the gap side — same rule as `initializeActiveCursor`).
2. `noteSeenHead(response.head)`, `appliedThrough = head`, then
   `void this.runBootstrap(true)` and return. The `finally` splice
   (`syncId > head || legacy`) drops buffered events `<= head` — the snapshot
   covers them, and re-applying an older LWW counter would regress it — and
   applies only those above.

No loop: after the jump, `after == head > retainedFrom`, so the next catch-up is
in-window. The reconnect bootstrap re-seeds every workspace-scoped projection
(unread counters, labels, saved, scheduled, memos, conversations) — exactly the
authority the inventory keeps for the below-floor case.

## What this unblocks (NOT in this PR)

- **`isLegacyUnreadCounterEntry`** can die once pre-field entries age out below
  the 30-day floor — a follow-up PR (and its own coverage proof) per the
  inventory's one-deletion-per-PR rule.
- **Engine reconnect-bootstrap slimming** and the **`usePageResumeRefresh`
  redesign** lose their "retention is still missing" blocker; they remain their
  own follow-ups.

## Failure modes considered

- **Prune query fails** (DB blip): logged, next tick retries; the table grows a
  little longer, nothing breaks.
- **Partial batch / truncated run**: floor advances only for what was pruned;
  the contiguous-prefix property makes a stale-high floor over-bootstrap at
  worst, never gap.
- **Multiple instances prune concurrently**: idempotent DELETE + GREATEST floor;
  the second instance's batch finds nothing.
- **Client below floor with the bootstrap fetch failing**: the cursor was
  already jumped to head and `runBootstrap(true)` is single-flighted with its
  own reconnect retry chain; the next trigger re-bootstraps. INV-53 bootstrap
  healing covers the window.
- **Quiet workspace, history < minKeep**: `head - minKeep` is negative, no rows
  qualify, nothing is pruned, the returning client catches up from the log.

## Testing plan

Backend (stubbed repo — no live-DB harness, same as the sibling workers):

- `retention-worker.test.ts`: pages bounded batches and advances each
  workspace's floor; stops at `maxBatchesPerRun`; single pass + empty-map
  advance when nothing is due; survives a failing prune.
- `service.test.ts`: `after >= retainedFrom` returns entries normally;
  `after < retainedFrom` returns `{ entries: [], head, requiresBootstrap }` and
  never queries the pruned span; floor 0 never signals bootstrap.
- `handlers.test.ts`: `requiresBootstrap` is forwarded on the wire when set.

Frontend (`sync-engine.test.ts`): a below-floor catch-up jumps the cursor to
head and fires a second (fallback) bootstrap on top of the connect one.
