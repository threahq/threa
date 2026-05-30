---
title: Outbox Pattern
status: shipped
audience: internal
invariants: [INV-4, INV-6, INV-7]
entry_points:
  - packages/backend-common/src/outbox/repository.ts
  - packages/backend-common/src/outbox/cursor-lock.ts
  - packages/backend-common/src/outbox/dispatcher.ts
  - packages/backend-common/src/db/index.ts
  - apps/backend/src/lib/outbox/broadcast-handler.ts
public_site: false
summary: >
  Domain writes and their real-time events commit in one transaction; a dispatcher
  fans them out to Socket.io with gap-safe, at-least-once delivery.
related: [public/configurable-sidebar.md]
---

## The gist

When something happens that other people need to see live — a new message, a reaction —
we don't publish it to Socket.io right after saving. Instead, in the **same transaction**
that writes the domain row, we write a row to an `outbox` table describing what happened.
A separate process tails that table and does the broadcasting.

That's the whole idea. The reason it's worth the extra moving parts is the gap between
"I saved the message" and "I published it": if the server dies in that gap you lose the
event, and if you publish before the write commits you can broadcast a row that never
actually lands. Putting the event write inside the same transaction as the domain write
closes that gap — if the write commits, the event is there to deliver; if it rolls back,
no phantom event escapes. The price is that delivery is now asynchronous and has to
tolerate retries and out-of-order commits, which is what the dispatcher and cursor logic
below are for.

This is also why [INV-4](../../../CLAUDE.md) says real-time delivery never goes through an
ad-hoc publish call — everything routes through the outbox.

## How it works

**Write side.** A service calls `OutboxRepository.insert(client, eventType, payload)`
(or `insertMany`) using the same `Querier` as its domain write, inside a
`withTransaction()` block. The event row and the domain mutation commit together, and a
`NOTIFY` on the outbox channel fires at COMMIT. Real example:
`EventService.createMessageInTransaction()` writes both `message:created` and
`stream:activity` in the same transaction as the message row.

**Dispatch side.** `OutboxDispatcher` holds one LISTEN connection and registers handlers.
When the `NOTIFY` arrives (with a ~2s fallback poll for safety) it hands the new events to
each handler. The handlers are where the actual work happens:

- `BroadcastHandler` emits to Socket.io rooms scoped by stream, workspace, and user.
- `ActivityFeedHandler` builds activity records and can publish further outbox events
  downstream.

Each handler owns its own cursor, so a slow handler never blocks the others.

If you only need the mental model, you can stop here. The rest is reference for when you're
actually working on this.

## Details worth knowing

### Ordering and the gap problem

Events carry a `BIGSERIAL` id. The catch: the id is allocated at INSERT but only becomes
visible at COMMIT, so under concurrent transactions a higher id can commit before a lower
one. A naive "process everything past my cursor" would skip the late-committing event.

The fix lives in `CursorLock`: each listener tracks a base cursor (`last_processed_id`)
**plus** a sliding window of recently-processed ids (`processed_ids`). `compact()` only
advances the base cursor across a contiguous run and keeps recent ids in the window
(default ~1s) so `fetchAfterId(..., excludeIds)` won't re-deliver them. Delivery is
**at-least-once**, so handlers must be idempotent.

Failures retry with backoff; after `maxRetries` an event moves to `outbox_dead_letters`.
Re-queueing a dead-lettered event means INSERTing a _new_ outbox row with the same
`event_type` and payload — the cursor has already advanced past the original id, so
resurrecting the old row does nothing. The full root-cause writeup is in
[`docs/investigations/outbox-sequence-gap.md`](../../investigations/outbox-sequence-gap.md).

### Connection pools

Pool sizing (`createDatabasePools()`) deliberately keeps LISTEN and broadcast work off the
transactional path, so a saturated app pool can't stall delivery:

- **main** (default 30) — HTTP handlers, services, workers, queue.
- **listen** (default 12) — long-held LISTEN connections for the dispatcher.
- **realtime** (default 8) — reserved for broadcast / push / the Socket.io postgres
  adapter.

## Invariants

- **INV-4** — real-time delivery goes through the outbox, never ad-hoc publish.
- **INV-6** — services own the transaction; the outbox insert joins the service's
  `withTransaction()` block.
- **INV-7** — event-source updates and read projections commit together.

## Entry points

- `packages/backend-common/src/outbox/repository.ts` — event + listener CRUD, `insert`,
  `fetchAfterId`, status queries.
- `packages/backend-common/src/outbox/cursor-lock.ts` — cursor state, gap-window
  detection, retry/backoff, dead-lettering.
- `packages/backend-common/src/outbox/dispatcher.ts` — LISTEN + fallback poll + handler
  fan-out.
- `packages/backend-common/src/db/index.ts` — `withTransaction()` and pool sizing.
- `apps/backend/src/lib/outbox/broadcast-handler.ts` — the canonical handler (Socket.io
  delivery).
