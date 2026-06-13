# Sync v2 — workspace sync-head heartbeat

Design for the periodic server→client sync-head heartbeat, the missing
detection half of the sync-v2 cursor system. Decisions recorded here were made
with the owner on 2026-06-12; the implementation ships as one PR with this doc
as its plan.

## Problem

The sync log is populated independently of emit success (inventory doc,
Mechanic 1): the BroadcastHandler sequences every client-routed outbox event
into `sync_log` BEFORE the best-effort Socket.io emit, so a dropped emit always
has a log entry and the client cursor stays behind it. Catch-up replays it —
but only when a trigger fires, and today every trigger is connectivity-shaped:
socket connect/reconnect, browser online flip, page resume. A client whose
transport stays healthy for hours never fires any of them, so a dropped emit
sits unhealed until the user happens to reconnect.

Timeline contiguity (INV-61) closes this gap for stream message rows only — a
missing `broadcastSequence` is visible the moment the next event arrives. All
other gate-registered consumers (labels, saved, scheduled, memos, unread
counters, conversations, workspace metadata) have **no detection at all**
between a drop and the next connectivity trigger. That detection gap is what
this heartbeat closes, and it is the precondition the deletion inventory's
ground rule names: "never delete healing that covers dropped live emits until
a socket heartbeat exists."

## Decisions (owner, 2026-06-12)

1. **Workspace head, room broadcast** — not per-user visible head. One
   set-based `MAX(sync_id)` query across active workspaces per tick, one emit
   per workspace room. The false-positive cost (a no-op catch-up when only
   entries invisible to this user landed) is bounded to at most one cheap
   request per client per interval and is rare in a solo-first product.
2. **Detection only.** The heartbeat triggers catch-up when the client is
   behind; it is NOT a transport-liveness mechanism. Dead transports stay
   covered by socket.io's native pingTimeout and the page-resume probe
   (`pingSocket`).
3. **Rides `sync-v2-cursor` active mode.** The server emits unconditionally
   (clients in `off`/`shadow` or on old builds ignore the event); the client
   handler exists only in active mode, where the gate/cursor machinery lives.
   No new feature flag; flipping `sync-v2-cursor` to `off` also kills
   heartbeat-triggered catch-up.
4. **One PR**: server emitter + client trigger + tests, no healing deletions
   bundled in.
5. **15s interval** (owner choice over the recommended 30s), env-configurable;
   client grace window ~2s. Detection latency bound: ~17s.

## Server design

### `SyncHeartbeatWorker` (new, `apps/backend/src/features/sync/heartbeat-worker.ts`)

Structural twin of `SyncLogReconciliationWorker` (INV-51 colocation): a
`Ticker`-driven class with `start()`/`stop()`, constructed in `server.ts` next
to the reconciliation worker, interval from `SYNC_HEARTBEAT_INTERVAL_MS`
(default **15s**, decision 5).

Each tick:

1. Enumerate workspaces with locally connected sockets from
   `io.sockets.adapter.rooms`, keeping keys matching `/^ws:([^:]+)$/` (the
   bare workspace room, not `:stream:`/`:user:` subrooms or socket-id rooms).
   With the Postgres adapter, `adapter.rooms` is node-local — exactly the set
   this instance is responsible for.
2. No rooms → no query, no emit (idle instances cost nothing).
3. One set-based head query (INV-56) via the new `SyncLogRepository.getHeads`
   beside `getHead`: one `MAX(sync_id)` grouped by workspace over the batch.
   Workspaces absent from `sync_log` report head 0; emitting 0 is harmless
   (no client sits below 0).
4. Per workspace: emit `sync:heartbeat` with `{ workspaceId, head }` to the
   workspace room through the `local` broadcast operator, `head` as a string
   like sync ids everywhere on the wire.

**Why `io.local`:** the backend runs the Socket.io Postgres adapter
(`server.ts:612`), so a plain `io.to(room).emit` fans out through every
instance. Each instance runs its own ticker for its own sockets; without the
`local` flag, N instances would deliver N copies per interval. `local`
restricts delivery to this node's sockets — no leader election, no
duplication. (Duplicates would be _correct_ — the handler is a pure
compare — just wasteful.)

