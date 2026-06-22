# Exploration: Streams as containers, the timeline as one projection

Status: exploration / not a plan. No code changes proposed yet.

## Where this came from

Theo's "I don't have time to build these things" video (the Slack rant near the
end) asks for **Facebook "workplaces"** — really the Facebook _post_ primitive:

- A post sits _between_ a channel and a thread.
- Top-level comments **plus arbitrarily nested** sub-comments — reply to two
  people under one comment without clogging the main thread.
- "Most importantly: when someone leaves a comment on an old post, that post
  gets brought to the top." Everywhere else, replying to an old thread leaves it
  buried.

The reflex is to read this as a missing feature. It mostly isn't — Threa
already has the hard parts:

- **Unlimited thread nesting** — threads are sub-streams
  (`parentStreamId`/`parentMessageId`, `rootStreamId`), graph structure
  (`docs/core-concepts.md:38-45`).
- **Reply-to-a-specific-message** — quote replies + per-message threads.
- **Activity bumping** — a new message bumps its root stream to the top of the
  sidebar (`sidebar/utils.ts:88-94`; `streams/repository.ts:587`
  `ORDER BY COALESCE(lm.created_at, s.created_at) DESC`).

The single behavior Threa does _not_ do is the "most important" one: inside a
stream, a **thread card is pinned to its parent message's chronological slot and
never resurfaces** when the thread gets a new reply
(`timeline/stream-content.tsx:557-566`; the timeline is strictly
`sequence`-ordered). The _data_ to resurface already exists —
`threadSummary.lastReplyAt` + `replyCount`, refreshed on every reply via a
`message:updated` outbox event (`messaging/event-service.ts:355-377`).

## The reframe

The interesting move is not "add post-resurfacing to the timeline." It is to
stop treating the chronological timeline as _what a stream is_.

> A stream is an **access-controlled organizational container**. The
> chronological timeline is one **projection** over the content it holds, not
> the content itself.

This is already true in the code, just not stated as a principle:

- Access is a property of the container, not the row. Visibility resolves
  through `root_stream_id` to the nearest non-thread ancestor; threads carry no
  access of their own (INV-62, `streams/access.ts`). So "where can this be
  viewed" is decided by the container, independent of how rows are ordered.
- `broadcastSequence` / contiguity (INV-61) is a property of **the timeline
  projection specifically** — it governs `TIMELINE_BROADCAST_EVENT_TYPES` rows
  in the dense per-stream window so a missing number is always a real gap. It is
  _not_ a constraint on the underlying data. A different projection of the same
  stream (sorted by last activity, grouped by topic, ranked by relevance) does
  not touch the timeline window and therefore does not fight INV-61. This is the
  key unlock: **"old post comes back to the top" is forbidden inside the
  contiguous timeline, but free in any other view.**

## Threa already ships a portfolio of non-linear projections

The same message graph is already projected several non-chronological ways. A
"Facebook board" view would be one more member of this family, not a new axis.

| Projection                                     | What it's a view _of_            | Ordering                               | Scope         | Authored by          |
| ---------------------------------------------- | -------------------------------- | -------------------------------------- | ------------- | -------------------- |
| **Timeline** (`s/:streamId`)                   | one stream's events              | `sequence` (chronological, contiguous) | single stream | users                |
| **Activity** (`/activity[:filter]`)            | mentions / messages / reactions  | recency `DESC`                         | cross-stream  | derived from events  |
| **Memory** (`/memory`)                         | extracted memos (GAM)            | semantic rank + metadata facets        | cross-stream  | AI extraction        |
| **Conversations**                              | topic clusters _within_ a stream | LLM boundary assignment + staleness    | within-stream | AI extraction        |
| **Search** (`/search`)                         | raw messages                     | relevance                              | cross-stream  | query                |
| **Saved / Scheduled** (`/saved`, `/scheduled`) | curated items                    | status / time                          | cross-stream  | explicit user action |

Citations: activity `pages/activity.tsx`, `activity/repository.ts:22-37`;
memory `pages/memory.tsx`, `api/memos.ts`; conversations
`conversations/repository.ts:34-49`, `boundary-extraction-service.ts`,
`staleness.ts`; search `pages/search.tsx`, `search/use-message-search.ts`;
routing `routes/index.tsx:68-136` (INV-59).

