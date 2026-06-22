# Exploration: The Board — a second way to interact with a stream

Status: exploration / design. Sibling to
[`nonlinear-stream-views-exploration.md`](./nonlinear-stream-views-exploration.md),
which argues a stream is a container and the timeline is one projection. This
doc takes the **board** projection seriously as a co-equal interaction mode and
as the in-stream home for "find what matters." No code yet.

## The thesis

The timeline answers _"what is being said, in order."_ The board answers
_"what matters in here, right now."_ Same stream, same access boundary
(INV-62), two ways to interact:

- **Timeline** — chronological, contiguous (INV-61), append-only feel. The room.
- **Board** — posts as durable, resurfacing units ordered by what matters, not
  by when they were typed. The pinboard / forum on the wall of that room.

Both are first-class. A user toggles between them per stream; neither is "the
real one." This is the same move Linear makes with list vs. board, or GitHub
with the issues list vs. a project board — one dataset, two postures.

## Why the board is where "find what matters" grows up

Threa already _has_ a "find what matters" layer, but it lives **above** the
stream — cross-workspace and ambient:

- Sidebar **Important** section + urgency strip — "automatic organization that
  surfaces what matters" (`docs/design-system.md:824`, `:753-799`).
- The **quiet collector** — tier-2 GAM extraction lands per-assignee to-do
  suggestions in the `/saved` _Suggested_ tab; pull-only, no badge
  (`saved-suggestions/service.ts:39-45`, `config.ts:81-104`).
- **Memory explorer** — surfaces extracted memos across streams (`/memory`).

What's missing is the **mid-altitude** surface: _"within this stream, what
matters?"_ The timeline can't answer that — it's strictly chronological, so the
important decision from Tuesday is buried under today's chatter. The board is
exactly that altitude. It can rank and group a single stream's content by
signals Threa already computes, turning "find what matters" from an
ambient/global feature into something you can _stand inside a stream and do_.

The signals already exist (nothing new on the write path):

| Signal             | Source (existing)                                                                                   | Board use                        |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| Last activity      | `threadSummary.lastReplyAt` (`domain.ts:413-429`)                                                   | resurface old posts on new reply |
| Heat               | `replyCount`, `participants[≤3]` (`streams/repository.ts:992-1066`)                                 | rank busy posts                  |
| Topic state        | conversations `status` ACTIVE/STALLED/RESOLVED, `completenessScore` (`conversations/repository.ts`) | "needs resolution" / "open" lens |
| Captured knowledge | GAM memos w/ `knowledgeType` decision/fact (`memory`)                                               | "decisions" lens, post badges    |
| Explicit intent    | saved items + quiet-collector suggestions (`saved-suggestions`)                                     | "action items" lens              |

So the board's default ordering is **last activity** (Theo's "old post comes
back to the top"), but its _reason for existing_ is that it's the one surface
where those five signals can compose into lenses: **Active · Unanswered ·
Decisions · Needs resolution · Mine**.

## The one real design fork: what is a "post"?

In Threa a reply creates a **thread** = a child stream hanging off a _message_
(`parentStreamId` = the stream, `parentMessageId` = the message it replies to,
`rootStreamId` = the root). A timeline message with `replyCount > 0` already
renders as a `ThreadCard` (`timeline/thread-card.tsx:11-50`). So a "post" is
naturally **a top-level message + its thread**. The fork is which top-level
messages count:

- **A) Every top-level message is a post.** Truest Facebook analog; board =
  the timeline re-sorted by activity. Downside: every "lol" is a post; the board
  is noisy and stops being a "what matters" surface.
- **B) Only messages that have attracted a thread (`replyCount > 0`) are
  posts.** Board = the subset that became conversations. Naturally a "what
  matters" filter — things people engaged with. Downside: a brand-new important
  post with no replies yet is invisible until someone replies.
- **C) Hybrid (recommended): a post is a top-level message that is _either_
  thread-bearing, saved, or carries a captured memo / is an open question.** The
  board is "what matters," sourced from engagement _and_ Threa's own signals.
  Start from B's query, union in saved/memo'd/flagged messages.

Recommendation: ship **B** as the MVP (cheapest — it's exactly
`findThreadSummaries` ordered differently), evolve to **C** as the "find what
matters" lenses land. Avoid A; a re-sorted firehose isn't a new mode.

Note this reuses existing primitives — no new "post" entity (INV-36 / INV-49).
A post is a message; a thread is its comments; nesting is already unlimited.

## Architecture sketch (reuse-first)

### Route — a real segment, not a query param (INV-59)

