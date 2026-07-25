# Sparse read overlay — conversation-aware read state

Status: design, v2 (contracts pinned; implementation in flight). Sibling to
[`board-view-design.md`](./board-view-design.md); this doc extends the read
model so the board/conversation surfaces can mark messages read without lying
about the stream, and fixes the phantom-unread drift family found while
verifying the design.

## The problem: two read geometries over one ordering

The timeline reads a **contiguous prefix**: one rising watermark per
(stream, member) — `stream_members.last_read_event_id` — with unread derived as
`latestOrdinal − readOrdinal` on both sides of the wire
(`countUnreadByStreamBatch`, `unread-counters.ts`).

The board reads a **filtered projection**: a conversation's member messages are
interleaved with other conversations' messages in the same stream. Reading card
A means you saw ordinals {5, 7, 9} while 6 and 8 (card B's) stay genuinely
unread. A single pointer physically cannot represent that:

- Advance the watermark past 9 → falsely marks B's messages read.
- Don't move it → the stream still shows A's messages unread. Double-read.

## The trap: per-conversation read pointers

A `conversation_reads(conv_id, user_id, last_read_…)` table is the obvious
model and it is wrong **as truth**, for a Threa-specific reason: conversation
membership is mutable. The extractor retitles, merges, splits; reassignment is
a first-class correction. If read-truth hangs on the cluster label, a message
moving between conversations silently flips read state, merges double-count,
splits lose state.

> **Invariant (this doc's core rule): read truth is message-granular and
> stream-anchored. Conversation read state is always derived, never stored.**
> You read messages, not cluster assignments.

## The model: watermark + sparse overlay + compaction

Two layers of truth, one derivation:

1. **The watermark — unchanged.** `last_read_event_id`, contiguous-prefix
   semantics. All existing events keep their meaning. The timeline keeps
   owning it.

2. **A sparse overlay above the watermark.** Table
   `stream_member_message_reads`: individually-read messages _above_ the
   watermark. A message is **effectively read** iff
   `sequence ≤ watermark OR id ∈ overlay`.

   Writes come from the conversation surfaces. "Mark conversation read up to
   message X" **expands to concrete member-message ids at write time**
   (snapshot semantics — immune to later re-clustering, closing the trap
   above), grouped by each member's own stream (a conversation spans root +
   threads), bulk-inserted `ON CONFLICT DO NOTHING` (INV-20, INV-56).

3. **Compaction makes the layers complementary.** In the same transaction as
   any overlay write: if the overlay covers the contiguous run of messages
   immediately above the watermark, advance the watermark over that run and
   delete the absorbed rows (set-based, under the locked membership row).
   Reading the frontier on the board just moves the watermark; the overlay
   only holds _holes_, and most reading happens in the timeline (wholesale
   watermark advance), so the overlay stays small and self-erasing.

**Overlay invariant: every overlay row sits strictly above its member's
watermark.** Every watermark advance (`markAsRead`, `markAllAsRead`,
compaction) prunes rows at/below the new watermark in the same transaction.
This keeps the client math trivial: the overlay's size is exactly the count to
subtract.

### Pinned schema

```sql
CREATE TABLE stream_member_message_reads (
    workspace_id TEXT NOT NULL,          -- INV-8
    stream_id    TEXT NOT NULL,
    member_id    TEXT NOT NULL,          -- INV-50: stream-membership surface
    message_id   TEXT NOT NULL,
    event_id     TEXT NOT NULL,          -- denormalized at write
    sequence     BIGINT NOT NULL,        -- denormalized at write; refreshed on move
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_id, member_id, message_id)
);
```

`event_id`/`sequence` are denormalized because `stream_events` keys messages
inside `payload->>'messageId'`; resolving once at write (the move flow's
unnest-join pattern) keeps compaction and pruning index-friendly. A message
move is the only thing that changes them, and the move transaction rehomes
overlay rows anyway (below). No FKs (INV-1), no membership-row requirement —
that is load-bearing for threads (see below).

### Derived state per surface

- **Stream unread count** = messages above watermark − overlay size (the
  invariant makes these disjoint-free). Server: `countUnreadByStreamBatch`
  subtracts a per-(stream, member) overlay count; bootstrap `unreadCounts`
  becomes this **effective** unread. Client:
  `unreadCounts[s] = max(0, latestOrdinals[s] − readOrdinal(s) − |overlay(s)|)`
  with the read position reconstructed as `latest − unread − |overlay|`.
- **Card unread** = "does this conversation contain any effectively-unread
  message", computed at read time against _current_ membership.
- **Timeline**: row read state, the "new messages" divider, and the
  new-message flash all mean "first/any _effectively_ unread" — watermark
  comparison plus an overlay-set membership check.

### Mark-unread (the asymmetric inverse)

- **Above the watermark**: delete the member ids from the overlay. Clean.
- **Below the watermark**: regress the watermark to just before the
  conversation's earliest member in that stream (existing `stream:read_set`
  semantics), accepting collateral un-reading of interleaved messages — the
  same contract the timeline's "mark as unread" already has. A _negative_
  overlay (sparse unread exceptions below the watermark) is explicitly
  rejected: two overlays with opposite signs is unmaintainable.

