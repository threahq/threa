---
title: Subscribe-Then-Bootstrap
status: shipped
audience: internal
kind: concept
invariants: [INV-53]
public_site: false
summary: >
  Confirm your real-time subscription before you fetch the snapshot, then reconcile the
  overlap — so no event is lost in the gap between snapshot and subscription.
related: [architecture/sync-engine.md]
---

## The principle

Any live view of server data needs two things: a **snapshot** (a fetch of the state so
far) and a **subscription** (a live feed of changes after that). Subscribe-then-bootstrap
is the rule for wiring them together without losing data: **establish the subscription —
and wait for the server to confirm it — _before_ you fetch the snapshot, then merge the
two.**

It's a concept, not a component. Threa applies it to streams, to the workspace, and on
every reconnect; the code tags each of those call sites `subscribe-then-fetch, INV-53`.
Any new surface that pairs a live feed with an initial fetch should follow it too.

## The race it prevents

The intuitive order — fetch first, then subscribe — has a silent data-loss bug:

1. You ask the server for a snapshot. It computes the state as of now.
2. An event happens. It isn't in your snapshot (it didn't exist when the snapshot was
   computed)...
3. ...and it isn't on your socket either, because you haven't subscribed yet.
4. You subscribe. Too late — that event is gone until a full reload.

Subscribing and fetching _concurrently_ has the same hole, just harder to spot. The window
is tiny, which is exactly why it's so easy to ship and so painful to debug: it only bites
under real network timing, rarely in local dev.

## What an implementation must do

1. **Subscribe first, and confirm it.** Join the room and wait for the server's
   acknowledgement — not just "we sent the join," but "the server says we're subscribed."
2. **Capture live events from that moment.** Once subscribed, every incoming event is
   persisted (in Threa, written to IndexedDB by the socket handlers).
3. **Fetch the snapshot only after the subscription is confirmed.**
4. **Merge, never replace.** The snapshot and the live feed will overlap — an event can
   arrive both ways. Deduplicate by id and keep whichever is fresher; never delete a
   live-delivered event just because the snapshot didn't include it.

The two failure modes to reject in review:

```ts
// CORRECT — confirm the subscription, then fetch.
await joinRoomWithAck(socket, room)
const snapshot = await fetchBootstrap(...)

// WRONG — fetch first: events in the gap are lost.
const snapshot = await fetchBootstrap(...)
await joinRoomWithAck(socket, room)

// WRONG — concurrent: same gap.
await Promise.all([joinRoomWithAck(socket, room), fetchBootstrap(...)])
```

## How Threa implements it

The [Sync Engine](../architecture/sync-engine.md) is the primary implementation: it applies
subscribe-then-bootstrap to the workspace room and to each member stream, and re-applies it
on every reconnect (with a delta fetch). The per-stream bootstrap hook
(`useStreamBootstrap`) does the same inline for a freshly-opened stream. The snapshot/live
reconciliation — dedup, freshness merge, window pruning — lives in that doc, because it's
implementation detail, not part of the principle.

## Invariants

- **INV-53** — every socket-room subscribe is confirmed (acked) before its bootstrap fetch,
  and the snapshot is merged rather than replacing live events, so no event is lost in the
  subscribe→fetch window.
