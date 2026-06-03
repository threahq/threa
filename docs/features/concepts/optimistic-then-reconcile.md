---
title: Optimistic-Then-Reconcile
status: shipped
audience: internal
kind: concept
invariants: []
public_site: false
summary: >
  A send shows up instantly: the client writes an optimistic event to IndexedDB
  with a temp id, then the server's authoritative event replaces it by client id
  in one atomic swap. Failures stay put and retry; they never silently vanish.
related: [architecture/sync-engine.md]
---

## The principle

Optimistic-then-reconcile is how a write feels instant without lying about what the
server actually did. When the user sends a message, the client writes an optimistic
copy of the resulting event into IndexedDB right away, tagged with a client-minted
temp id and a `pending` status. The UI reads from IDB, so it renders that copy on the
next frame. The real send goes out in the background. When the server's authoritative
event arrives over the socket, it carries the same client id back, and the socket
handler swaps the optimistic row for the real one in a single transaction. The user
never waited; the durable record is still the server's.

Two ids do the work. A temp id the client mints (`temp_...`) is the local row's key. A
`clientMessageId` rides along on the send request and comes back on the server's event.
That round-trip id is what makes reconciliation exact instead of a guess.

It's a pattern, not a component. The canonical implementation is the message-send path,
and it leans on the same IDB-as-source-of-truth model the [Sync Engine](../architecture/sync-engine.md)
owns: the engine writes server state into IDB, the UI reads it back, and the
reconciliation handler is one of the stream socket handlers the engine registers.

## The problem it prevents

Two naive approaches both fail:

1. **Send, await, then render.** Every send feels as slow as the network. Offline, it
   feels broken.
2. **Render optimistically, but reconcile by content or timing.** This breaks the moment
   two identical messages are in flight, or the same event arrives twice (the socket echo
   plus a bootstrap snapshot can both deliver it). You get duplicates, or you delete the
   wrong row, or you get a flicker where the message briefly disappears in the gap between
   "remove optimistic" and "insert real."

An explicit, server-echoed client id closes all three holes: it identifies exactly which
optimistic row a given server event retires, it survives duplicate delivery, and it lets
the swap be ordered so no frame ever shows neither row.

## What an implementation must do

1. **Write optimistically with a client id and a status marker.** The read path renders
   it immediately and can tell optimistic state apart from confirmed state.
2. **Carry a stable client id on the request, and require the server to echo it** on the
   resulting event.
3. **Reconcile by that id, insert-before-delete, atomically.** Put the authoritative
   event in first, then remove the optimistic one, all in one transaction, so a live-query
   observer never sees a frame with neither.
4. **Dedupe the authoritative event against itself.** It can arrive twice (socket plus
   snapshot), so the handler no-ops if the real id is already present.
5. **On failure, keep the row and mark it failed.** Never drop it silently. Let the user
   see it and retry, and make retries idempotent (same client id) so a late success can't
   double-insert.

## How Threa implements it

**Send.** `useStreamOrDraft.sendMessage` (`apps/frontend/src/hooks/use-stream-or-draft.ts:539`)
mints the temp id with `generateClientId` (`:36`, format `temp_<base36 time><base36 random>`),
builds the optimistic `message_created` event using `Date.now()` as a placeholder sequence
so it sorts after real events (which carry small monotonic sequences), then writes a durable
row to `db.pendingMessages` and the optimistic event to `db.events` with `_clientId` and
`_status: "pending"` (`:617-637`). The `CachedEvent._status` field
(`apps/frontend/src/db/database.ts:137`) is the marker the rest of the pattern keys off.
Its type is `"pending" | "sent" | "failed" | "editing"`, but only `pending`, `failed`, and
`editing` are ever written to IDB; `"sent"` is declared and never written (the queue's
`markSent` updates React context state, not the row).

**Drain.** `useMessageQueue` (`apps/frontend/src/hooks/use-message-queue.ts:163`) sends
pending rows one at a time in `createdAt` order, passing `clientMessageId: next.clientId`
to the API (`:235`, `:244`). On success it deletes the `pendingMessages` row but
deliberately leaves the optimistic `db.events` row for the socket handler to swap
(`:249-255`). A Web Lock keeps two tabs from sending the same row.

**Reconcile.** `handleMessageCreated` in `apps/frontend/src/sync/stream-sync.ts:486` runs
one Dexie transaction that no-ops if the real event id is already present (`:504-505`),
inserts the real event first (`:509`), then deletes the optimistic event and its pending
row keyed by `payload.clientMessageId` (`:512-514`). A comment at `:507` cites the
insert-before-delete ordering directly. A content-based fallback (`:516-528`) covers
legacy events that predate `clientMessageId`.

**Render merge.** `loadStreamEvents` (`apps/frontend/src/stores/stream-store.ts:27`) reads
confirmed events by the `[streamId+_sequenceNum]` index and merges in any `pending` or
`failed` rows off the `_status` index, then re-sorts, so optimistic and failed sends land
in their natural slot by sequence rather than being appended at the end.

**Failure.** The queue never deletes a row on failure (`:155`). A failed send marks the
event `_status: "failed"` and gives the queue row an exponential backoff (`:286-294`). A
privacy-boundary rejection is handled on a separate track: the event still goes to
`_status: "failed"`, but the `pendingMessages` row's own `status` field (typed
`"editing" | "blocked-privacy"` at `database.ts:227`, distinct from the event's `_status`)
is set to `blocked-privacy` so the drain skips it, and a toast is surfaced instead of
auto-retrying (`:262-279`). Either way the row stays visible until the server confirms it
or the user deletes it.

## Boundaries

- **Only message sends get the full pattern.** Reactions, message edits, and deletes route
  through the offline operation queue (`enqueueOperation` in
  `apps/frontend/src/sync/operation-queue.ts:73`), which retries with backoff but writes no
  optimistic event. They appear in the UI only once the server's event arrives.
- **Slash-command dispatch is a near relative, not the same path.** It writes an optimistic
  event and, on a permanent dispatch error, marks it failed via a separate `command_failed`
  event (`operation-queue.ts:38-66`) rather than the `clientMessageId` swap.
- **Saved-message actions** (save / done / archive) use TanStack mutations with cache
  invalidation against `db.savedMessages`, not the IDB-durable optimistic queue
  (`apps/frontend/src/hooks/use-saved.ts`).
- **The content-based fallback is a compatibility shim**, not the primary path. It can
  mis-dedupe two identical messages sent in quick succession, and it does not match E2E
  messages (whose wire `contentMarkdown` is placeholder ciphertext). Current sends always
  carry a `clientMessageId`, so the fallback only fires for events that predate it.

## Invariants

This is a frontend pattern, not codified as an `INV-*`. It pairs with
[subscribe-then-bootstrap](subscribe-then-bootstrap.md) (INV-53): the bootstrap apply
merges rather than replaces precisely so a snapshot can't clobber an optimistic or
live-delivered event. The reconciliation handler and the IDB-as-source-of-truth model it
relies on live in the [Sync Engine](../architecture/sync-engine.md).
