# Exploration: The Board — a second way to interact with a stream

Status: exploration / design, v2. Sibling to
[`nonlinear-stream-views-exploration.md`](./nonlinear-stream-views-exploration.md),
which argues a stream is a container and the timeline is one projection. This
doc designs the **board** as a co-equal interaction mode and as the home for
"find what matters." No code yet.

> **v2 pivot (after Kris's input + a code audit of the conversations
> primitive):** the board's "post" is a **conversation** (Threa's AI-derived
> topic cluster), not a thread; and the headline surface is a **workspace-wide
> board as your entrypoint**, with per-stream as a scoped filter of the same
> thing. v1's thread-as-post framing is preserved at the bottom as a fallback.

## The thesis

The timeline answers _"what is being said, in order."_ The board answers
_"what matters, right now."_ Same content, same access boundary (INV-62), two
postures:

- **Timeline** — chronological, contiguous (INV-61), append-only. The room.
- **Board** — topics as durable, resurfacing cards ordered by what matters, not
  by when they were typed. The pinboard on the wall.

Neither is "the real one." Linear does this with list vs. board; GitHub with
the issues list vs. a project board — one dataset, two views.

## The post = a conversation (verified viable)

In Threa a reply creates a **thread** (a child stream off a message), so the
obvious "post" is a thread. But Threa already derives a richer unit: a
**conversation** — an AI-clustered topic _within_ a stream
(`boundary-extraction-service.ts`). Kris's instinct was to use that as the post,
and a code audit says it holds up:

| Need a post must meet    | Conversation today                                                                                                            | Cite                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Stable identity          | `conv_` ULID, persists across reassign/merge/split; emptied → `resolved` shell (undo target), never deleted                   | `repository.ts:470-494`                          |
| A title to render        | `topicSummary` — a 2–5 word, language-aware topic name (nullable → "Untitled")                                                | `boundary-extraction/config.ts:77-83`            |
| An entrypoint message    | `messageIds[0]` (first _assigned_; ~chronological)                                                                            | `domain.ts:602`                                  |
| Resurface on activity    | `lastActivityAt`, bumped on every touch; already the `ORDER BY` of list queries                                               | `repository.ts:497-504`                          |
| Built-in "matters" state | `status` active/stalled/resolved · `completenessScore` 1–7 · read-time `temporalStaleness`/`effectiveCompleteness`            | `constants.ts:308-315`, `staleness.ts`           |
| Works beyond channels    | runs on channels, **DMs**, threads, **scratchpads** — all non-E2E streams, user messages only                                 | `boundary-extraction-outbox-handler.ts:23-53`    |
| Card UI already built    | `conversation-item.tsx` (StatusBadge, 7-seg completeness), `conversation-list.tsx` (sectioned by status), live socket updates | `use-conversations.ts`                           |
| Knowledge link           | memos carry `source_conversation_id`; "decisions captured here" is one join                                                   | `memos` migration `:16`, `repository.ts:325-341` |

**Why this beats thread-as-post.** Conversations _subsume_ threads (a
conversation spans a root message and its thread replies via
`findByStreamIncludingThreads`), they exist in DMs and scratchpads where threads
may not, they're **authored automatically** (no one has to remember to start a
thread), and they ship with the exact state machine "find what matters" wants.
It's also more Threa than Facebook: posts are _discovered_, not manually posted —
which is the whole "automatic organization that surfaces what matters" ethos
(`design-system.md:824`).

**Honest caveats (decisions, not blockers):**

1. **Mutable posts.** A conversation can be retitled, merged, or split by the
   next extraction pass. A card you saw yesterday may have absorbed another or
   changed its name. Fine for a living "what matters" wall; worth a light "this
   updates itself" mental model, not a fixed-artifact one.
2. **Null titles.** `topicSummary` can be null → "Untitled conversation". A wall
   of "Untitled" is bad. Mitigation: fall back to the entrypoint message's
   stripped first line (INV-60) when title is null.
3. **Scratchpads degenerate to one post.** The scratchpad path skips AI
   segmentation and keeps a single conversation per scratchpad
   (`boundary-extraction-service.ts:218-233`). So a scratchpad board = one card,
   not a topic board. For a solo-first product this is the biggest gap — either
   scope the board to channels/DMs first, or later enable topic segmentation for
   scratchpads (a backend change).
