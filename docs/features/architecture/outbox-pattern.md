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

## The contract

Real-time delivery never happens through an ad-hoc publish call. A service writes its
domain rows **and** the events describing them in the _same_ transaction; a separate
dispatcher reads those events and fans them out. This is what makes
[INV-4](../../../CLAUDE.md), [INV-6](../../../CLAUDE.md), and
[INV-7](../../../CLAUDE.md) hold: if the write commits, its events are guaranteed to be
there to deliver, and if the write rolls back, no phantom event escapes.

## Why it exists

Without an outbox, you publish to Socket.io after committing — and a crash between commit
and publish loses the event, while a publish before commit can broadcast a row that never
lands. Coupling the event write to the domain write inside one transaction removes that
window entirely. The cost is that delivery becomes asynchronous and must tolerate
retries and out-of-order commits, which the dispatcher and cursor logic handle.

## How it works

### Write side

`OutboxRepository.insert(client, eventType, payload)` (and `insertMany`) writes a row to
the `outbox` table using the same `Querier` (`PoolClient`) as the surrounding domain
write — see `packages/backend-common/src/outbox/repository.ts`. Because it runs inside
`withTransaction()` (`packages/backend-common/src/db/index.ts`), the row and the domain
mutation commit together, and the `NOTIFY` on the outbox channel is deferred to COMMIT.

Example: `EventService.createMessageInTransaction()`
(`apps/backend/src/features/messaging/event-service.ts`) writes both `message:created`
and `stream:activity` events in the same transaction as the message row.

### Dispatch side

`OutboxDispatcher` (`packages/backend-common/src/outbox/dispatcher.ts`) holds a single
LISTEN connection (from a dedicated listen pool) and registers handlers. On `NOTIFY` —
with a fallback poll (~2s) for safety — it invokes each registered handler. Handlers read
new events via `OutboxRepository.fetchAfterId(...)` and act on them:

- `BroadcastHandler` (`apps/backend/src/lib/outbox/broadcast-handler.ts`) emits to
  Socket.io rooms scoped by stream, workspace, and user.
- `ActivityFeedHandler` (`apps/backend/src/features/activity/outbox-handler.ts`) builds
  activity records and may publish further outbox events downstream.

Each handler owns its own cursor, so handlers progress independently.

### Ordering and delivery guarantees

Events carry a `BIGSERIAL` id, allocated at INSERT but only visible at COMMIT. Under
concurrent transactions this creates gaps: a higher id can commit before a lower one, and
a naive cursor would skip the late-committing event. The fix lives in
`CursorLock` (`packages/backend-common/src/outbox/cursor-lock.ts`): each listener tracks a
base cursor (`last_processed_id`) **plus** a sliding window of recently-processed ids
(`processed_ids`). `compact()` only advances the base cursor across a contiguous run and
keeps recent ids in the window (default ~1s) so `fetchAfterId(..., excludeIds)` won't
re-deliver them. Delivery is **at-least-once**; handlers should be idempotent.

Failures retry with backoff; after `maxRetries` an event is moved to
`outbox_dead_letters`. Re-queueing a dead-lettered event means INSERTing a _new_ outbox
row with the same `event_type` and payload — the listener cursor has already advanced past
the original id. The full gap analysis is in
[`docs/investigations/outbox-sequence-gap.md`](../../investigations/outbox-sequence-gap.md).

### Connection pools

Pool sizing (`createDatabasePools()` in `packages/backend-common/src/db/index.ts`) keeps
LISTEN and broadcast work off the transactional path:

- **main** (default 30) — HTTP handlers, services, workers, queue.
- **listen** (default 12) — long-held LISTEN connections for the dispatcher, so they
  don't compete with transactional work for pool slots.
- **realtime** (default 8) — reserved for broadcast / push / the Socket.io postgres
  adapter, so a saturated main pool can never delay delivery.

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
