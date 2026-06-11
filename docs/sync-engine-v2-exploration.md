# Exploration: A Single-Cursor Sync Protocol (Sync Engine v2)

Status: exploration, no code changes. This doc assesses the structural issues in the
current frontend↔backend sync architecture, surveys the 2026 sync-engine landscape, and
recommends a direction.

## TL;DR

The recurring sync bugs are not independent. They are all consequences of one missing
property: **the client has no single authoritative position in a single ordered log of
changes**. Stream events have per-stream sequences (recoverable, but only reactively);
everything workspace-scoped is unsequenced fire-and-forget cache patching (unrecoverable
except by full refetch). Subscribe-then-bootstrap, `_patchedAt` watermarks,
`windowVersion`, `updateBootstrapOrInvalidate`, single-flighted gap backfill — each is a
correct local fix to that one global problem.

The fix that matches our constraints (E2EE ciphertext rows, per-stream ACLs, Postgres as
source of truth, workspace sharding, offline writes, Bun) is the **Linear sync engine
pattern**: one per-workspace ordered sync log, every client-visible change is an entry
tagged with delivery groups, the client holds exactly one cursor, and `subscribe(cursor)`
replays the gap server-side before tailing live. We already have ~70% of the machinery
(transactional outbox, per-stream sequences, delta bootstraps, IDB persistence, optimistic
layer). No off-the-shelf engine fits better than evolving what we have; PowerSync is the
only credible buy option and it costs more than the build. Effect is orthogonal — it is an
implementation-quality library, not a sync protocol, and is not the lever here.

## Part 1: Diagnosis — what is actually wrong

### The two-tier data model

The realtime system today has two classes of data with very different guarantees:

|                | Stream events                                                       | Workspace-scoped state                                                          |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Examples       | messages, reactions, agent sessions, commands                       | streams, users, labels, saved items, read state, preferences, sidebar config    |
| Wire shape     | events with per-stream BIGINT `sequence`                            | 25+ distinct socket event types, each a bespoke patch                           |
| Persistence    | IDB `events` store, merge-by-id                                     | TanStack Query cache patches (`setQueryData`), 43 call sites                    |
| Loss detection | gap detection on next event (`detectSequenceGap`, `stream-sync.ts`) | **none**                                                                        |
| Recovery       | single-flighted backfill via delta bootstrap                        | full bootstrap refetch (reconnect, navigation) or `updateBootstrapOrInvalidate` |

A dropped `message:created` is eventually healed. A dropped `label:assigned`,
`stream:read`, `workspace_user:updated`, or `saved:upserted` is silently wrong until the
next full workspace bootstrap. On a flaky connection where the socket stays "connected"
(no disconnect event fires, so no re-bootstrap is triggered), the workspace tier just
drifts. This is the precise mechanism behind "works great most of the time but breaks
down on shoddy internet".

### Loss detection is reactive, not guaranteed

Even in the sequenced tier, a gap is only discovered when a _later_ event arrives in the
_same stream_. A missed event in a quiet stream stays missing until navigation or
reconnect. There is no heartbeat carrying "latest sequence per subscribed stream", so
silence and loss are indistinguishable to the client. The page-resume ping and the
zombie-socket force-disconnect in `sync-engine.ts` are workarounds for exactly this
ambiguity.

### Server-side delivery is at-most-once, by design

The broadcast path is outbox → `BroadcastHandler` → `io.to(room).emit()`. There is no
per-client cursor and no replay. Two production investigations document the consequences:

- [`investigations/broadcast-handler-event-loss.md`](investigations/broadcast-handler-event-loss.md):
  a transient member-lookup failure used to block all delivery via cursor backoff; the fix
  was to _drop_ the failed event instead ("availability > guaranteed delivery"). Delivery
  is now explicitly lossy on error.
- [`investigations/outbox-sequence-gap.md`](investigations/outbox-sequence-gap.md):
  BIGSERIAL allocation order ≠ commit order, so under concurrency a handler's cursor
  could permanently skip a still-invisible row. **Since mitigated**: `CursorLock` now
  keeps a sliding window of processed ids (`packages/backend-common/src/outbox/cursor-lock.ts`,
  migration `20260216132158_outbox_processed_ids.sql`) so the base cursor only advances
  past an unseen id after a gap window (default 1s) expires. A transaction that holds its
  outbox INSERT open longer than the window can still be skipped — the mitigation is
  probabilistic, not structural — but in practice domain transactions commit in
  milliseconds.

