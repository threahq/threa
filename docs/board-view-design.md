# Exploration: The Board — a second way to interact with a stream

Status: exploration / design, v3. Sibling to
[`nonlinear-stream-views-exploration.md`](./nonlinear-stream-views-exploration.md),
which argues a stream is a container and the timeline is one projection. This
doc designs the **board** as a co-equal interaction mode and as the home for
"find what matters." No code yet.

> **v3 (after Kris's "turn it on its head"):** the board's "post" is a
> **conversation**, but conversations are now seeded **two ways** — _authored_
> (posting from the board declares a new topic; no AI needed) and _derived_ (AI
> clustering, as before). Authored-first makes the board good from day one and
> retires the maturity caveats. Headline surface stays a **workspace-wide board
> as your entrypoint**, per-stream a scoped filter. v1's thread-as-post framing
> is the de-risking appendix.

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
   of "Untitled" is bad. **Decided:** fall back to a stripped **excerpt of the
   first message** (INV-60) when the title is null.
3. **Scratchpads = one conversation.** The scratchpad path skips AI segmentation
   and keeps a single conversation per scratchpad
   (`boundary-extraction-service.ts:218-233`). **Decided:** accept it — a
   scratchpad shows as one board card; we do _not_ build per-scratchpad topic
   segmentation. (Want several scratchpad cards? Author them — each authored post
   seeds its own conversation.)
4. **Extraction latency.** A brand-new message becomes a conversation card
   asynchronously (outbox → worker → LLM). A just-posted topic appears after a
   short delay, not instantly.

## Turning it on its head: authored posts seed conversations (Kris's inversion)

The biggest unlock in this thread. Instead of conversations being _only_
derived (AI clusters timeline messages → board reads them), let **posting from
the board start a conversation**. The post is the human-declared boundary: "this
is a new topic." Its replies live in its thread; that thread _is_ the
conversation.

This unifies the two origins into one card type:

- **Authored** — you click "New post", write it (and optionally title it). That
  creates a conversation seeded with the post; replies attach to its thread. The
  boundary is **declared, not inferred** — no AI required.
- **Derived** — organic timeline messages still get auto-clustered as today.
  Quality-dependent, but no longer load-bearing: it's the "we also catch what
  you didn't explicitly post" bonus on top.

**Why this is the right move: it retires the three caveats** — for authored
posts, _the AI doesn't have to be great._
| Caveat (derived-only) | Authored post |
| --- | --- |
| Null titles | You write the title (or its first line is the title). Never "Untitled". |
| Mutable / merges under you | An authored post is a stable artifact; nothing re-clusters it. |
| Scratchpads = one conversation | You post discrete topics to the scratchpad board → many posts, no AI segmentation needed. The solo-first gap dissolves. |

It also reconciles the two instincts that were in tension: Theo's "**write a
post**" (deliberate authoring, nested comments, resurfaces on reply) _and_
Threa's "automatic organization that surfaces what matters" (derived
conversations) — same board, both feed it. And every authored post is clean,
human-labeled data, which makes the forcing-function loop below even stronger.

**What it costs (the honest mechanics):**

- A board post = create a message + open its thread (both exist) + **materialize
  a conversation row** seeded with that message and `topicSummary = the title`.
  Conversation creation exists only inside the extraction worker today
  (`boundary-extraction-service.ts`), so this needs a direct
  "create-conversation-from-message" service path + endpoint (modest).
- The boundary-extraction worker must **not re-cluster an authored message** —
  it needs to respect an explicit/locked assignment (a flag on the message or
  conversation, or "skip messages with a human-declared boundary"). Small
  addition, but real, and it's the load-bearing correctness bit (INV-20-style:
  the human assignment wins over the async AI pass).
- For authored posts where the thread is the conversation, the
  thread↔conversation relationship is 1:1; derived conversations stay
  many-messages-in-a-stream. The card renders the same either way.