**Why not the outbox:** INV-4 routes domain events through the outbox so log
and emit can't drift. The heartbeat is not a domain event — it carries no
state, is derived (a `MAX` over the log), idempotent, and periodic. Writing it
to the outbox would put one row per workspace per tick into the very log whose
head it reports, advancing the head it measures. It is infrastructure
signaling, same lane as the `health:ping` ack.

**Wire type:** `SyncHeartbeatPayload { workspaceId: string; head: string }` in
`packages/types/src/api.ts` next to `SyncCatchUpResponse`, exported from the
barrel. Event name literal `"sync:heartbeat"`.

### Membership and security

The emit targets the workspace room, which `socket.ts` only admits after a
`UserRepository.findByWorkosUserIdInWorkspace` check on join. The payload is a
single integer that leaks nothing about content — the same number every member
already receives in every catch-up response's `head`.

## Client design

All in `SyncEngine` (`apps/frontend/src/sync/sync-engine.ts`), active mode
only.

### State

- `lastSeenHead: bigint | null` (in-memory, per engine): the highest workspace
  head this client has **proven clean** from catch-up responses. It max-merges
  `response.head` ONLY when a catch-up page comes back empty (plus the
  first-run seed in `initializeActiveCursor`, where the cursor is advanced to
  head anyway). Recording it on a non-empty page would be premature: if a
  later page's fetch fails mid-drain, an inflated `lastSeenHead` would
  suppress the very heartbeat re-trigger that finishes the drain — instead, a
  failed or `MAX_CATCHUP_PAGES`-truncated run leaves `lastSeenHead` behind and
  the next heartbeat retries. Not persisted: on reload, the connect catch-up
  reseeds it before the first heartbeat can matter.

  This is what makes workspace-head comparison sound despite the per-user
  filtered cursor: the cursor advances only past entries visible to this user
  and can sit permanently below workspace head ("head is a freshness hint,
  not a cursor target" — the existing contract in `api.ts` and
  `sync/service.ts` is unchanged). The comparison baseline is
  `position = max(cursor, lastSeenHead)`: a catch-up that drains to an empty
  page proves there is nothing visible in `(cursor, head]`, so heads at or
  below `lastSeenHead` are known-clean without touching the cursor.

### Handler

Registered in `onConnect` on the **raw socket** (not the gate — the payload
carries no `syncId`, must not be buffered during pause, and is not an applied
event), cleaned up alongside the workspace handlers. Logic on
`sync:heartbeat`:

1. Ignore unless active mode, payload's `workspaceId` matches the engine's,
   and `head` parses as a BigInt (same malformed-input tolerance as
   `SyncLogCursor.parseSyncId`).
2. Ignore when the cursor is still null (first connect before
   `initializeActiveCursor` — the connect catch-up owns that window).
3. `position = max(cursor, lastSeenHead)`. `head <= position` → done. This is
   the steady-state path: in a live conversation the cursor tracks the latest
   visible entries and every heartbeat is a no-op compare.
4. Otherwise arm a **grace re-check** (~2s, constant): one pending timer per
   engine, coalescing repeat heartbeats by keeping the max behind-head. When
   it fires, recompute `position`; if it now covers the remembered head, the
   gap was in-flight delivery — done, no fetch.
5. Still behind → `beginCatchUpCycle()` then `runCatchUp("heartbeat")`. The
   catch-up records `lastSeenHead` from its final empty page, so a head
   inflated by entries invisible to this user self-quiets after one no-op
   fetch instead of re-triggering every interval.

**Why the grace window:** the worker reads head from the log, and
sequence-before-emit means the matching emits can still be in flight to this
client when the heartbeat lands (ms-scale, but every tick during active
traffic). Acting immediately would pause the gate mid-conversation for a gap
that closes itself; a 2s re-check absorbs the in-flight window at zero cost.

