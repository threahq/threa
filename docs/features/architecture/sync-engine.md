---
title: Sync Engine
status: shipped
audience: internal
kind: subsystem
invariants: [INV-53, INV-61]
entry_points:
  - apps/frontend/src/sync/sync-engine.ts
  - apps/frontend/src/sync/stream-sync.ts
  - apps/frontend/src/sync/workspace-sync.ts
  - apps/frontend/src/sync/contiguity.ts
  - apps/frontend/src/lib/socket-room.ts
public_site: false
summary: >
  One per-workspace class that owns the whole client sync lifecycle: bootstrap the
  workspace and its streams (subscribe-then-bootstrap), keep them live over the socket,
  re-sync everything on reconnect or page resume, and verify the rendered timeline is
  contiguous — detected gaps render as in-place placeholders and backfill themselves.
related:
  [
    concepts/subscribe-then-bootstrap.md,
    concepts/optimistic-then-reconcile.md,
    architecture/outbox-pattern.md,
    architecture/coordinated-loading.md,
  ]
---

## The gist

`SyncEngine` is a single plain class, constructed once per workspace and handed around via
React context (`useSyncEngine`). It owns everything about keeping the client's local data
in sync with the server: the initial bootstrap, the per-stream subscriptions, the socket
event handlers, reconnection, and the offline operation queue. It has no React in it, so
it's testable directly.

Data flows one way. The engine writes server state into **IndexedDB**, and the UI reads
from IDB via live queries. The engine's job is to keep IDB correct and current, including
across the messy parts: reconnects, backgrounded tabs, partial failures.

Its bootstrap obeys [subscribe-then-bootstrap](../concepts/subscribe-then-bootstrap.md):
join and confirm the room before fetching the snapshot. This is the subsystem where that
concept actually lives.

## How it works

**One lifecycle, driven by the socket.** `onConnect` runs the bootstrap cycle: register
workspace socket handlers, bootstrap the workspace, then subscribe every member stream.
`onDisconnect` marks everything stale. The engine distinguishes the first connect from a
reconnect (`hasEverConnected`) and behaves differently for each.

**Bootstrap is subscribe-then-fetch, at two levels.** It joins the workspace room
(`ws:${workspaceId}`) and awaits the ack before fetching the workspace bootstrap, then does
the same per stream: `ensureStreamSubscription` registers the stream's handlers and joins
its room. The handlers (`registerStreamSocketHandlers`, `registerWorkspaceSocketHandlers`)
write incoming events straight to IDB.

**Navigation triggers a targeted refresh.** When the route changes, `setCurrentStreamId`
kicks `refreshStreamAfterNavigation` → `performStreamRefresh`: derive the catch-up cursor
and confirm the subscription (via `joinStreamForCatchUp`, see below), then fetch a
**delta** bootstrap (`after` = the latest persisted sequence) and merge it. So opening a
stream you've seen before fetches only what you missed, not its whole history.

If you only need the mental model, stop here. The rest is the behavior that makes it
correct under reconnects and races.

## Details worth knowing

### Reconnect re-bootstraps everything, as a delta

On reconnect, the engine marks all state stale, tears down and re-registers handlers, and
re-bootstraps. For the streams the user can currently see, it runs `joinStreamForCatchUp`
per stream, then fetches the workspace bootstrap and per-stream **delta** bootstraps in
parallel: `after` = latest persisted sequence, which the backend serves as
`syncMode: "append"` (or falls back to `replace` when the gap is too large to append). It
applies them in one batch (`applyReconnectBootstrapBatch`). Per-stream failures are
classified: 403/404 are terminal (the stream is gone or forbidden), everything else is
transient and left "stale" to retry. This is subscribe-then-bootstrap again: the reconnect
path is exactly where the old naive "just refetch" loses the events that arrived
mid-reconnect.

### The catch-up cursor has exactly one owner