Both are symptoms of cursoring an allocation-ordered log with no acknowledgment. The
sliding window fixed the reader side well enough; client delivery remains at-most-once —
emit and forget — so clients still can never trust the feed.

### The workarounds are load-bearing and growing

Each of these is correct in isolation, and each exists because the client must reconcile
two unordered information sources (snapshot fetches and live events) instead of reading
one ordered one:

- **Subscribe-then-bootstrap (INV-53)** — the two-phase join-ack-then-fetch dance, applied
  at workspace level, per stream, on every reconnect, and inline in `useStreamBootstrap`.
- **Merge-never-replace + `_patchedAt` watermark** (`stream-sync.ts`) — per-field merging
  so neither snapshot nor live event clobbers the other, with a timestamp watermark to
  decide who wins.
- **`windowVersion`** — cache-busting for replace-mode bootstraps so the timeline can't
  show rows from a superseded window.
- **Prune ceiling = max returned sequence, not `latestSequence`** — because the server's
  two queries (events, then latest sequence) can themselves race.
- **Pre-join cursor reads** (PR #820) — read the catch-up cursor _before_ re-joining the
  room, or a live event poisons the cursor past the disconnect gap.
- **`updateBootstrapOrInvalidate`** (`workspace-sync.ts`) — "patch the cache if it exists,
  refetch if the event raced the bootstrap".
- **Single-flighted backfill with queued cursors** (`sync-engine.ts`) — gap backfills can
  race each other, so they are serialized with a lowest-cursor queue.

The count of independent "apply event to cache" implementations is the other half of the
cost: 47 socket event types, 41 handler registrations across 9 files, 43
`setQueryData`/`invalidateQueries` call sites. Every new realtime feature adds another
bespoke handler and another chance to get merging subtly wrong.

### Coordinated loading is downstream of the same problem

Cold start needs the coordinated-loading gate because first paint depends on N
independently-fetched, differently-shaped responses (workspace read model, per-stream
bootstraps, drafts, avatars) that arrive in arbitrary order. If the client instead loaded
"snapshot at cursor X, then the log from X", there would be one well-defined point at
which the world is consistent. The gate (and the reveal-before-write coordination in
`reveal-gate.ts`) wouldn't fully disappear — avatar preloading and skeleton timing are
genuinely presentational — but the hard part, "when is the data consistent enough to
paint", becomes a cursor comparison instead of a multi-condition latch.

### The newest data point: PR #824 (INV-61, dense broadcast sequence)

[PR #824](https://github.com/threahq/threa/pull/824) makes one stream's timeline provably
gap-free, and the machinery it needed is the strongest evidence yet for this diagnosis.
Because the global per-stream sequence has legitimate per-viewer holes (author-scoped
command events other viewers never receive; edit/reaction rows delivered live as patches,
not rows), it had to add a second counter (`broadcast_sequence`) dense over exactly the
row-delivered event types, allocate both atomically, declare vacated slots on move
tombstones, gate rendering behind a contiguity scan with in-place placeholders, and
consolidate the catch-up cursor into a single owner. All of it is correct — and all of it
is the price of making _one surface_ trustworthy on top of an untrusted feed.

Two lessons carry into v2:

- **Per-viewer density is the requirement for client-verified ordering.** A client can
  only prove contiguity over a sequence that has no legitimate holes _for that viewer_.
  A group-filtered workspace log is not per-viewer dense, so v2 clients must not try to
  verify density at all — loss detection moves server-side, to ordered per-connection
  delivery plus the visible-head comparison. That is exactly what `subscribe(cursor)`
  provides.
- **#824 composes with v2; it doesn't conflict.** It fixes today's UX with today's
  architecture, and its single-cursor-owner refactor (`joinStreamForCatchUp`) is the
  shape v2 builds on. Once the log exists and delivery is replayable, the render-side
  contiguity gate downgrades from the only line of defense to optional
  defense-in-depth.

## Part 2: The convergent design — one log, one cursor

Every serious system in this space (Linear's sync engine, Replicache/Zero's pull
protocol, PowerSync's checkpoints, Electric's shape logs) converges on the same shape:

1. **Every client-visible change is an entry in an ordered log.** Not just messages —
   stream metadata, membership, read state, labels, saved items, preferences. "Pure
   events" and "snapshot patches" stop being different kinds of things; a workspace-user
   update is a log entry whose payload is the updated row.
2. **Entries are tagged with delivery groups** (`workspace`, `stream:<id>`, `user:<id>`).
   The server filters the log per client by group membership. This is our per-stream ACL
   model, expressed once at the log instead of in 18 routing branches in
   `broadcast-handler.ts`.
3. **The client holds exactly one cursor per workspace** (`lastSyncId`), persisted in IDB.
4. **`subscribe(cursor)` is the entire client protocol.** The server registers the
   subscription, replays the log from the cursor (filtered by groups), then tails live —
   all on one ordered channel. Catch-up and live delivery cannot race because they are the
   same stream. Subscribe-then-bootstrap dissolves: there is no separate snapshot fetch to
   reconcile against.
5. **Bootstrap = snapshot + log position.** If the cursor is too old (log compacted) or
   absent (cold start), the server sends a snapshot stamped with the log position it was
   taken at, and the log resumes from there. This is the existing `syncMode:
"replace"`/`"append"` distinction, made universal.
6. **Liveness is verifiable.** A periodic heartbeat carries the server's latest sync id;
   the client compares against its cursor. Silence and loss become distinguishable, which
   no amount of client-side cleverness can achieve today.

Properties that fall out:

- **Quiet-stream loss is detected** (heartbeat) and **healed by the server** (replay),
  instead of detected by accident and healed by a client-orchestrated backfill.
- **Workspace state gets the same guarantee as messages.** The 25 unsequenced patch
  events become log entries; the 43 cache-patch sites collapse toward one reducer per
  entity type applying log entries to IDB.
- **Ordering is global per workspace**, so cross-entity invariants ("the membership event
  arrives before the message in the stream you were just added to") hold by construction.
- **E2EE is untouched.** The log carries sealed payloads exactly as the outbox does
  today; ordering and delivery metadata are plaintext, content is not.
- **Postgres stays the source of truth**; the log is a table written in the same
  transaction as the domain write (it can literally be an evolution of the outbox table).
  Workspace sharding aligns: the cursor is per-workspace, as is the log.
- **Offline writes keep the existing queue.** This pattern is about the read path; the
  optimistic layer and offline operation queue stay as they are.

### Who owns the subscription? Nobody — it's derived

Today the client owns room membership: it explicitly joins rooms with acks, and the
whole client half of INV-53 exists to order those joins against fetches. The natural
companion to the log is **subscriptions derived server-side from membership**: on socket
authentication the backend joins the connection to its workspace room, its user room,
and every member stream's room (one membership query); membership-change events adjust
rooms server-side from then on. The client asks for nothing except `subscribe(cursor)`.

This is less radical than it sounds. The engine already joins every member stream's room
on connect so the sidebar gets activity — clients already receive everything they're
entitled to. They just orchestrate it themselves, and the orchestration is where the
bugs have lived: #820's pre-join cursor poisoning, the join-ack ordering, the
don't-leave-room-on-unmount footgun (rooms aren't reference-counted). No new backend
state is needed — Socket.IO rooms are already server-side in-memory state; this only
changes who writes them.

One sequencing caveat: implicit joins _without_ the log merely relocate the race (a
connect-time server join still has a window against events emitted mid-connect). With
the log, that window is harmless because replay covers it. So the order is: log first,
then derived subscriptions delete the client half of INV-53 safely. Selective
subscription (say, bandwidth-constrained mobile skipping high-volume streams) can come
later as a server-side delivery filter rather than client room churn.

### The hard parts (named, not hand-waved)

- **Commit-visibility ordering must be solved once, at the log.** Two workable options:
  (a) allocate the per-workspace sequence inside the domain transaction via the existing
  race-safe upsert pattern (like `stream_sequences`) — the row lock serializes concurrent
  allocators until commit/abort, so allocation order equals commit order and the log is
  gap-free by construction, at the cost of touching every write path and serializing all
  client-visible writes in a workspace on one row; (b) assign sequence numbers from a
  **single-writer sequencer at the dispatch layer** — the `BroadcastHandler` already
  processes outbox events one at a time under an exclusive `CursorLock` with a
  gap-tolerant sliding window, so it can stamp dense per-workspace sync ids in visibility
  order with zero changes to domain write paths. Option (b) is the smaller change and is
  what Part 6 scopes.
- **Per-client replay needs a delivery layer.** Today `io.to(room).emit()` is fire-and-
  forget. A subscription with a cursor means the server tracks, per connection, "replaying
  from X" → "live". This is new server code (a per-connection state machine with
  backpressure), and it is the part where most of the engineering risk lives.
- **Log compaction policy.** Read-state and presence-ish entries churn; the log needs
  retention (e.g., keep N days or M entries per workspace, snapshot-stamp below that).
  The existing delta-vs-replace bootstrap logic is the template.
- **Group membership changes mid-stream.** Joining a stream must inject a snapshot of
  that stream (or its recent window) into the subscriber's feed at the right log position.
  Linear handles this with "partial bootstraps" per sync group; we'd do the same.
- **Migration is incremental but long.** Sketch: (1) introduce the per-workspace sequence
  and stamp it onto outbox rows routed to clients; (2) add the heartbeat + server-side
  catch-up endpoint reading the log by cursor and groups; (3) move the client to one
  cursor, initially alongside the existing per-stream machinery; (4) convert workspace
  patch events to log entries one entity type at a time, deleting their bespoke handlers;
  (5) retire subscribe-then-bootstrap merge machinery last, once nothing depends on
  two-source reconciliation.

## Part 3: Buy-vs-build — the 2026 landscape

Surveyed against our constraints (E2EE ciphertext, per-stream ACLs, Postgres ownership,
offline writes, single ordered cursor, Bun, workspace sharding):

| Engine                            | Verdict              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero 1.0** (Rocicorp, Jun 2026) | No                   | Query-driven sync over a zero-cache replica; genuinely good ACL story (synced queries + custom mutators), but **no offline writes** (documented non-goal) — a regression vs our offline queue. Replaces TanStack Query + Dexie with its client store. 1.0 is weeks old. Replicache is in maintenance mode.                                                                                                                                                                            |
| **ElectricSQL**                   | No                   | Read-path shapes over HTTP long-poll; writes stay DIY. Shapes have **independent offsets** — a shape per stream plus a workspace shape reproduces exactly our two-tier problem. Company pivoted to "Electric Agents" (Apr 2026); sync is no longer the product. Their new Durable Streams primitive is worth watching as a transport idea.                                                                                                                                            |
| **PowerSync**                     | Only real buy option | The one engine checking every box: vendor-documented **E2EE ciphertext sync pattern**, per-stream ACLs via sync-rule buckets, offline-first, writes through your own API (outbox authority preserved), self-hostable. Costs: client moves from Dexie to SQLite-wasm, a new service + bucket storage per region (Postgres bucket storage is beta; historically MongoDB), FSL-licensed server, sync-rule redeploys reprocess buckets. A bigger migration than building the missing 30%. |
| **LiveStore**                     | No                   | Event-sourcing with client SQLite, built on Effect. Unit of sync is a whole store replicated to every client — **no partial visibility**, so per-stream ACLs force store-per-stream or store-per-user. Beta, sponsorware. Conceptually interesting for solo scratchpads only.                                                                                                                                                                                                         |
| **Jazz**                          | No                   | CRDTs with cryptographic permissions — E2EE-native, philosophically aligned, but adopting it means Postgres stops being the source of truth. A rewrite, not a sync-layer swap.                                                                                                                                                                                                                                                                                                        |
| **Convex**                        | No                   | Excellent reactive sync, but it is a full backend replacement (schema, workers, outbox, SQL all gone), and its server-side reactive queries are worthless over ciphertext.                                                                                                                                                                                                                                                                                                            |
| **Linear pattern** (build)        | **Recommended**      | Exactly the single-cursor protocol described in Part 2. We already have the transactional outbox, per-stream sequencing, delta bootstraps, IDB persistence, and the optimistic layer. Best public references: [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) (endorsed by Linear's CTO), plus Linear's own scaling talk.                                                                                                                 |

Also notable: **TanStack DB** (beta → 1.0 around end of 2025) is a client-side reactive
store with live queries and optimistic mutations that explicitly pairs with a custom sync
backend. It is not a protocol, but a custom collection fed by our sync log could later
replace a lot of the Dexie/TanStack Query glue. Separate decision, not a prerequisite.

## Part 4: Effect

[Effect](https://effect.website) is a structured-concurrency / typed-errors / resource-
management library for TypeScript, not a sync engine. Honest assessment for our case:

- **What it would help with:** the per-connection delivery state machine is exactly the
  kind of code Effect is good at — fibers per subscription, `Queue` with backpressure,
  `Schedule` for retry policies, `Scope` for guaranteed teardown on disconnect,
  interruption semantics. LiveStore proves Effect can carry a production sync engine's
  internals. It runs fine on Bun and can be confined to one subsystem behind
  `Effect.runPromise` boundaries.
- **What it would not help with:** the actual problem. Cursor semantics, commit-visibility
  ordering, group-tagged delivery, compaction, partial bootstraps — the protocol is ~80%
  of the work and Effect contributes nothing to it. `@effect/experimental` has an
  `EventLog`/`EventLogEncryption` module that is conceptually adjacent, but it is
  explicitly experimental, sparsely documented, and not a foundation.
- **Costs:** steep learning curve (weeks to proficiency, widely reported); mid-2026 is a
  transition window (v3 stable, v4 in beta since Feb 2026 with official "stay on v3 in
  production" guidance); its Layer/Context DI model overlaps awkwardly with our
  constructor-injection invariants (INV-9/12/13), and its typed-error channel with our
  `HttpError` middleware contract.

Recommendation: do not couple the sync redesign to an Effect adoption. Steal the ideas
(explicit retry policies as values, scoped resources, interruption) for the delivery
layer; revisit the library itself as an independent decision if and when v4 settles.

## Part 5: Pressure tests

Offline-first is a hard product constraint: IndexedDB stays the client's source of
truth, the offline write queue stays, and the design has to assume any client may have
been offline for days. The Part 2 design walked through the nastiest scenarios:

### 1. Mid-stream membership join

A user is added to stream S at log position 1040. They lack all of S's prior state, and
the log filter can't give it to them (entries before 1040 weren't group-visible to them
when written, and may be compacted anyway). Resolution: the `stream:member_added` log
entry itself triggers a **partial bootstrap** of S — the existing stream bootstrap
endpoint, with its response stamped with the log position P it was computed at. The
reconciliation rule is exact: entries for S with sync id ≤ P are skipped, entries > P are
applied. The snapshot-vs-live race that today needs `_patchedAt` wall-clock heuristics
becomes an integer comparison. History-visibility policy stays in the snapshot endpoint
(where it lives today), not in the log filter.

To be explicit about volume: **history is never replayed through the log.** The log is a
forward-only change feed; history is pull-based. The partial bootstrap is the same
windowed snapshot used when opening any stream today — one recent page, older pages
lazy-loaded on scroll — so joining a years-old, very long stream costs a new member
exactly one page, and the log carries only what happens after the snapshot position.

One trap in the naive implementation: a catch-up query that filters by _current_ groups
would also deliver S-tagged entries from before the join (anything still inside the
retained log window between the client's cursor and position 1040). The snapshot skip
rule makes that harmless for correctness (everything ≤ P is skipped anyway), but it
wastes bandwidth on busy streams and, for a private stream with a no-history policy, it
would leak recent pre-join entries. The fix is one condition: the `stream:member_added`
entry's own sync id _is_ the membership's join position, so the catch-up query bounds
each `stream:<id>` group by the requester's join sync id (stored on the membership row
when the sequencer stamps the entry). Stream-tagged entries are only ever delivered from
the join point forward.

### 2. Long offline window hits log compaction

Client returns after two weeks with cursor X; the log only retains entries newer than Y,
and Y > X. The server answers "cursor too old" and the client falls back to a windowed
snapshot stamped with position P, resuming the log from P. The offline-first rules:

- The snapshot **merges** into IDB, never wipes it. Locally cached history older than the
  snapshot window stays — it is still valid data, and it's what makes the app usable
  offline immediately on next launch.
- Pruning applies only inside the snapshot's window, with the snapshot's log position as
  the ceiling — the structural version of today's max-returned-sequence prune rule.
- The pending offline queue is untouched by snapshot application; it replays through the
  normal write path with its existing idempotency. Conflicts (entity deleted while
  offline) surface as normal write-path errors, as they do today.

### 3. Offline and optimistic writes racing replay

On reconnect, catch-up replay and the offline queue flush run concurrently. This is safe
under the same two rules the engine already has: optimistic temp events live **outside
sequence space** (pending/failed events are excluded from cursor computation today;
unchanged), and the client's own writes return through the log carrying the
`clientMessageId` echo, replacing the temp row. A lost ack followed by a retry is
idempotent by `clientMessageId`. The log changes nothing about the write path — by
design.

### 4. Quiet workspace: distinguishing silence from loss

The heartbeat carries the maximum sync id **visible to this client's groups** (one
indexed `MAX` query per connection). Cursor equal to head means genuinely quiet; head
ahead of cursor means catch-up. Today silence and loss are indistinguishable, which is
why zombie-socket pings and page-resume refreshes exist; under the log they become a
cheap comparison.

### 5. Churny entries vs the log

`stream:read` fires on every scroll; presence and typing churn even harder. Three tiers:

- **Last-writer-wins types** (read state, preferences, sidebar config): compact by key —
  keep only the newest entry per `(event_type, entity)` older than a short horizon, like
  Kafka log compaction. Catch-up semantics survive: the newest entry per key either has
  sync id > cursor (returned) or ≤ cursor (client already has it).
- **Append types** (messages, reactions, memberships): time/size-based retention, below
  which the snapshot path covers.
- **Ephemeral types** (typing, presence heartbeats): keep them **off the log** as plain
  emits. Losing them is correct behavior; durable delivery would be a bug.

### 6. Multi-tab, one IndexedDB

Tabs share the persisted cursor. Entry application is idempotent (put-by-id) and cursor
advance is monotonic max, so two tabs syncing concurrently converge without
coordination.

### 7. The honest caveat: phase one keeps two phases

The first client migration step keeps "subscribe over socket + catch-up over HTTP" —
deliberately, because a paged, resumable HTTP catch-up is _better_ on flaky connections
than one giant socket replay, and it reuses the delta-bootstrap shape that exists. What
changes is that reconciling the two sources becomes exact: buffer live entries while
catch-up runs, then apply buffered entries with sync id greater than the catch-up's
position. No `_patchedAt`, no `windowVersion`, no per-field merge logic. A true
single-channel `subscribe(cursor)` with server-side splice is a later refinement, worth
doing only if the buffer-and-splice shape ever bites.

## Part 6: Step 1, scoped — the sync-log spine

Two discoveries from reading the current code change the original sketch:

1. **The BIGSERIAL skip bug is already mitigated** (sliding-window `CursorLock`, see the
   Part 1 correction). Step 1 doesn't need to re-fix the outbox reader; it can build on
   it.
2. **`broadcastEvent` already computes the delivery groups.** Its routing branches
   resolve every event to exactly the rooms `ws:{wsId}`, `ws:{wsId}:stream:{streamId}`,
   `ws:{wsId}:user:{userId}` (`apps/backend/src/lib/outbox/broadcast-handler.ts:148-329`).
   Step 1 persists what the router already computes instead of discarding it after emit.

### Design choice: sequence at the dispatcher, not in domain transactions

Allocating sync ids inside every domain transaction (option (a) in Part 2) is correct but
touches ~100 write sites and serializes each workspace's writes on one row. The
recommended shape is option (b): the `BroadcastHandler` already holds an exclusive
`CursorLock` and processes outbox events in visibility order — it becomes the
**single-writer sequencer**. Costs, stated plainly: the sync id exists only after
dispatch (~10–60ms post-commit, so HTTP responses can't return it — acceptable, clients
key on `clientMessageId`), and log-append isn't atomic with the domain write — a crash
between outbox processing and append is retried via the cursor, made idempotent by a
unique index on `outbox_event_id`.

### Schema (append-only migration, INV-17)

```sql
CREATE TABLE sync_log (
    workspace_id TEXT NOT NULL,
    sync_id BIGINT NOT NULL,
    outbox_event_id BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    groups TEXT[] NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, sync_id)
);
CREATE UNIQUE INDEX idx_sync_log_outbox_event ON sync_log (outbox_event_id);
CREATE INDEX idx_sync_log_groups ON sync_log USING GIN (groups);

CREATE TABLE workspace_sync_sequences (
    workspace_id TEXT PRIMARY KEY,
    next_sequence BIGINT NOT NULL DEFAULT 1
);
```

No FKs (INV-1), workspace-scoped (INV-8). E2EE: `payload` carries sealed envelopes
exactly as outbox payloads do today; `groups` and ordering are plaintext metadata.

### Changes

1. **`BroadcastHandler`**: for client-routed events, per batch (set-based, INV-56): group
   events by workspace, allocate N sync ids per workspace via the `stream_sequences`-style
   race-safe upsert (INV-20), multi-row `INSERT INTO sync_log ... ON CONFLICT
(outbox_event_id) DO NOTHING` (reading back existing ids on conflict for crash-retry),
   then emit each event with its `syncId` attached to the payload. Bot-namespace events
   stay off the log.
2. **Catch-up endpoint**: `GET /api/workspaces/:workspaceId/sync?after=<syncId>&limit=<n>`
   → `{ entries, head }`, filtered to the requester's groups (workspace + stream
   memberships + own user group), with each `stream:<id>` group bounded below by the
   membership's join position (see pressure test 1 — prevents pre-join over-delivery and
   no-history leaks). Zod-validated (INV-55), repository-backed (INV-5), lives in
   `apps/backend/src/features/sync/` (INV-51).
