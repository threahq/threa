---
title: Sync Log
status: shipped
audience: internal
kind: subsystem
invariants: [INV-53, INV-62]
entry_points:
  - apps/backend/src/db/migrations/20260611080000_sync_log.sql
  - apps/backend/src/lib/outbox/broadcast-handler.ts
  - apps/backend/src/lib/outbox/delivery-groups.ts
  - apps/backend/src/features/sync/repository.ts
  - apps/backend/src/features/sync/service.ts
  - apps/backend/src/features/sync/heartbeat-worker.ts
  - apps/backend/src/features/sync/reconciliation-worker.ts
  - apps/backend/src/features/sync/retention-worker.ts
public_site: false
summary: >
  A durable per-workspace ordered log of every client-visible change, tagged with
  delivery groups, so a reconnecting client replays exactly what it missed and is
  allowed to see.
related: [architecture/outbox-pattern.md, architecture/sync-engine.md, concepts/subscribe-then-bootstrap.md]
---

## The gist

The outbox makes live delivery reliable up to the socket emit. The sync log is what
makes a missed emit recoverable.

Every client-visible change becomes one row in `sync_log`, keyed by a dense, gapless
per-workspace `sync_id` and tagged with the delivery groups that decide who may see it:
`workspace`, `user:<id>`, `stream:<id>`, `permission:<slug>`. The socket emit is
best-effort; the log row is the durable record. A client holds one cursor per workspace
(the highest `sync_id` it has applied) and, on connect or reconnect, asks the backend for
everything after that cursor that its groups admit. The backend filters the log by the
same access rule the rest of the app uses and returns the entries in order.

That is the whole idea: one ordered log per workspace, filtered per viewer, replayable
from a cursor. This is the backend half of
[subscribe-then-bootstrap](../concepts/subscribe-then-bootstrap.md). The client
([sync-engine](sync-engine.md)) owns the cursor, the reconnect choreography, and writing
entries into IndexedDB; the log is what it reads from.

## How it works

**One dense sequence per workspace.** Entries are stamped by
`SyncLogRepository.appendForWorkspace`, which bumps a per-workspace `next_sequence`
counter row (`workspace_sync_sequences`) and assigns each entry the next id. The ids are
gapless and strictly ordered within a workspace, so a viewer holding `sync_id` N has, by
definition, already seen every admissible id below N. The counter row also serializes
concurrent writers, so two batches never collide on an id.

**Write side: log first, then emit.** When the outbox dispatcher hands a batch to
`BroadcastHandler`, `sequenceEvents` runs before any socket emit. For each event it calls
`resolveDeliveryGroups` to compute the groups. Bot-scoped events (`groups` is `null`) are
dispatched to the `/bot` namespace instead of the log; events that are unroutable (empty
groups) or missing a `workspaceId` are dropped; everything else is written to `sync_log`. The assigned `sync_id` is spread onto the wire payload, so a live socket
recipient and a catch-up recipient apply the same stamped event. Because the log write
precedes the emit and is idempotent on `outbox_event_id` (a unique index), a crash between
log and emit loses nothing: the row is already durable, and the reconciliation worker
below will deliver it.

**Delivery groups decide reach and replay together.** `resolveDeliveryGroups`
(`delivery-groups.ts`) maps each event to the groups allowed to receive it. Most stream
events route to `stream:<id>`; per-user surfaces (read state, drafts, saved, preferences,
notification level) route to `user:<authorId>` or `user:<targetUserId>`; invitations route
to `permission:members:write`; public stream creation and workspace-wide changes route to
`workspace`. The same group set drives both the live socket room and the catch-up filter,
so a reconnecting client can never be admitted to something live delivery would have
withheld, nor denied something it would have received.

**Read side: catch-up.** `SyncService.catchUp` reads
`SyncLogRepository.listEntriesForUser(workspaceId, userId, permissionGroups, after,
limit)`. An entry is admitted when its groups overlap `workspace`, the caller's
`user:<id>`, or a permission group the caller's role holds, or when the entry targets a
stream the caller may read. Stream visibility is computed in a `visible_streams` CTE that
shares the exact access leaf (`rootReadableConditionSql`) with `streamAccessPredicateSql`,
so catch-up resolves public roots without a membership row and threads through their root
(INV-62) the same way every other access check does. Each stream grant is bounded below by
the caller's join position (the `sync_id` of their `stream:member_added` entry), so joining
a private stream never replays its pre-join history; public roots get bound 0 because their
history is readable regardless of join.

