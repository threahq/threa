---
title: Race-Safe Writes
status: shipped
audience: internal
kind: concept
invariants: [INV-20, INV-56]
public_site: false
summary: >
  A write path must produce the same correct result whether it runs alone or races a
  concurrent copy of itself: no read-decide-write without a lock across the gap, and
  set-based statements instead of per-row loops.
related: [architecture/outbox-pattern.md]
---

## The principle

Every write path has to be correct under concurrency, not just when it runs alone. Two
copies of the same request can interleave at any point, so the rule is: never read a row,
decide something in application code, then write back without holding a lock across that
gap (INV-20), and when you touch many rows, do it in one set-based statement rather than a
loop of single-row queries (INV-56).

It is a property of the path, not a snippet you sprinkle in. The same correctness can be
reached several ways, and the right one depends on the situation: an idempotent upsert, a
row lock, an advisory lock, or a conditional update that carries its precondition in the
`WHERE` clause. INV-20 is "this path tolerates concurrent callers," not "add `ON CONFLICT`
everywhere."

## The race it prevents

The naive shape is check-then-act, and it has a silent window:

1. Request A runs `SELECT` and sees the row is absent (or the count is 4, or the
   generation is N).
2. Request B runs the same `SELECT` and sees the same thing. Neither has written yet.
3. Both proceed on a now-stale fact: both `INSERT`, or both decide they are under the
   limit, or both write generation N+1.
4. You get a duplicate row, a limit blown past by one, or a lost update where one writer's
   change silently overwrites the other's.

The window between the read and the write is usually a few milliseconds, which is exactly
why it survives local development (where requests run one at a time) and only bites in
production under real concurrent traffic. A test that runs the two callers truly in
parallel is the only cheap way to catch it.

## What an implementation must do

1. **Collapse check-then-act into one atomic statement where you can.** For "create, or
   update if it already exists" and "create only if absent," reach for
   `INSERT ... ON CONFLICT (...) DO UPDATE` / `DO NOTHING`. The database picks exactly one
   winner per conflict key; retries become no-ops.
2. **When you genuinely must read, decide, then write, hold a lock across the whole
   sequence.** `SELECT ... FOR UPDATE` locks an existing row for the rest of the
   transaction. When the row may not exist yet, a `FOR UPDATE` has nothing to grab, so use
   a transaction-scoped advisory lock keyed by the logical resource instead.
3. **Put the precondition in the `WHERE` clause and check whether you won.** A conditional
   `UPDATE ... WHERE current = expected` lets the loser of a race come back empty;
   inspect `RETURNING` (or row count) to find out. Never read the current value, compute
   the next, and write it back blind.
4. **Allocate counters and sequences atomically.** Increment in the statement itself
   (`SET n = n + 1 ... RETURNING`), never `max+1` read into application code and written
   back.
5. **Touch many rows in one statement.** `unnest(...)`, multi-row `VALUES`, and
   `= ANY($1)` replace per-row loops, which are both slower (one round trip per row) and a
   place for partial-failure bugs to hide (INV-56).

## How Threa implements it

There is no single subsystem for this; it is a constraint every repository write honors.
Representative, verified call sites, one per technique:

- **Idempotent upsert.** `LabelMemberRepository.join`
  (`apps/backend/src/features/labels/repository.ts:251`) does
  `ON CONFLICT (label_id, user_id) DO UPDATE`, keeping the original `joined_at` so a
  repeat join does not churn the timestamp. Inviting an E2E actor uses
  `ON CONFLICT ... DO NOTHING` so a repeat invite is a no-op
  (`apps/backend/src/features/e2e-streams/actor-repository.ts`).
- **Atomic counter (the cleanest example).** Stream event sequence allocation upserts a
  per-stream counter in one statement:
  `INSERT INTO stream_sequences ... ON CONFLICT (stream_id) DO UPDATE SET next_sequence = stream_sequences.next_sequence + 1 RETURNING next_sequence - 1`
  (`apps/backend/src/features/streams/event-repository.ts:90`). No advisory lock is needed,
  because the conflict on `stream_id` plus the in-statement increment already serialize
  concurrent allocators. The batch form bumps by `${count}` and hands back a contiguous
  block (`:102`).
- **Row lock for a real read-decide-write.** Enforcing the per-bot API key limit locks the
  bot row and the existing keys with `FOR UPDATE` before counting and inserting, so two
  concurrent creates cannot both pass the check
  (`apps/backend/src/features/public-api/bot-api-key-service.ts:65`). Boundary extraction
  locks the message rows it is about to reassign with `WHERE id = ANY(...) FOR UPDATE`
  (`apps/backend/src/features/conversations/boundary-extraction-service.ts:327`) so two
  extractions cannot file the same message into different conversations.
- **Advisory lock when the row does not exist yet.** Setting a stream's active actor takes
  `pg_advisory_xact_lock(hashtextextended('stream_active_actors:<ws>:<root>', 0))` around
  the read→upsert pair (`apps/backend/src/features/bot-runtimes/service.ts:142`). The
  comment there spells out why a plain `FOR UPDATE` is not enough: with no row to lock,
  two inserts both see `existing = null` and the loser's `ON CONFLICT UPDATE` emits a
  displacement event with `previousActorId = null`, dropping the displaced bot. The
  advisory lock serializes the whole pair.
- **Conditional update with a precondition.** Rolling an E2E stream's key generation does
  `UPDATE ... SET current_key_generation = ${to} WHERE current_key_generation = ${to - 1}`
  (`apps/backend/src/features/e2e-streams/repository.ts:98`). Exactly one of two concurrent
  rolls wins; the loser gets `null` back and rolls its orphaned key wraps back in the same
  transaction. Never a blind `+ 1`.
- **Set-based writes (INV-56).** Activity rows insert in a single `unnest(...)` query
  rather than N inserts (`apps/backend/src/features/activity/repository.ts:160`); push
  sessions upsert in a batch (`apps/backend/src/features/push/session-repository.ts:73`);
  `StreamEventRepository.insertMany` inserts a whole batch through `unnest(...)` over
  pre-allocated sequences (`event-repository.ts:136`).

The [outbox dispatcher](../architecture/outbox-pattern.md) is the same principle at the
delivery layer: its cursor lock is how competing dispatchers claim work without double
publishing.

## Boundaries

- **A few per-row loops remain by design, and that is fine.** Where each row needs bespoke
  bookkeeping the loop stays, but the unsafe part is still made safe first. Conversation
  reassignment loops over candidates only after batch-locking every affected message row
  with one `FOR UPDATE` (`boundary-extraction-service.ts:335`); PDF page inserts loop with
  small, bounded N inside a transaction. These are acceptable under INV-56, which targets
  unbounded per-row round trips, not every loop.
- **Two bounded-N read loops are borderline, not violations.** Resolving `@mention` slugs
  to personas and checking private-stream membership for saved-messages both issue one
  read per item over a small bounded set. They are reads, not write races, so no
  correctness bug rides on them; batching them would be an efficiency cleanup, not an
  INV-20 fix.
- **No unlocked select-then-update write path was found.** A sweep for an `await find...`
  followed by an `await update...` outside a lock or transaction turned up none: every
  mutation goes through an upsert, a `FOR UPDATE` / advisory lock, or a guarded
  conditional update.

## Invariants

- **INV-20**: write paths tolerate concurrent callers; no select-then-update without
  locking or single-statement concurrency control.
- **INV-56**: prefer set-based / batch DB operations over per-row loops.
