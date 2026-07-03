# Sparse read overlay — conversation-aware read state

Status: design, v1 (draft — wire details pending investigation pass). Sibling to
[`board-view-design.md`](./board-view-design.md); this doc extends the read
model so the board/conversation surfaces can mark messages read without lying
about the stream.

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
   semantics. All existing events (`stream:read` max-merge, `stream:read_set`,
   `stream:read_all`) keep their exact meaning. The timeline keeps owning it.

2. **A sparse overlay above the watermark.** New workspace-scoped table
   (working name `stream_member_message_reads`): individually-read messages
   _above_ the watermark, keyed `(workspace_id, stream_id, user_id,
message_id)`. A message is **effectively read** iff
   `ordinal ≤ watermark OR id ∈ overlay`.

   Writes come from the conversation surfaces. "Mark conversation read up to
   message X" **expands to concrete member-message ids at write time**
   (snapshot semantics — immune to later re-clustering, closing the trap
   above), grouped by each member's own stream (a conversation spans root +
   threads), bulk-inserted `ON CONFLICT DO NOTHING` (INV-20, INV-56).

3. **Compaction makes the layers complementary.** In the same transaction as
   any overlay write (and any watermark advance): if the overlay covers the
   contiguous run of messages immediately above the watermark, advance the
   watermark over that run and delete the absorbed rows — one set-based SQL
   statement, race-safe. Reading the frontier on the board just moves the
   watermark; the overlay only holds _holes_, and most reading happens in the
   timeline (wholesale watermark advance), so the overlay stays small and
   self-erasing. (Zulip's pure per-message-flag model with no watermark is the
   cautionary tale; the hybrid keeps the sparse set bounded to gaps in recent
   history.)

### Derived state per surface

- **Stream unread count** = messages above watermark − overlay size.
  Touches `countUnreadByStreamBatch` (LEFT JOIN the overlay), bootstrap
  `unreadCounts`, and the frontend ordinal math (`unread = latest − read −
overlayAbove`).
- **Card unread** = "does this conversation contain any effectively-unread
  message", computed at read time against _current_ membership. Merge/split/
  reassign only changes what the question ranges over; no stored state to
  corrupt.
- **Timeline**: an overlay-read row above the divider renders as read; the
  "new messages" divider means "first _effectively_ unread".

### Mark-unread (the asymmetric inverse)

- **Above the watermark**: delete the conversation's member ids from the
  overlay. Clean.
- **Below the watermark**: regress the watermark to just before the
  conversation's earliest member (existing `stream:read_set` semantics),
  accepting collateral un-reading of interleaved messages — the same contract
  the timeline's "mark as unread" already has ("this and everything after").
  A _negative_ overlay (sparse unread exceptions below the watermark) is
  explicitly rejected: two overlays with opposite signs is unmaintainable.

### Threads without membership rows

Thread membership is participation, not access (INV-62): a viewer can read a
thread's messages on a card with no `stream_members` row for that thread. The
overlay table deliberately does not require a membership row. For non-member
threads: overlay-only, no watermark compaction (nothing to compact into).

## Sync plan

- New author-scoped outbox event (working name `stream:read_messages`)
  carrying the stream id + message ids added to the overlay, flowing through
  the same delivery groups as `stream:read`. Compaction emits a standard
  `stream:read` alongside — clients already know what that means.
- Client holds the overlay per stream (IDB + counter state), applies
  `stream:read_messages` additively, and drops overlay entries at/below the
  watermark whenever a `stream:read`/`read_set` lands (client-side compaction
  mirror).
- Exact count-convergence math (how the client knows overlay∩above-watermark
  without full ordinal knowledge) is pinned after the read-path investigation:
  candidates are server-stamped overlay-above-watermark size on each event vs.
  client-side sequence comparison via IDB events.

## Surfaces shipped with v1

- `MessageItem` (board card / conversation panel) menu: "Mark read up to
  here" / "Mark as unread" in **conversation geometry** — they operate on the
  conversation's member messages, not the raw stream prefix.
- Board card unread indicator, derived per the rule above.
- Timeline honors the overlay (divider + row bolding = effectively-unread).

Out of scope for v1: viewport-driven auto-read on the board (the "seen"
question — board-view-design edge 6 territory); restoring activity badges on
mark-unread (already an accepted gap for the stream path).

## Companion fix: phantom-unread drift (rides the same PR)

Reported: a stream shows unread (sidebar section + green + count 1, activity
badge 1) but opening the stream and the activity feed shows nothing; the badge
persists. Root-cause chain under verification (hypothesis: client
`latestOrdinals` max-merge + ordinals-as-counts means a message deleted/moved
after its `stream:activity` leaves the client's latest permanently inflated;
the same staleness guard then blocks the D2 activity-row drop). Findings and
fix land in this doc when the verification pass completes.