**Why `beginCatchUpCycle()` (gate pause):** identical to the connect/resume
triggers. Catch-up applies log entries through `gate.dispatch`, and absolute
unread-counter payloads are LWW — a live event applying mid-replay could be
regressed by an older log entry applied after it. Pausing buffers live events
and the existing splice predicate (`appliedThrough`) replays them in order;
the cycle counter already handles a heartbeat trigger landing while a
connect/resume catch-up is in flight (the older run leaves the gate paused,
`runCatchUp` chains one fresh run — `sync-engine.ts` runCatchUp doc).

Teardown: `destroy()` clears the grace timer; the socket listener is removed
with the other handlers. Disconnect during grace is harmless — the timer
re-check compares positions only, and `runCatchUp` already no-ops on a
destroyed engine; a reconnect supersedes via its own cycle.

### Out of scope (deliberately)

- **`shadow` mode**: no handler. Shadow owns no healing; adding parity logging
  is scope creep on a mode that's past its validation purpose.
- **Missed-heartbeat transport probing** (owner decision 2).
- **Cursor jumps to head**: never. The existing contract stands.
- **Deleting any healing**: heartbeat satisfies the inventory's precondition,
  but each deletion remains its own PR with its own coverage proof, and the
  big ones (reconnect-bootstrap slimming, `usePageResumeRefresh`) ALSO require
  sync_log retention (`isLegacyUnreadCounterEntry` must die first). INV-61
  contiguity stays regardless of the heartbeat: it is instant in-band
  detection with placeholder UX; the heartbeat is a ≤interval+grace floor for
  everything else, not a replacement.

## Failure modes considered

- **Worker tick fails** (DB blip): logged, next tick retries — same posture as
  the reconciliation sweep. Detection latency degrades; nothing breaks.
- **Heartbeat emit itself drops**: the next one (15s) carries a fresher head.
  The mechanism is self-healing by repetition; no per-emit durability needed.
- **Catch-up fails or truncates mid-drain**: `lastSeenHead` only advances on
  an empty page, so the unproven head stays ahead of the baseline and the
  next heartbeat re-triggers the drain (pinned by a test).
- **Client behind on an invisible-only gap**: one no-op catch-up, then
  `lastSeenHead` covers it (step 5 above). No loops.
- **Two tabs / two devices**: each engine compares and fetches independently;
  catch-up is idempotent and the cursor store is monotonic cross-tab.
- **Burst of workspaces on one node**: the head query is one statement; emits
  are in-memory fan-out. At Threa's scale (region-sharded, solo-first) this is
  noise; if it ever isn't, the tick can shard the room list.

## Testing plan

Backend (`heartbeat-worker.test.ts`, colocated):

- enumerates only bare `ws:<id>` rooms from a stubbed local adapter rooms map
  (subrooms and socket-id rooms excluded), emits `sync:heartbeat` with the
  per-workspace head via the `local` broadcast operator, skips the DB query
  entirely when no workspace rooms exist, and survives a failing head query.
- `getHeads` is exercised via a stubbed repo like every sibling
  (`appendForWorkspace`, `listEntriesForUser`): the backend has no live-DB
  test harness, so repo SQL is not integration-tested here either.

Frontend (`sync-engine.test.ts` additions):

- heartbeat `head` ≤ `max(cursor, lastSeenHead)` → no catch-up scheduled.
- heartbeat behind → catch-up fires after grace; entries apply through the
  gate (reuse the existing gate-dispatch assertion pattern from #891/#900/#901
  tests).
- gap closed by live events during grace → re-check cancels, no fetch.
- repeat heartbeats during grace coalesce to one catch-up with the max head.
- wrong-workspace payload, malformed head, null cursor, `off`/`shadow` mode →
  ignored.
- empty catch-up response still advances `lastSeenHead`, so the same head
  doesn't re-trigger on the next heartbeat.
- a drain that fails between pages does NOT advance `lastSeenHead`, so the
  next heartbeat at the same head re-triggers and finishes the drain.
