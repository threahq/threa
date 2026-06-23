# Activity unread counters: derive from the data

## Problem

The Activity badge (`Σ activityCounts`) and the per-stream sidebar glow
(`mentionCounts`) can show a count with nothing behind it — a glowing "2" over an
empty feed, "Mark all read" offered with nothing to read. Forensics on a real
workspace confirmed the reporting user had **zero** unread `user_activity` rows
server-side while the UI showed a positive badge.

There are two layers, but only one root cause.

**The trigger (a regression).** The client keeps the activity/mention counters as
a separate map that is SET by `activity:created` and zeroed by `stream:read`
(`applyStreamReadOrdinal`, `apps/frontend/src/sync/unread-counters.ts:90-109`).
Before #1017, opening any stream auto-marked the loaded tail read, fired
`stream:read`, and zeroed that stream's activity count **on every open** — a
continuous reconcile-to-zero that silently masked any drift. #1017 switched
auto-read to the seen-frontier (`undefined` when caught up), so a caught-up open
no longer fires `stream:read`, and the masking stopped.

**The actual bug (always latent).** Three server paths lower or re-home
`user_activity` truth without a corresponding client counter event, so the
maintained map strands high:

- **reaction removal** deletes rows, emits nothing;
- **message move** re-homes rows (`UPDATE user_activity SET stream_id = …`), so
  the source stream's count is never lowered;
- **cross-device stream-read** — `markStreamAsRead`
  (`apps/backend/src/features/activity/repository.ts:343-352`) sets `read_at` on
  the stream's rows but emits no counter event, so other devices never hear it.