`SyncEngine.joinStreamForCatchUp` is the only place that derives a stream's catch-up
cursor, and it hard-codes the load-bearing order: **read the cursor, then join the room.**
Once subscribed, live events land in IDB immediately, and a message landing before the
cursor read would advance the cursor past the disconnect gap — the `after` fetch then
permanently skips everything missed while offline ("an older message never appears while
newer ones do"). Overlap is safe (writes dedupe by event id); gaps are not. Both the
reconnect path and the navigation refresh go through it; call sites never read
`getLatestPersistedSequence` and order it against a join themselves. The one intentional
exception is `backfillStreamGap`, which takes an explicit **pre-gap** cursor — the current
latest would skip the very hole it exists to fill.

### Timeline contiguity is verified, not assumed (INV-61)

The global per-stream `sequence` is consumed by every event type, including author-scoped
command events other viewers never receive and patch-style rows (edits, reactions,
deletes) that arrive as payload patches rather than rows — so a viewer's persisted
sequence set has legitimate holes and "seq N requires N−1" is unsound. The backend
therefore allocates a second, **dense** `broadcastSequence` for exactly the row-delivered
broadcast types (`TIMELINE_BROADCAST_EVENT_TYPES`): for any viewer, a missing broadcast
number is always a real gap.

The client checks that chain in two places:

- **Write path** (`detectSequenceGap` in `stream-sync.ts`): when a live event's broadcast
  position skips past the persisted tail (`getPersistedTail`), the handler reports the
  pre-write latest as a gap cursor and the engine's `backfillStreamGap` fetches
  `bootstrap?after=` from it — single-flighted per stream, with a queued lowest-cursor
  follow-up. Exact when both sides are stamped; pre-deploy rows fall back to the global
  heuristic (which can over-report; the backfill is idempotent and self-quiets).
- **Read path** (`computeTimelineHoles` in `sync/contiguity.ts`, driven by `useEvents`):
  the single authority over the rendered window. A hole between two visible rows renders
  as a fixed-height in-place "loading missed messages" placeholder and triggers a scoped
  backfill, so the missed message resolves the placeholder where it belongs instead of
  popping in above rows already on screen.

The one operation that legitimately vacates broadcast slots is the message-move flow: it
re-allocates moved rows densely in the destination and declares the vacated source slots
on its source tombstone (`vacatedBroadcastSequences`). The tombstone's own slot is always
above everything it declares, so any window that can see the hole also contains the
declaration — moves never produce phantom placeholders.

### In-flight dedup and queued reconnects

`runBootstrap` guards against overlapping cycles. If a bootstrap is already running and a
reconnect arrives, it can't retroactively upgrade the in-flight request (which already chose
its stream set), so it **chains** a follow-up reconnect bootstrap to run after the current
one. Repeated reconnects collapse onto that single queued promise.

### Page resume and zombie sockets

`handlePageResume` (e.g. phone unlocked after an app switch) pings the socket. If the ping
fails, it forces a disconnect/reconnect to short-circuit Socket.IO's own 20-25s zombie
detection; if the ping succeeds, it refreshes state in case events were missed while
backgrounded.

### Snapshot/live reconciliation (merge, never replace)

This is the part that makes subscribe-then-bootstrap's "merge" requirement concrete, in
`stream-sync.ts`:

- `applyStreamBootstrap` writes the snapshot into IDB as a **merge** and never deletes
  events that the socket delivered during the window. Its comment cites the
  subscribe-then-fetch race (INV-53) directly.
- When it does prune a `replace` window, the ceiling is the **max event sequence among the
  returned events**, not `latestSequence`. `latestSequence` can outrun the last returned
  event (new events committed between the server's event query and its sequence query), and
  pruning to it would delete exactly the gap events.
- `message_created` rows merge in two tiers: if the IDB row was patched by a socket handler
  _after_ the snapshot was taken (`_patchedAt > snapshotAt`), the existing row is kept;
  otherwise the two are merged per-field so neither side drops a populated field. Other
  event types are immutable post-creation, so a plain overwrite is equivalent.

### Don't leave the room on unmount

Socket.IO rooms aren't reference-counted: a single `leave` undoes _all_ joins for a room,
and the engine joins stream rooms for sidebar/activity delivery as well as for the open
view. So stream view teardown cleans up handlers but does **not** leave the room.

### Also owned here

The engine kicks the **offline operation queue** (queued edits/deletes/reactions) on
connect, and tracks **sync status** per workspace and per stream (`syncing` / `synced` /
`stale` / `error`) via `SyncStatusStore`, which is what drives the sidebar's loading and
retry affordances.

## Invariants

- **INV-53.** The engine is the primary implementation of
  [subscribe-then-bootstrap](../concepts/subscribe-then-bootstrap.md): subscriptions are
  confirmed before fetches, and snapshots merge rather than replace live events, on first
  load and on every reconnect.
- **INV-61.** The rendered timeline window is verifiably contiguous over the
  viewer-visible ordering. The dense `broadcastSequence` chain makes a missing event
  detectable for any viewer; holes render as in-place placeholders and backfill via
  `backfillStreamGap`; the catch-up cursor is owned solely by `joinStreamForCatchUp`.

## Entry points

- `apps/frontend/src/sync/sync-engine.ts`: the `SyncEngine` class. Lifecycle, bootstrap
  cycle, reconnect, navigation refresh, page resume, gap backfill, the catch-up cursor
  owner.
- `apps/frontend/src/sync/stream-sync.ts`: `applyStreamBootstrap` and the merge / window
  prune / two-tier reconciliation; the per-stream socket handlers; write-path gap
  detection (`getPersistedTail`, `detectSequenceGap`).
- `apps/frontend/src/sync/contiguity.ts`: `computeTimelineHoles`, the read-side authority
  for INV-61 (consumed by `useEvents` / the timeline's gap placeholders).
- `apps/frontend/src/sync/workspace-sync.ts`: workspace bootstrap apply, workspace socket
  handlers, the batched reconnect apply.
- `apps/frontend/src/lib/socket-room.ts`: `joinRoomWithAck` / `joinRoomBestEffort`, the
  ack-confirmed join the whole pattern rests on.