**The cursor and the head.** The client seeds its cursor from the log head on first
connect (it reads the `head` before the bootstrap snapshot, so the cursor is a lower bound
on what the snapshot contains), then advances it as it applies entries. A 15s heartbeat
(`SyncHeartbeatWorker`) broadcasts each active workspace's current head to its room
(`sync:heartbeat`), so a client whose transport stays healthy but quiet still notices it
has fallen behind and runs a catch-up. The heartbeat is deliberately not an outbox event;
logging it would advance the head it measures.

If you only need the mental model, stop here. The rest is the reference layer.

## Details worth knowing

### Catch-up is bounded by retention

`catchUp` reads the entries first, then the `retained_from` floor, in that order. If a
prune raced and advanced the floor past the caller's `after`, reading the floor second
guarantees the service sees the deletion and returns `requiresBootstrap` instead of a
silent gap. `retained_from` is the highest pruned id, so `after == retained_from` is still
in-window.

### Retention

`SyncLogRetentionWorker` runs hourly and prunes entries older than 30 days, keeping at
least the 2000 most recent per workspace so quiet workspaces stay replayable.
`pruneExpiredEntries` deletes the rows and advances `retained_from` in one CTE, so any
reader that sees a deletion also sees the advanced floor. The advance uses `GREATEST`, so
it is safe on every instance.

### Reconciliation catches dropped log writes

`SyncLogReconciliationWorker` runs every 30s, 15s behind the DB clock, and anti-joins
`outbox` against `sync_log` over a frozen time window (clamped to the oldest running
transaction) to find outbox events that were never sequenced. It re-runs
`resolveDeliveryGroups` and `appendForWorkspace` for each straggler and emits it through
the same `emitToGroups` the dispatcher uses, so routing cannot drift. It carries no leader
election: the work is idempotent on `outbox_event_id`, so running on every instance is
safe.

### Paged drains and the gate

The client pages catch-up (500 per page, up to 20 pages) and buffers live socket events
behind a gate while draining, applying buffered events in `sync_id` order so a live event
never lands before the catch-up entry it follows. A drain that hits the page cap does not
record a clean head, so the next heartbeat re-triggers it until it drains fully.

## Boundaries

What the log deliberately does not carry today:

- **Private `stream:created` for members who join later.** A private stream's creation
  logs only to the creator's user group. A member added afterwards learns of the stream
  through their `stream:member_added` entry, not a replayed `stream:created`, so catch-up
  never shows them the creation event.
- **Bot-runtime events.** Bot invocation and presence events route straight to runtimes
  and are never logged; they are outside the client replay model.
- **No anomaly alerting.** The reconciliation worker logs a warning when it rescues a
  straggler, but no metric or alert is wired to it, so a recurring drop only surfaces in
  logs.

Workspace-wide events (settings, archive and unarchive, member add and remove, memo
created) reach clients through the `workspace` group by falling through the classification
branches rather than by an explicit rule. The routing is correct, but a new event type
added without a classification entry inherits workspace-wide delivery by default, which is
wider than some events want. Classify new event types explicitly.

## Invariants

- **INV-53.** The log is the durable backing for subscribe-then-bootstrap's reconnect
  path: a client confirms its subscription, replays the log from its cursor, and merges,
  so a dropped emit is recoverable rather than permanent loss.
- **INV-62.** The catch-up filter resolves stream access through the shared
  `rootReadableConditionSql` leaf, so replay admits exactly what stream access allows:
  public roots without a membership row, threads through their root, and private streams
  only from the join position.

## Entry points

- `apps/backend/src/db/migrations/20260611080000_sync_log.sql`: the `sync_log` table, the
  `workspace_sync_sequences` allocator, and the supporting indexes (later migrations add
  retention and sweep state).
- `apps/backend/src/lib/outbox/broadcast-handler.ts`: `sequenceEvents` writes log rows
  before the socket emit and stamps the `sync_id` onto the payload.
- `apps/backend/src/lib/outbox/delivery-groups.ts`: `resolveDeliveryGroups` and the event
  classification that maps each event to its groups.
- `apps/backend/src/features/sync/repository.ts`: `appendForWorkspace`,
  `listEntriesForUser`, `getHeadAndRetainedFrom`, and the prune and reconciliation queries.
- `apps/backend/src/features/sync/service.ts`: `catchUp`, the entries-then-floor read
  order and the `requiresBootstrap` decision.
- `apps/backend/src/features/sync/heartbeat-worker.ts`: the per-workspace head broadcast.
- `apps/backend/src/features/sync/reconciliation-worker.ts`: the straggler sweep.
- `apps/backend/src/features/sync/retention-worker.ts`: the time and count window prune.