3. **Head exposure**: the catch-up response carries `head` (max visible sync id); the
   client's existing page-resume/visibility hooks can check it cheaply. A dedicated
   per-connection heartbeat lands with client adoption (step 2), not here.
4. **Retention**: deferred. The outbox retention-worker pattern gets copied with a
   generous time-based policy (weeks, not hours) when compaction is designed; until then
   the table grows, which is fine at current volumes.

### Explicitly out of scope for step 1

No client behavior change (clients may ignore `syncId` entirely), no handler
conversions, no compaction worker, no per-connection replay machinery.

### What step 1 buys on its own

- A dropped socket emit (the "availability > guaranteed delivery" skip in
  `broadcast-handler-event-loss.md`) stops being permanent loss: the entry is durable
  before the emit and any future catch-up returns it.
- The routing branches' group computation becomes persisted, inspectable, testable data.
- Step 2 — the client holding one cursor — becomes purely client-side work against an
  endpoint that already exists.

### Test plan for step 1

- Sequencer idempotency: reprocessing the same outbox event after a simulated crash
  yields the same sync id and no duplicate row.
- Ordering: concurrent outbox commits produce dense, gapless per-workspace sync ids in
  visibility order.
- ACL filtering: catch-up returns only entries whose groups intersect the requester's;
  a membership change is reflected on the next fetch.
