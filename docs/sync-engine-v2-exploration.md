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
  BIGSERIAL allocation order ≠ commit order, so under concurrency a handler's cursor can
  permanently skip a still-invisible row. This affects every outbox consumer, not just
  broadcast.

Both are symptoms of cursoring an allocation-ordered log with no commit-visibility
horizon and no acknowledgment. Fixing delivery per-symptom (skip on error, maybe later a
gap-aware cursor) keeps the at-most-once semantics; clients can never trust the feed.

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

### The hard parts (named, not hand-waved)

- **Commit-visibility ordering must be solved once, at the log.** The BIGSERIAL gap from
  `outbox-sequence-gap.md` becomes the central correctness problem instead of a per-handler
  one. Two workable options: (a) a per-workspace sequence allocated via the existing
  race-safe upsert pattern (like `stream_sequences` today) — serializes writes within a
  workspace on one row, which is acceptable at our workspace sizes and is what makes the
  log gap-free by construction; (b) keep global BIGSERIAL but maintain a server-side
  "safe horizon" (advance only past ids below the oldest in-flight transaction, via
  `pg_current_snapshot()`), and never deliver past the horizon. Option (a) is simpler and
  also fixes the existing outbox consumers if they move to the same log.
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

## Recommendation

1. **Build the single-cursor protocol as an evolution of the existing engine** (Part 2
   migration sketch). It is the only option that keeps E2EE, per-stream ACLs, Postgres
   ownership, offline writes, and the Bun stack all intact, and most of the prerequisites
   already exist in this codebase.
2. **First concrete step, valuable on its own:** per-workspace sequencing on
   client-routed outbox events + a commit-visibility-safe cursor. This fixes the
   still-open BIGSERIAL skip bug (`outbox-sequence-gap.md`) and the lossy-on-error
   broadcast semantics for every consumer, before any client work starts.
3. **Spike PowerSync only if** we decide we don't want to own a sync engine at all — it is
   a credible product, but the migration (client SQLite, new service + bucket storage,
   sync rules) is larger than building our missing pieces.
4. **Defer Effect and TanStack DB** as independent, later decisions about implementation
   ergonomics, not architecture.