This is a strong enough reframe that **authored posting becomes the robust core
of the board, and derived conversations ride alongside** — flipping the risk
profile (see Phasing/Sequencing below).

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
**Decided:** of the personal lenses, **Mine** ships first; Saved comes later.

## Default posture per stream type — the Q4 you asked me to explain

Q4 was: _when you open something, which mode do you land in by default?_ Given
Q3, it mostly resolves:

- **Workspace entrypoint → board.** Landing on "what matters across everything"
  beats landing in one chronological room.
- **An individual stream → timeline by default, board a toggle.** Inside one
  channel/DM you usually want the live conversation; the board is there when you
  want to triage. Revisit per-type later (a high-traffic channel or a
  knowledge-base stream might prefer board-default).
- **Scratchpads → timeline default; one card on the board** (one conversation
  per scratchpad, by decision). Author extra posts to a scratchpad for more
  cards; no AI segmentation planned.

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

The inversion changes the order. Two candidate entry points:

- **0. Measure the floor (read-only, no build).** Pull a real sample of derived
  conversations (read-only prod DB) → null-title rate, cluster sizes, status
  distribution. Answers "how immature is it _today_" with a number, and tells us
  how much the board would lean on authored vs derived. Cheap, do first.
- **1a. Read-only derived board.** `findByWorkspace` → access-filtered endpoint
  → page reusing `conversation-item`/`conversation-list`, Active lens, live via
  existing sockets. Cheapest code, but quality rides on the AI; doubles as a
  visual version of step 0.
- **1b. Authored board (the robust core).** "New post" → create message + thread
  - materialized conversation (titled) + extractor-skip-authored. More code, but
    **deterministic and good from day one**, and it's the thing that makes the
    board independent of AI quality. This is the real product.

Recommended path: **0 → 1b**, letting derived conversations (1a's read) flow in
alongside as enrichment. Then:

2. **Lenses + scope.** Structural lenses first (Active / Needs-resolution /
   Decisions — all from existing signals), then scope filter (per channel / DMs
   / label), then the **Mine** personal lens (Saved later — needs a per-viewer
   join).
3. **Full act-from-the-board + corrections.** Reply in place, mark resolved,
   save/pin, plus the maturity corrections (retitle / merge / split) that feed
   the eval loop. Reuses existing compose + reassign + saved paths.
   Per-scratchpad topic segmentation is **not planned** (scratchpad = one
   conversation, by decision).

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

The inversion above softens this a lot: an **authored**-first board is clean
from day one, so the staging below really applies to how much weight we put on
the **derived** cards. If we lead with derived-only, the risk stands — a wall of
"Untitled" / mis-clustered cards feels broken — so promote in reversible stages:

1. **Secondary surface** — board ships as a nav item you open deliberately, not
   the landing page. Dogfood it; use the corrections; watch quality climb.
2. **Quality bar** — define a floor from real data (null-title rate, correction
   rate, % conversations carrying a memo) before promoting.
3. **Promote to entrypoint** once the floor is cleared.

Keeps the forcing-function benefit without betting the front door on an immature
primitive. Worth a zeroth step: **measure the current floor** — sample real
conversations (read-only) for title quality, null rate, cluster size, and status
distribution, so "is it mature enough?" gets a number instead of a guess.

## Decisions (resolved 2026-06-22)

1. **Null-title fallback** → a stripped **excerpt of the first message** (not
   "Untitled"; no hiding, no extra generation pass).
2. **Scratchpad gap** → **accept one conversation per scratchpad**; no
   segmentation work. Multiple scratchpad cards come from authored posts.
3. **First personal lens** → **Mine** (Saved later). Structural set confirmed:
   Active / Needs-resolution / Decisions.
4. **Mutability UX** → **skip** surfacing "merged/retitled" notices for now
   (such notes get ignored anyway).

With these, the design is settled. What remains is execution: **(0)** measure
the derived-conversation floor (read-only), then **(1b)** build the authored
board.

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