- E2EE passthrough: sealed payloads round-trip the log untouched.

## Part 7: Background sync — fresh on reopen

The recurring complaint: backgrounded or closed on a phone, the app reopens to stale
data and visible loading. The goal is that by the time the user is looking at the
screen, the data is already current — which means syncing _before_ the open whenever the
platform allows it, and making the on-open catch-up cheap enough to hide when it
doesn't.

### What exists today, and why it's stuck

`apps/frontend/src/sw.ts` already does push-triggered background prefetch, and its shape
is the two-tier problem wearing a service-worker costume:

- **Stream bootstrap**: the SW fetches and writes events **directly into IDB** — by
  duplicating a slice of `stream-sync`'s apply logic (`_cachedAt` stamps, preview
  derivation) inside the SW, a second implementation that has to be kept honest by hand.
- **Workspace bootstrap**: the SW explicitly **can't** apply it — its own comment says
  the apply pipeline "is large and lives in workspace-sync; running it from the SW would
  duplicate that surface" — so it warms an HTTP cache (`PUSH_BOOTSTRAP_CACHE`) and hopes
  the page's next GET hits it. The cache-interceptor approach has already bitten once
  (#702 had to stop serving stream bootstraps from the push cache).

The blocker isn't the platform; it's that today's "apply server state" logic is
main-thread-shaped: spread across socket handlers, TanStack cache patches, and the
bootstrap merge machinery. A service worker can't run it, so background sync can only
nibble at the edges.

### What the log changes

Under v2, applying server state is `fetch /sync?after=cursor` → run **the same pure
entry reducers** (log entries in, IDB writes out) the foreground uses. No React, no
TanStack, no socket — exactly the dependency profile a service worker has. Background
sync stops being a parallel implementation and becomes the same code on a different
trigger:

1. **Sync-on-push** (all platforms with push, including iOS 16.4+ installed PWAs):
   every push the SW handles runs a catch-up from the persisted cursor inside
   `event.waitUntil()` before showing the notification. Since most "open the app after
   being away" moments on mobile are notification taps, the common path lands on
   already-fresh IDB. This generalizes today's prefetch to _all_ data, not just the
   notified stream.
2. **Periodic Background Sync** (Chrome/Android installed PWAs only): register a
   periodic tag and run the same catch-up on the browser's schedule (engagement-based,
   roughly hours). Ambient freshness for the Android case; simply absent on iOS, which
   is why sync-on-push is the primary mechanism, not this.