### Threads without membership rows

Thread membership is participation, not access (INV-62): a viewer can read a
thread's messages on a card with **no** `stream_members` row
(`checkStreamAccess` resolves thread→root; `StreamMemberRepository.update`
no-ops without a row, so the existing `markAsRead` is a silent no-op on such
threads). The overlay deliberately does not require a membership row:
non-member thread legs are **overlay-only** — no watermark to advance, no
compaction target. This is why the overlay, not a membership upsert, is the
right storage: upserting memberships on read would corrupt the
membership≠access contract.

## Wire contracts (pinned)

All read events are author-scoped: register in **both** `AuthorScopedEventType`
and `AUTHOR_SCOPED_EVENTS` (`lib/outbox/repository.ts` — the two-place gotcha),
plus `OutboxEventType` and `OutboxEventPayloadMap`. Payload types follow the
house split (backend `lib/outbox/repository.ts`, frontend inline in
`workspace-sync.ts`) — no shared `@threa/types` socket type.

- **NEW `stream:read_messages`** — the absolute post-write read-state snapshot
  for one stream:
  `{ workspaceId, authorId, streamId, readMessageIds: string[],
lastReadEventId: string | null, lastReadSequence: string,
lastReadOrdinal: number }`.
  `readMessageIds` is the **entire** overlay for that (stream, member) after
  the write (post-compaction) — absolute state, not a delta, so application is
  idempotent and order-convergent under the sync log's per-workspace total
  order. Emitted by every sparse-read write.
- **`stream:read` / `stream:read_set`** gain `readMessageIds?: string[]` — the
  post-write overlay (usually empty/shrunk after pruning). `undefined` means
  "not carried" (old event during rollout → leave the client set unchanged);
  `[]` means "overlay now empty". The server always includes it going forward.
- **`stream:read_all`**: the server wipes overlay rows for every updated
  stream; the client clears each read stream's set.