4. **Extraction latency.** A brand-new message becomes a conversation card
   asynchronously (outbox → worker → LLM). A just-posted topic appears after a
   short delay, not instantly.

## The workspace board as your entrypoint (Q3)

Kris: _"a workspace-wide board could be your entrypoint, where a filter/lens
could be per-stream/channel."_ Agreed — make that the headline, not an add-on:

- **Primary surface:** a workspace-wide board — a cross-stream wall of
  conversation cards, ordered by `lastActivityAt`, with a **lens** selector and
  a **scope** filter (all / one channel / DMs / a label).
- **Per-stream board:** the same view scoped to one stream — a special case, not
  a separate feature.
- This is the activity feed's serious sibling: activity is a flat event log
  ("who pinged me"); the board is the _topic_ log ("what threads of work are
  alive"). It's a landing surface you _act_ from, not just read.

**The one real build for this:** a workspace-wide conversation list endpoint.
`ConversationRepository.findByWorkspace` already exists
(`repository.ts:270-294`) but is **not wired to any route** — current routes are
strictly stream-scoped (`routes.ts:484-490`). So the spine query exists; it
needs an HTTP endpoint plus access filtering via `listAccessibleStreamIds`
(INV-62), never a raw `stream_members` filter.

## Lenses — what I meant, and your "matters is personal" point (Q2)

A **lens** is a saved filter+sort over the board, each backed by a signal Threa
_already_ computes — so the board doesn't decide what matters, it gives you the
dials. Your point that "what matters is a question for the person" is exactly
right, so split the dials in two:

**Structural lenses (same signal for everyone):**

- **Active** (default) — `lastActivityAt` desc. The resurfacing wall.
- **Needs resolution** — `status = stalled`, or high `temporalStaleness` with
  low `completenessScore`. Loose ends, things hanging.
- **Decisions / Knowledge** — conversations with a captured memo
  (`source_conversation_id`, `knowledgeType` decision/fact). What got settled.

**Personal lenses (per-viewer — "matters to _you_"):**

- **Mine / For you** — conversations you authored, participate in
  (`participantIds`), are @-mentioned in, or have a quiet-collector to-do
  assigned in (`saved-suggestions`).
- **Saved** — conversations you explicitly saved/pinned.

Curation, then, is mostly _picking the lens_ — plus explicit save/pin for the
manual override. And like the quiet collector learns from dismissals, the
personal lens can get smarter over time (later). The structural lenses are free
today; personal lenses need a per-viewer join (mentions/saved/participation).

## Default posture per stream type — the Q4 you asked me to explain

Q4 was: _when you open something, which mode do you land in by default?_ Given
Q3, it mostly resolves:

- **Workspace entrypoint → board.** Landing on "what matters across everything"
  beats landing in one chronological room.
- **An individual stream → timeline by default, board a toggle.** Inside one
  channel/DM you usually want the live conversation; the board is there when you
  want to triage. Revisit per-type later (a high-traffic channel or a
  knowledge-base stream might prefer board-default).
- **Scratchpads → timeline only for now** (the one-conversation limitation
  above) until per-scratchpad topic segmentation exists.

## Architecture sketch (reuse-first)

- **Routes (INV-59):** workspace board at a real segment, e.g. `/w/:ws/board`
  (sibling to `/activity`, `/memory`); per-stream at `s/:streamId/board`. Toggle
  via `<Link>`/`navigate()` (INV-40); view from `useParams()`.
- **Backend:** wire `findByWorkspace` behind `GET /workspaces/:ws/board`
  (handler thin INV-34, Zod query INV-55, `BoardService` owns the read INV-6),
  access-filtered by `listAccessibleStreamIds` (INV-62). `lens`/`scope`/`cursor`
  as query params. Per-stream reuses the existing `listByStream`.
- **Frontend:** the card (`conversation-item`) and list (`conversation-list`)
  components already exist; the board is a new page that reuses them in a
  cross-stream layout. Bootstrap activity-feed style (`use-activity.ts`:
  `staleTime: Infinity`, `refetchOnMount`), stay live via the existing
  `conversation:created/updated` socket events already handled in
  `use-conversations.ts` (INV-53).
- **INV-61 untouched:** the board is a separate projection; the contiguous
  timeline keeps its `sequence`/`broadcastSequence` order. Resurfacing is
  forbidden in the timeline and free in the board precisely because they're
  different projections.

## Phasing

1. **Read-only workspace board (MVP).** `findByWorkspace` → endpoint
   (access-filtered) → a page rendering conversation cards by `lastActivityAt`,
   live via existing socket events. Default **Active** lens, **scope = all**.
   Proves the entrypoint thesis with no write-path or INV-61 risk; titles fall
   back to entrypoint first-line when null.
2. **Lenses + scope.** Structural lenses first (Active / Needs-resolution /
   Decisions — all from existing signals), then scope filter (per channel / DMs
   / label), then personal lenses (Mine / Saved — need per-viewer joins).
3. **Act from the board.** Open a conversation in place, reply to its
   entrypoint, mark resolved, save/pin — so the board is somewhere you _work_,
   not just scan. Reuses existing compose + reassign + saved paths.
   (Later/maybe: per-scratchpad topic segmentation so scratchpad boards work.)

## The board as the forcing function for conversation maturity (Kris's reframe)

Kris isn't sure conversations are mature enough yet — and that's exactly the
point. Today conversations live in an _optional_ overlay
(`convOverlay`/`convView`), so their quality is never under pressure; nobody is
forced to confront a bad title or a mis-merge. Make conversations your
**entrypoint** and their quality suddenly _matters_, every day, to the person
most able to fix it. The board is the accountability surface that drags the
primitive to maturity. The order of causation flips: **we don't wait for
conversations to be good before building the board; the board is how they become
good.**

The feedback loop is already half-built:

- The overlay already has a per-message **reassign** correction ("this message
  belongs to…", desktop dropdown + mobile picker) — human-in-the-loop
  relabeling exists today (`conversation-overlay`).
- The board adds higher-altitude corrections — **retitle**, **merge**,
  **split**, **mark resolved** — all already expressible as reassignments +
  status writes, no new primitive.
- Every correction is a **labeled example**: the board turns daily use into an
  eval set for the boundary-extraction and topic-summary prompts (INV-44/45 —
  evals call production entry points). Like the quiet collector learning from
  dismissals, conversations improve the more the board is used.

### Sequencing to de-risk (the one caution)

If conversations are currently rough, making them the _default_ entrypoint on
day one risks a wall of "Untitled" / mis-clustered cards — the product feeling
broken. So promote in reversible stages:

1. **Secondary surface** — board ships as a nav item you open deliberately, not
   the landing page. Dogfood it; use the corrections; watch quality climb.
2. **Quality bar** — define a floor from real data (null-title rate, correction
   rate, % conversations carrying a memo) before promoting.
3. **Promote to entrypoint** once the floor is cleared.

Keeps the forcing-function benefit without betting the front door on an immature
primitive. Worth a zeroth step: **measure the current floor** — sample real
conversations (read-only) for title quality, null rate, cluster size, and status
distribution, so "is it mature enough?" gets a number instead of a guess.

## Open decisions remaining

1. **Null-title fallback** — entrypoint first-line (my lean) vs. hide untitled
   vs. force a title-generation pass?
2. **Scratchpad gap** — ship board for channels/DMs first and treat scratchpad
   segmentation as later work, or invest in segmentation up front (it's the
   solo-first surface)?
3. **Lens priority** — confirm the structural set (Active / Needs-resolution /
   Decisions) for phase 2; which personal lens matters most (Mine vs. Saved)?
4. **Mutability UX** — how loud should "this card merged/retitled" be, if at all?

---

## Appendix: v1 fallback — thread-as-post

If conversations prove too mutable or too dependent on extraction quality, the
board can fall back to **threads as posts**: top-level messages with
`replyCount > 0`, ordered by `threadSummary.lastReplyAt`
(`streams/repository.ts:992-1066`), rendered with the existing `ThreadCard`,
re-sorting on the existing `message:updated` event
(`messaging/event-service.ts:355-377`). Cheaper and fully deterministic, but
loses DMs/scratchpads coverage, the built-in status/completeness state, and the
"discovered, not authored" quality. Forks considered: (A) every top-level
message — too noisy; (B) thread-bearing only; (C) hybrid + saved/memo'd. Kept
here as the de-risking option, not the primary plan.