Timeline stays `s/:streamId`; board is `s/:streamId/board`. Distinct segments
for a small fixed view set, per INV-59 ("URLs read naturally"). The toggle is a
`<Link>`/`navigate()` between segments (INV-40); the view hook reads
`useParams()` and defaults to timeline for the bare path. Today the stream page
is one lazy route (`routes/index.tsx:122-125`); add a `board` child.

### Data — one new ordered read, everything else exists

The summary type and per-thread aggregation already exist
(`streams/repository.ts:992-1066` `findThreadSummaries` → `Map<messageId,
ThreadSummary>`, participants capped at 3 in SQL). The board needs the same
shape but **ordered by `lastReplyAt` across the whole stream with pagination**,
not keyed by a caller-supplied message-id set:

```
StreamRepository.listPosts(db, { rootStreamId, orderBy: 'lastReplyAt', limit, cursor, lens? })
  -> { posts: Array<{ message, threadSummary }>, nextCursor }
```

A repository read (INV-5), called by a `BoardService` (INV-6), behind a thin
handler `GET /streams/:streamId/board` (INV-34, Zod-validated query INV-55).
Access is enforced with the canonical `checkStreamAccess` /
`listAccessibleStreamIds` on the root (INV-62) — never a raw `stream_members`
filter.

### Live updates — reuse the stream's sync, don't bootstrap twice

When you're in a stream the timeline is already bootstrapped and the socket room
joined (subscribe-then-bootstrap, INV-53; events land in IDB via the
`SocketEventGate`). Two layers:

1. **Posts already on screen stay live for free** — a new reply emits
   `message:updated { updateType: "reply_count", threadSummary }`
   (`messaging/event-service.ts:355-377`); the board re-sorts on it instead of
   leaving the card pinned. That single event _is_ the resurface signal.
2. **The full ordered list** (incl. old posts outside the loaded timeline
   window) comes from the board endpoint, bootstrapped activity-feed style
   (`use-activity.ts`: `staleTime: Infinity`, `refetchOnMount`, invalidate on
   socket event). The board query is invalidated on `message:created` /
   `message:updated` for the room, same pattern as the activity feed.

This keeps INV-61 untouched: the board is a separate projection; the contiguous
timeline window keeps its `sequence`/`broadcastSequence` ordering. Resurfacing
is forbidden in the timeline and free in the board precisely because they're
different projections (the central claim of the sibling doc).

### Component — `ThreadCard` is already the post card

`ThreadCard` renders participants, reply count, latest-reply preview (stripped
via `truncateContent`, INV-60), and relative time
(`timeline/thread-card.tsx`). A `PostCard` is a thin wrapper: same body, plus
the post's own author/first line as a title and (phase 2) lens badges
(decision / unanswered / action). It returns null at `replyCount: 0` today, so
moving to hybrid (C) means lifting that guard for saved/memo'd posts.

## Phasing

1. **Read-only recency board (MVP).** Fork B. `s/:streamId/board` lists
   thread-bearing posts by `lastReplyAt`, re-sorting live on `message:updated`.
   Proves the "container + projection" thesis and Theo's resurface behavior with
   zero write-path or INV-61 risk. ~one repo read + one handler + one page,
   reusing `ThreadCard` and the activity-feed bootstrap pattern.
2. **"Find what matters" lenses.** Add Active / Unanswered / Decisions / Needs
   resolution / Mine, each a `lens` param mapping to existing signals
   (conversations `status`, memos `knowledgeType`, saved, mentions). This is the
   payoff — the board becomes the per-stream "what matters" surface.
3. **Post-first composition.** A "New post" affordance that starts a top-level
   message _intended_ as a post (and optionally opens its thread immediately),
   so the board is somewhere you _act_, not just read. Reuses the existing
   compose + thread-create paths.

## Open decisions (yours)

1. **Post primitive** — B (thread-bearing only) for MVP, evolving to C
   (+ saved/memo'd/flagged)? Or do you want A (every message) for a purer
   Facebook feel? _Lean: B → C._
2. **Lens set** — which of Active / Unanswered / Decisions / Needs-resolution /
   Mine matter most for "find what matters"? Drives phase 2 scope.
3. **Scope** — per-stream board only, or also a **workspace-wide board** (a
   cross-stream "wall" of what matters everywhere — the activity feed's serious
   sibling)? Per-stream first is the safe start.
4. **Default posture per stream type** — channels default to board, scratchpads
   to timeline, DMs to timeline? (Solo-first: scratchpad board could be a strong
   personal "what matters" surface.)