- **`messages:moved`** gains `sourceMessageOrdinal: number` (the source
  stream's post-move `message_created` count). The move transaction also:
  (a) rehomes overlay rows for moved messages (`stream_id`, `event_id`,
  `sequence` refreshed to destination), and (b) repoints any source
  membership whose `last_read_event_id` is a moved event to the nearest
  surviving prior source event (set-based) — fix A3 below.
- **Message delete**: the delete transaction marks the message's
  `user_activity` rows read (`read_at = NOW() WHERE message_id = … AND
read_at IS NULL`). No new socket event: clients already receive the
  `message_deleted` stream event and drop held activity rows for that
  message id there (mirror `dropReactionActivity`) — fix A2 below.

### Client counter math

`CachedUnreadState` gains `readMessageIds?: Record<string, string[]>`
(IDB version bump). Invariant everywhere:

```
unreadCounts[s] = max(0, latestOrdinals[s] − read(s) − |readMessageIds[s]|)
read(s) is implicit: latest − unread − |overlay|
```

- `stream:read_messages` / `readMessageIds`-carrying events **SET** the
  overlay set (absolute snapshot; safe under syncId-ordered application).
- Watermark ordinals keep their existing merge rules (`stream:read`
  max-merges, `read_set` SETs).
- `messages:moved` applier **SETs** `latestOrdinals[source] =
sourceMessageOrdinal` and recomputes unread — the one sanctioned
  non-monotonic latest write (precedent: `applyStreamReadSet`). Fix A1 below.
- Bootstrap (`toCounterState`/`withCounterState`) carries the overlay;
  `mergeReconnectWorkspaceBootstrap` must keep the
  `unreadCounts`/`messageCounts`/`readMessageIds` **triple** paired per
  stream (today it pairs the first two).

`WorkspaceBootstrap` gains `readMessageIds?: Record<string, string[]>`
(this one _is_ a shared API type in `@threa/types`).

## Conversation read API (pinned)

- `POST /api/workspaces/:workspaceId/conversations/:conversationId/read`
  body `{ throughMessageId }` (Zod, INV-55)
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/unread`
  body `{ fromMessageId }`

`ConversationService.markRead/markUnread` own one transaction each (INV-6):

1. Access check via the conversation's root stream (INV-62 single-root check).
2. Member set = `message_ids ∪ secondary_message_ids` (+ the thread-anchored
   opening's parent message), resolved via `MessageRepository.findByIds`.
3. **Cutoff = the target message's `createdAt`** (inclusive), applied across
   all spanned streams — timestamps are the card's cross-stream merge key
   (sequences aren't comparable across streams). Read: members with
   `createdAt ≤ cutoff`; unread: members with `createdAt ≥ cutoff`.
4. Group by each member message's own stream; process streams in sorted order
   (deterministic lock order — two concurrent conversation-reads must not
   deadlock); lock the membership row `FOR UPDATE` where one exists (INV-20).
5. Per stream: overlay insert → compaction → prune; or overlay delete →
   watermark regress. Emit **one** event per touched stream
   (`stream:read_messages`, or `stream:read_set` on regress), same
   transaction (INV-4/INV-7).

Frontend: the conversation hosts (`BoardCard`, `ConversationPanelBody`) own
the mutation + optimistic apply and hand `MessageItem` its row read state and
the two callbacks; rows stay UI-focused (INV-15). The label page sets neither
→ the actions hide there (the same field-one-side-sets gate as
`conversationId`).

### Card unread derivation

Per spanned stream, a member message is unread iff it's past that stream's
read frontier and not in the overlay. Every leg — root, member-thread, and
non-member thread leg alike — resolves through its OWN effective frontier
(standalone `stream_read_state` row wins when present, membership mirror
fills an absent row during the rollout). Non-member legs get theirs lazily:
the per-stream bootstrap carries the viewer's standalone frontier and the
client persists it on open (a confirmed-absent row seeds a never-read
sentinel — for a non-member, "no row" IS "before the first message"). A leg
with no frontier yet is ungated, not approximated: the v1 root
`last_read_at` time fallback was removed with the non-member unlock (read
state re-homed off `stream_members`) — a card only renders rows from streams
whose bootstrap ran, so rendered legs resolve. The board card rail must
retain `sequence` on its rows (`eventToRenderable` currently drops it).

The stable-view "N new" pill (`use-stable-board-view`) is ordering-buffer
state and stays fully independent of read state.

## Phantom-unread drift — verified root causes + fixes (same PR)

Reported: a stream shows unread (sidebar section + green + count 1, activity
badge 1) but opening the stream and the activity feed clears nothing.
Investigated and adversarially re-verified; three real defects:

1. **A1, message half (CONFIRMED)** — `messages:moved` relocates
   `message_created` rows out of the source stream
   (`event-service.ts:1153-1171`), so the source's true count drops; no
   client applier ever corrects `latestOrdinals` downward (max-merge only,
   `unread-counters.ts:153,178`), so `unread = inflatedLatest − trueRead > 0`
   sticks for the whole session (heals only on a full network bootstrap;
   cache-first bootstrap re-serves the drift). **Fix:** the
   `sourceMessageOrdinal` payload + SET applier above.
   _(The originally-suspected delete trigger is refuted: deletion soft-deletes
   and keeps the `message_created` row, so ordinals are delete-stable.)_
2. **A2 (CONFIRMED, reload-surviving)** — message deletion never touches
   `user_activity` (`event-service.ts:916-957`): an unread activity row for a
   deleted message survives server-side forever unless the user opens that
   exact stream. **Fix:** mark the message's activity rows read in the delete
   transaction + client-side held-row drop on `message_deleted`.
3. **A4 (CONFIRMED, reload-surviving)** — on move, the activity row is
   rehomed to the destination thread on both sides
   (`messaging/repository.ts:513-519`, `rehomeActivities`); opening the
   _root_ clears nothing under the thread, so the badge persists on a stream
   the user never visits. Rehoming itself is correct (the row must deep-link
   to where the message lives). **Fix (backstop):** opening the activity feed
   reconciles the held set against the server's `unreadOnly` feed — replacing
   the held rows so the badge can never disagree with what the feed shows.
   This also mops up any residual variant: the badge converges to feed truth
   the moment the user looks.
4. **A3 (verify during implementation)** — a source membership whose
   `last_read_event_id` points at a since-moved event counts unread against a
   foreign thread-space sequence in `countUnreadByStreamBatch`
   (`event-repository.ts:707`) — survives reload. **Fix:** the watermark
   repoint in the move transaction. Ship with a regression test either way.

_(The activity half's originally-hypothesized D2-guard blockage was refuted
in verification: `prevRead` collapses to 0 in the canonical scenario and the
`markAsReadMutation` clears held rows unconditionally on stream open. The D2
coupling is untouched by this work.)_

## Viewport auto-read (shipped as a follow-up)

Reading IS marking — the menu actions are the override, not the primary UX.
`useConversationAutoRead` (`apps/frontend/src/components/message/use-conversation-auto-read.ts`)
runs on both conversation surfaces (board card, panel), frontend-only over the
same conversation mark-read cutoff API:

- A row is **seen** after ~1s of any-part-in-viewport dwell
  (IntersectionObserver) while the viewer's attention is on the page — the
  same visible/focused gate as the stream's auto-read, shared via
  `useAutoReadAttention` (phone-like devices relax the focus check).
- Seen rows debounce (~2s) into **one** `markRead(conversationId,
newestSeenRow)` per conversation; the gate re-checks effective unread at
  fire time, so it is idempotent against the overlay and never fires on a
  read conversation.
- Every **rendered row** is eligible. On a collapsed card the cutoff through
  a trailing-preview row also covers the hidden "N more" middle —
  deliberate: the card IS the conversation surface, so reading its visible
  tail reads the conversation up to there, exactly like invoking "Mark as
  read up to here" on that row. (v1 protected the hidden middle by making
  gapped cards opening-only; dogfooding showed that renders the feature
  inert on any active conversation — Kris's ruling: having the conversation
  open is enough to mark it.)
- Mark-as-unread **pins**: the menu action signals the hook synchronously
  BEFORE its request departs (the controller's `setExplicitUnreadListener`);
  the cross-device case is caught by diffing **raw read truth** per spanned
  stream (the controller's `getReadTruth`) — a watermark sequence decrease,
  or overlay ids removed without a compensating watermark advance, exposing
  a row the surface shows. Never derived row state: derivation flaps (the
  `unreadCounts === 0` short-circuit falling back to a stale frontier when a
  count leaves zero, the timestamp fallback for sequenceless rows) read as mass
  read → unread regressions, and a false pin on a static board card never
  releases — that wedge was the first dogfood failure. Pinning unsees
  everything and suppresses **every eligible row** — not just the
  currently-visible set, because visibility is unknowable across observer
  teardowns (attention loss, id-set changes) and under-suppressing would let
  a still-on-screen row dwell and cutoff-mark right back over the explicit
  unread. Auto-read holds entirely while any suppression is active; each
  row's suppression releases when the observer reports it off-screen — the
  stream timeline's `pinnedRef`, with leave-and-return as the resume gesture
  (a small card has no scroll to watch).
- Rows are matched by `data-message-row` on the `MessageItem` container, not
  bare `data-message-id` — editor nodes (quote reply, in-app links) render
  `data-message-id` inside the card's composer, and observing those would let
  a quoted message "dwell" beside the cursor.
- Optimistic `temp_` rows are never targets (the id doesn't exist
  server-side yet).

## Out of scope for v1

- Restoring activity badges on mark-unread (accepted gap, matches the
  stream path).
- Offline queueing for read actions (existing read mutations are not queued;
  the new ones match — parity, not a regression).
- A principled read frontier for non-member threads — delivered with the
  read-state re-home: legs carry their own standalone frontier (v1 used the
  root `last_read_at` time fallback on cards).
