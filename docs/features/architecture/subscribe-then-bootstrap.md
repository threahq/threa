---
title: Subscribe-Then-Bootstrap Pattern
status: shipped
audience: internal
invariants: [INV-53]
entry_points:
  - apps/frontend/src/hooks/use-streams.ts
  - apps/frontend/src/hooks/use-stream-socket.ts
  - apps/frontend/src/lib/socket-room.ts
  - apps/frontend/src/sync/stream-sync.ts
public_site: false
summary: >
  Join the stream's socket room and wait for the server's ack before fetching the
  bootstrap snapshot, so no event can slip through the gap between snapshot and
  subscription.
related: [architecture/outbox-pattern.md, public/configurable-sidebar.md]
---

## The gist

To show a live stream you need two things: a **snapshot** (the bootstrap fetch — all the
events so far) and a **subscription** (the socket room, which pushes new events as they
happen). The whole pattern is about the _order_ you set those up in, because the obvious
order has a data-loss bug.

The bug: fetch the snapshot first, then subscribe. Between "the server computed my
snapshot" and "my subscription is live," an event can land — and it's in neither place.
Not in the snapshot (it didn't exist yet) and not on the socket (you weren't listening
yet). It's gone until a full page reload. Subscribing and fetching _concurrently_ has the
same hole. This is genuinely easy to reintroduce, and it has been, repeatedly — if you
find yourself reaching for `Promise.all([join, fetch])`, stop.

The fix is in the name: **subscribe, _then_ bootstrap.** Join the room first and wait for
the server to **ack** the join. Only once the subscription is confirmed live do you fetch
the snapshot. Now the ordering guarantees there's no gap: every event from the ack onward
is delivered to you over the socket, and the snapshot taken _after_ the ack can only
overlap that live stream, never fall behind it into a hole. Anything that arrives in the
window shows up live (and maybe in the snapshot too) — so the remaining job is to
**merge** the two without double-counting, never to recover a lost event.

## How it works

**Subscribe first, confirmed by ack.** `useStreamBootstrap` (use-streams.ts) doesn't fetch
right away. Its `queryFn` first `await`s `joinRoomBestEffort(...)`, which calls
`joinRoomWithAck` (socket-room.ts): that waits for the socket to be connected, emits
`"join"`, and resolves **only when the server replies `{ ok: true }`**. The bootstrap
fetch (`streamService.bootstrap(...)`) runs on the next line — strictly after the ack.

**Live events land in IDB during the window.** `useStreamSocket` registers the stream's
socket handlers (stream-sync.ts `registerStreamSocketHandlers`), which write every
incoming event straight to IndexedDB. Once the room is joined, any event in the
subscribe→fetch window is already being persisted.

**The snapshot merges in, it never replaces.** When the bootstrap response arrives,
`applyStreamBootstrap` (stream-sync.ts) writes it into IDB as a **merge**: it `bulkPut`s
the snapshot events and deliberately does **not** delete events that the socket already
wrote during the window. Dedup is by event id, so an event that came both live and in the
snapshot collapses to one row. The UI reads from IDB via live queries, so it just sees the
union.

That's the pattern. If you only need the mental model, stop here — the rest is the
reconciliation detail that makes the merge correct under nastier races.

## Details worth knowing

**It does NOT rely on refetch heuristics.** Correctness comes from the ordering + merge
above, not from cache freshness. `STREAM_BOOTSTRAP_QUERY_OPTIONS` (stream-bootstrap-query.ts)
is `staleTime: Infinity`, `refetchOnMount: false`, `refetchOnReconnect: false`. If you ever
see this pattern "fixed" by flipping `refetchOnMount` on, that's a misunderstanding — the
window safety is in the join-ack ordering, not the query options.

**The prune ceiling is the max event sequence, not `latestSequence`.** On a `replace`
bootstrap, `pruneBootstrapReplaceWindow` clears stale events inside the snapshot's window
before writing. It bounds that window by the highest sequence _among the returned events_,
**not** by `latestSequence` — because `latestSequence` can be higher than the last event
the snapshot actually carried (new events committed between the server's event query and
its sequence query). Pruning up to `latestSequence` would delete exactly the socket events
that arrived in the gap. This is the same INV-53 race, guarded a second time on the write
path (stream-sync.ts).

**`message_created` merges in two tiers.** A snapshot row can be _staler_ than what a
socket handler already patched into IDB (e.g. a `reaction:added` landed before the
snapshot, whose enrichment query ran before that reaction committed). So for
`message_created`: (1) if the existing IDB row was patched after the snapshot was taken
(`_patchedAt > snapshotAt`), keep the existing row untouched; (2) otherwise merge
per-field so neither side drops a populated field. Other event types are immutable after
creation, so a plain overwrite is equivalent.

**Don't leave the room on unmount.** Socket.io rooms aren't reference-counted — a single
`leave` undoes _all_ joins for that room, and the sync engine also joins it for
sidebar/activity delivery. `useStreamSocket` cleans up its handlers on unmount but
deliberately does not leave the room (use-stream-socket.ts).

**The bootstrap join is best-effort.** `joinRoomBestEffort` swallows a failed/timed-out ack
and lets the fetch proceed anyway, so a transient join failure degrades to "snapshot
without live updates until the next (re)subscribe," not "no data at all."

## Correct / incorrect usage

```tsx
// CORRECT — the two hooks together. Bootstrap subscribes-then-fetches internally;
// the socket hook keeps the subscription live and owns the event handlers.
const { data, loadState } = useStreamBootstrap(workspaceId, streamId)
useStreamSocket(workspaceId, streamId)
```

```ts
// CORRECT — if you ever hand-roll it: join (await the ack) BEFORE fetching.
await joinRoomWithAck(socket, room)
const snapshot = await streamService.bootstrap(workspaceId, streamId)
```

```ts
// WRONG — fetch first, subscribe after: events in the gap are lost.
const snapshot = await streamService.bootstrap(workspaceId, streamId)
await joinRoomWithAck(socket, room)

// WRONG — concurrent: same gap, just harder to reason about.
await Promise.all([joinRoomWithAck(socket, room), streamService.bootstrap(...)])

// WRONG — replacing IDB from the snapshot (deleting non-snapshot events in the
// window) throws away events the socket already delivered. Merge, don't replace.
```

## Invariants

- **INV-53** — every socket-room subscribe is established (and acked) before its bootstrap
  fetch, and the snapshot is merged rather than replacing live events, so no event is lost
  in the subscribe→fetch window.

## Entry points

- `apps/frontend/src/hooks/use-streams.ts` — `useStreamBootstrap`: joins + awaits ack,
  then fetches the snapshot.
- `apps/frontend/src/lib/socket-room.ts` — `joinRoomWithAck` / `joinRoomBestEffort`: the
  ack-confirmed join and its best-effort wrapper.
- `apps/frontend/src/hooks/use-stream-socket.ts` — keeps the subscription live and
  registers the event handlers; does not leave the room on unmount.
- `apps/frontend/src/sync/stream-sync.ts` — `applyStreamBootstrap` (merge-not-replace) and
  the window-prune / per-field-merge reconciliation.