The deeper issue is the shape, not the missing emits: **a separately-maintained
aggregate can outrun the data.** The badge can claim more than the feed can show.
Patching each silent path (the closed #1059 approach) hardens the wrong layer —
the next mutating path that forgets to emit silently regresses it again.

## Goal

The badge and the per-stream glow are **derived from the unread activity the
client actually holds** — the same rows the feed renders — never a separately
mutated number. A count can never exceed what the feed can show, so "badge over
empty feed" becomes structurally impossible rather than patched after the fact.

Sparse per-item activity stays exactly as today; coupling (reading the source
clears its activity) stays. This is a frontend-shaped change: the server model is
already correct.

## Design decisions

### D1. Activities stay sparse and per-item — unchanged

`user_activity` remains a set of individually-read rows
(`read_at IS NULL AND is_self = FALSE` = unread; schema at
`apps/backend/src/db/migrations/20260212232139_member_activity.sql` +
`…_user_activity_is_self_and_reactions.sql`). Because each activity is read
independently, activities are **order-independent**: there is no pointer, so the
non-linear / recency-ordering problem (reading messages 1, 3, 2 as threads bump)
that afflicts the message prefix-pointer simply does not apply here. We do not
introduce a read-horizon or watermark for activities — that would be a
message-pointer generalization the data doesn't need.

The server already computes counts as a plain aggregate over the sparse rows
(`countUnreadGrouped`, `apps/backend/src/features/activity/repository.ts:233-261`).
That stays the bootstrap/reconcile truth.

### D2. Coupling stays — reading the source clears its activity

"Seeing the reason is seeing the activity." Reading a stream clears that stream's
activity rows, which is already the server behavior (`markStreamAsRead`,
`repository.ts:343-352`). No change server-side; the change is making the client
reflect it by dropping rows (D4), not by zeroing an opaque counter.

### D3. Badge and glow are selectors over the held unread set

Remove the maintained `activityCounts` / `mentionCounts` maps as a source of
truth. The unread-activity collection becomes a synced dataset
(subscribe-then-bootstrap, INV-53); the activity feed renders it and the badge
**counts it**:

- workspace badge = size of the held unread set (display-capped, e.g. `99+`);
- per-stream activity count (`getActivityCount`) = the set's rows grouped by `streamId`;
- per-stream mention count (`getMentionCount`) = those rows filtered to `activity_type = 'mention'`.

These are the two per-stream selectors the sidebar already consumes; the model re-derives both from the held set and preserves their current meaning — the mention indicator is **not** widened to all activity.

Because the badge and the feed read the **same** dataset, they cannot disagree.
This makes a deliberate trade: the badge reflects _what the client holds_, never a
server total beyond it — a capped, honest count that can never exceed the feed is
the whole point. Exactness beyond the cap is sacrificed to kill the phantom.

### D4. Maintain the set by row add/remove/move, not count deltas

The same events drive the collection, applied as row operations and reconciled
against server truth on bootstrap/reconnect:

| Event                    | Apply                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activity:created`       | upsert the carried row by its stable `activity.id` (payload includes the full `activity`, `outbox-handler.ts:343-361`); ignore its absolute `counts` — plain append would duplicate on sync-log replay |
| `stream:read` (coupling) | drop the set's rows for that `streamId`                                                                                                                                                                |
| `reaction:removed`       | drop the matching row (`messageId`, `actorId`, `emoji`)                                                                                                                                                |
| `messages:moved`         | re-home affected rows' `streamId`                                                                                                                                                                      |
| mark-all-read            | clear the set                                                                                                                                                                                          |

Because the set is small (sparse) and reconcilable, a missed event self-heals at
the next bootstrap — and even while momentarily stale the badge stays consistent
with the feed (never phantom). Rows are keyed by `activity.id`, so a replayed
`activity:created` (sync-log catch-up, INV-53) upserts in place rather than
duplicating; bootstrap replaces the held set wholesale, so transient drift
converges to server truth. This is the key difference from the maintained
counter: a missed event can make the set briefly _incomplete_, but never make the
badge _outrun_ the data.

### D5. The `stream:read`-on-caught-up regression must still be fixed

Coupling (D2/D4) only clears a stream's rows when `stream:read` actually fires.
The #1017 regression — caught-up opens not firing it — must be fixed so reading a
fully-read stream still clears activity that arrived with no new message to scroll
past (e.g. a reaction while caught up). This is the one genuinely separate fix;
keep the `atLastRow` heal idea from the closed #1059 and drop everything else from
that branch.

### D6. Discard the #1059 push-emit machinery; start from main

`activity:counts`, `emitActivityCountsForPairs`, and the `messages:moved` activity
branch were all hardening the maintained aggregate — the wrong layer.
Implementation starts from `main`; keep only the D5 heal.

## Out of scope — handover for B later

**Message read-state precision under non-contiguity.** Message read-state is a
single `stream_members.last_read_event_id` — an O(1) per-`(user, stream)` prefix
pointer. A single prefix can't express a hole, so two cases are lossy today:

- **mark-as-unread** (`stream:read_set`) moves the one pointer backward,
  re-unreading the suffix — it can't represent "5 unread, 6–10 read";
- **open-at-bottom** (#1017): seeing the newest before the oldest isn't a prefix
  either ("seen 100, 1–99 unread"), which is what #1017's frontier/partial logic
  is wrestling with.

This is separate from activities and deliberately not fixed here. The asymmetry
with activities is about **volume**, not taste: per-item read state is one bit per
message per user — infeasible at message volume, trivial at activity volume (a
handful of notifications), which is why messages use a pointer and activities use
rows. So the message fix is **not** per-item; it's a **watermark (rising
baseline) plus a bounded set of exceptions**.

The recency/thread case is already mostly covered: threads are separate streams
(INV-62), each with its own pointer, and a stream's timeline is linear/append-only
(INV-61, never reorders), so cross-thread reading is N independent prefixes — the
genuine gaps are the two above. This will be picked up as a separate piece of work
(B), handed over later.

## To verify before implementing

- **Frontend feed query** — does the activity feed already hold the full unread
  set (subscribe-then-bootstrap), or only a page? The derive model needs the
  unread rows present to count; confirm the query shape and where the cap lands.
- **`activity:created` on the sync log** — confirm it replays on catch-up for the
  target user so the set converges offline (it is user-scoped).
- **`reaction:removed` payload** — confirm it carries enough (`messageId`,
  `actorId`, `emoji`) to drop the matching row client-side.
- **Display cap** — pick the `N+` threshold for the badge.