Two of these are especially relevant to the "post" idea:

- **Conversations** already cluster a stream's messages by _inferred topic_
  (not chronology), are **stateful** (`status` ACTIVE/STALLED/RESOLVED,
  `completenessScore`, `confidence`), and already track **`lastActivityAt`**,
  bumped on each new message (`bumpActivityForIds`). This is the closest thing
  Threa has to a "post that resurfaces on new activity" — but it has **no
  first-class view surface**; it lives in the extraction pipeline and feeds
  staleness opacity, not a board the user can browse.
- **Thread cards** already render a thread as a standalone post-like object —
  title-ish snippet, participant avatar stack (≤3), `replyCount`, `lastReplyAt`,
  an active-session pulse (`timeline/thread-card.tsx:11-100`). But there is **no
  "all threads / all posts" list surface**; the card only exists embedded at its
  parent message's slot in the timeline.

So the two pieces a "Facebook board" needs — a resurfacing, stateful grouping
(conversations) and a post-shaped card (thread cards) — both already exist and
are both currently _trapped_ inside other surfaces.

## The missing projection: a Board / Posts view of a stream

A per-stream view (new URL segment under `s/:streamId`, e.g. `.../board`, per
INV-59) that lists the stream's **top-level threads as posts**, ordered by
**last activity**, so an old post returns to the top when it gets a new reply.

What it reuses, with nothing new on the write path:

- `threadSummary.lastReplyAt`, `replyCount`, participants — already computed and
  pushed on every reply (`event-service.ts:355-377`).
- The thread-card shape — already the post object.
- `message:updated { updateType: "reply_count", threadSummary }` — already the
  resurface signal; a board re-sorts on it instead of leaving the card pinned.
- INV-61 untouched — the board is a separate projection; the contiguous
  timeline keeps its `sequence` order.

This is the smallest thing that delivers Theo's "most important" behavior
without the architectural fight, _and_ it generalizes: the same surface could
toggle ordering (recent activity / new posts / unanswered) or grouping (by
participant, by label, by the existing conversation topic).

## Wider design space (worth sitting with before committing)

If a stream is a container with multiple projections, the question stops being
"add a board" and becomes "what is the set of views, and how does the user
move between them?"

- **Board / Posts** — threads as resurfacing posts (above). The literal answer.
- **Topics** — surface the existing _conversations_ clustering as a browsable
  view: a stream as a set of living topics, each with status and staleness,
  resurfacing on activity. Arguably more "Threa-native" than a Facebook clone,
  since the clustering is automatic and doesn't depend on users manually
  starting threads.
- **Outline / map** — the nesting graph itself as a navigable structure
  (collapse/expand the tree), for streams used as a knowledge base rather than a
  chat.
- **View switcher as a first-class concept** — every stream exposes
  `timeline | board | topics | …` and remembers per-stream (or per-stream-type)
  default. Scratchpads might default to outline, channels to board, DMs to
  timeline.

Open questions:

- Is a "post" a **top-level thread**, or the existing **conversation cluster**,
  or a _new_ explicit primitive? (Strong lean: reuse, don't add a primitive —
  threads and conversations already cover it; INV-36 says don't invent.)
- Should resurfacing be **per-view only** (board re-sorts; timeline stays
  contiguous), which is the INV-61-safe answer — yes, almost certainly.
- Does the view belong **per-stream**, **cross-stream** (a workspace-wide "feed
  of active posts", more like the Facebook wall), or both?
- Where do **agents** read from? Theo's framing is that posts are a better
  primitive for agents too. A board/topics projection with stable post IDs +
  last-activity ordering is a cleaner agent surface than a raw timeline.

## Suggested next step

Not code yet. If this direction resonates, the cheapest high-signal step is a
**read-only `board` projection of a single stream** (top-level threads as posts,
ordered by `lastReplyAt`, re-sorting on the existing `message:updated` event) —
because it reuses existing data end-to-end, validates the "stream is a
container, view is a projection" thesis with zero write-path or INV-61 risk, and
makes the "old post resurfaces" behavior real enough to feel before deciding how
far to take the view system.