3. **One-shot Background Sync** (already used by `queueBootstrapSync`): keeps the
   retry-on-connectivity semantics for queued work; unchanged role.
4. **On open, the catch-up is one request.** Coordinated loading already paints from IDB
   immediately; with a single cursor the freshness pass is one `GET /sync?after=X`
   applied behind the already-painted UI, instead of N bootstraps racing the reveal
   gate. "Loading" survives only on cold start and compacted-cursor falls-back — both
   snapshot paths.

### Constraints to respect

- **E2EE**: catch-up entries carry sealed payloads; the SW writes ciphertext to IDB
  without needing keys, and decryption stays at render time behind the unlock gate,
  exactly as today. Background sync must never require key material.
- **Cross-context reactivity**: the SW writing IDB while a frozen page holds in-memory
  caches means the resume path must re-read (we've been burned by cross-context
  liveQuery behavior before — the #700-era SW interceptor lessons). The existing
  page-resume hook becomes "compare cursor, re-read if it moved", which is cheap and
  exact.
- **iOS honesty**: no periodic sync, push requires a visible notification, installed-PWA
  only. On iOS the achievable promise is "fresh when opened from a notification, one
  cheap catch-up otherwise" — that is still a large improvement over today's
  multi-bootstrap reveal.
- **Battery/quota**: catch-up from a recent cursor is a small delta by construction;
  push-piggybacked work runs inside the push's existing wake window.

## Recommendation

1. **Build the single-cursor protocol as an evolution of the existing engine** (Part 2
   migration sketch). It is the only option that keeps E2EE, per-stream ACLs, Postgres
   ownership, offline writes, and the Bun stack all intact, and most of the prerequisites
   already exist in this codebase. It is also what makes real background sync (Part 7)
   implementable: a service worker can run "fetch from cursor, apply entries to IDB",
   but it can never run today's main-thread apply pipeline.
2. **First concrete step, valuable on its own:** the sync-log spine scoped in Part 6 —
   per-workspace sync ids assigned at the dispatcher, persisted to a `sync_log` table,
   plus a group-filtered catch-up endpoint. From that point a dropped socket emit is no
   longer permanent loss (the entry is durable and replayable), and the later client
   migration becomes purely client-side work.
3. **Spike PowerSync only if** we decide we don't want to own a sync engine at all — it is
   a credible product, but the migration (client SQLite, new service + bucket storage,
   sync rules) is larger than building our missing pieces.
4. **Defer Effect and TanStack DB** as independent, later decisions about implementation
   ergonomics, not architecture.
