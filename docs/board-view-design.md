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
  cross-stream layout. **Liveness and optimism ride the sync engine (IDB +
  `SocketEventGate`), NOT React-Query — see "Realtime / sync model" below.**
  Slice 1's React-Query `use-conversations` board hook is a deliberate stopgap
  (it refetch-on-opens and feels junky), scheduled for migration onto the rails.
- **INV-61 untouched:** the board is a separate projection; the contiguous
  timeline keeps its `sequence`/`broadcastSequence` order. Resurfacing is
  forbidden in the timeline and free in the board precisely because they're
  different projections.

## Realtime / sync model — the board must ride the sync engine, not React-Query (Kris's "it feels junky")

Dogfooding turned up the real risk to this whole idea: **it doesn't feel
instant.** Kris typed a direct reply in a stream, opened the board, and his
activity wasn't there — a refresh fixed it. For a surface meant to be a
co-equal _way to interact_ (not just a read-only digest), seconds-late is
disqualifying. The cause is two stacked problems, and the fix is to stop
treating the conversation as an async digest and put it on the same rails as the
timeline.

**Root cause: conversations live on a different data-plane than messages.**

- **Messages/timeline are instant** because they ride the sync engine:
  IDB tables (`events`, `pendingMessages`, `streams` in
  `apps/frontend/src/db/database.ts`) ← applied in `syncId` order by
  `SocketEventGate` / `SyncEngine` (`apps/frontend/src/sync/`), read reactively
  off IDB, and **optimistically** written on send as `pendingMessages` +
  `events` with `_status: "pending"`, swapped when the authoritative
  `message:created` socket event lands.
- **Conversations are NOT in IDB at all.** `use-conversations.ts` is pure
  React-Query (`useQuery`/`useInfiniteQuery`), refetch-on-open. So the board
  **cannot** be live or optimistic no matter how fast the backend is. This — not
  the AI — is the dominant cause of the junk.

**Second cause: the bump is async even when it needn't be.** Message creation is
fully synchronous (`messaging/event-service.ts`), but conversation assignment
and the `last_activity_at` bump the board orders on happen _after_ the LLM:
`message:created` → outbox → boundary-extraction worker → `extractor.extract()`
(≈0.5–3s) → Phase-3 txn calls `bumpActivityForIds`. Yet the bump itself is just
`UPDATE conversations SET last_activity_at = NOW()` — zero AI. It's slow only
because it's bundled into the worker. (Proof a synchronous assignment path is
viable: **scratchpads already assign in-transaction, no LLM**,
`boundary-extraction-service.ts:218`.)

### The reframe: explicit/implicit → **determinable / inferred** → sync / async

Kris's instinct ("explicit conversations sync, implicit async") is right; the
sharper axis is **"can we know the conversation from structure, without the
AI?"** Most of what _feels_ interactive already can:

| You send…                            | Conversation knowable w/o AI?     | Treatment                                  |
| ------------------------------------ | --------------------------------- | ------------------------------------------ |
| An **authored post**                 | Yes — you declared it             | **sync**: create + bump in the message txn |
| A **reply inside a thread**          | Yes — the thread's conversation   | **sync**: bump in txn                      |
| A **quote-reply** to a message       | Yes — that message's conversation | **sync**: bump in txn                      |
| A **scratchpad** message             | Yes — the single conversation     | **sync** (already is)                      |
| **Free-form** new line, busy channel | No — AI must cluster              | **async**: worker — fine, it's ambient     |

Today threads and quote-replies _compute_ the structural signal
(`parentMessageConversations`, `quotedConversations`) but feed it to the LLM as a
mere candidate instead of taking it as a shortcut
(`boundary-extraction-service.ts:100-122`). Kris's exact junky case — a direct
reply — is structurally determinable, so it never needed to be async.

### The plan

**Backend:**

- **Synchronous deterministic bump (C).** For the determinable rows above, write
  the assignment + `last_activity_at = NOW()` in the **same transaction** as the
  message (`messaging/event-service.ts`), and emit `conversation:bumped`
  synchronously (event-source + projection together, INV-7). The LLM worker still
  runs after to refine/split/merge — but the field the board sorts on is already
  correct. Sync-bumping the structural parent is correct even if a later pass
  splits the topic: the parent thread genuinely did just get activity.
- **Deliver `conversation:*` to the workspace/user room (B).** Today
  `delivery-groups.ts` routes them to per-stream rooms only, so the workspace
  board never receives them. Add the workspace/user delivery group.

**Frontend — put conversations on the sync rails (the actual fix):**

1. Add a **`conversations` IDB store** (Dexie version bump in `db/database.ts`,
   alongside `events`/`streams`).
2. Board bootstrap **seeds IDB** (a one-shot fetch to fill the store is fine;
   what's wrong is treating that query as the live store), subscribe-then-fetch
   per INV-53.
3. Apply `conversation:*` through **`SocketEventGate`** into the IDB store, in
   `syncId` order, exactly like `message:created`.
4. Board **reads conversations reactively from IDB** (the project's IDB-observer
   pattern), so a card re-sorts the instant its row changes.
5. **Optimism = a local pending IDB write**, not a query mutation: on a
   determinable send, write the bumped `lastActivityAt` to the IDB conversation
   row locally and reconcile when the authoritative `conversation:bumped`
   arrives — the same `_status: "pending"` swap messages already use.

**Ambient AI clustering stays async (E)** — nobody drives those cards in real
time, so worker latency there is invisible.

Net: determinable send → sync backend bump → authoritative event over the socket
→ applied to IDB by the gate → board re-sorts live; and your own action shows
instantly via the optimistic IDB write before the round-trip returns. The same
mechanism that makes the timeline feel instant, now under the board.

### Open decision

Keep the **conversation as the single board card and make its bump synchronous**
(C — recommended; one primitive, no dual render path, INV-29/43-clean), _or_
**render interactive cards directly from thread/message data and treat the
conversation row as pure async enrichment** (more faithful to "the thread is the
synchronous backbone," but two card-fueling paths). Lean: C.

## Stable view + pending updates — the reactivity model (Kris's "don't move shit on me")

Status: design, 2026-06-27. **Supersedes the live re-sort behavior shipped in the
realtime slice (PR #1100).** That slice put conversations on the sync engine and
made the board re-sort live on activity. Dogfooding the consequence: a card you're
half-way through reading jumps out of view the moment it (or anything above it)
gets activity. For a surface whose whole job is "get an overview," motion-under-
the-eye is the wrong default. The fix is the X / Slack / iMessage pattern: **hold
the view you're looking at perfectly still, accumulate changes out of band, and
reveal them on demand.** This is the same instinct as INV-61 (off-screen content
must never shift on-screen content), extended from the timeline's _insertion_ rule
to the board's _ordering_.

### One truth, two orderings

- **Authoritative order** — the `conversations` IDB store, always live and
  activity-sorted. Unchanged; the sync engine keeps it true.
- **Committed view** — a _snapshot_ of order the viewer is currently looking at,
  deliberately frozen. Render walks the committed order; each card still reads its
  _content_ reactively from IDB (a reply body can fill in place), but its
  _position_ never moves while committed.

Live changes accumulate against the committed view as a **buffer**, surfaced as an
X-style "N new" pill at the top. The pill — or scrolling to the top, or a remount
(navigate away/back) — is the only thing that commits a fresh snapshot.

This **removes the optimistic bump-to-top** the realtime slice added
(`optimisticBoardReply` raising `_lastActivityMs` for the rendered order). The IDB
bump stays as truth; the view layer simply doesn't reorder a committed card. Net,
optimism gets simpler: the viewer's own reply updates in place, it doesn't chase a
moving card.

### Behavior per update type

| Update                                      | Treatment                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A **seen card** gets activity (would bump)  | Stay put. Optional in-place "updated" dot so the change is legible without motion.       |
| A **brand-new conversation**                | Buffer → pill count. On commit it lands at top with a **New** marker.                    |
| Reorder/insert **fully above** the viewport | Allowed _iff_ scroll-compensated — reordering off-screen rows nets zero on-screen shift. |
| The **viewer's own reply**                  | Updates in place; **no** bump-to-top (IDB bumps as truth; committed order ignores it).   |

### The scroll-anchor rule

Formalize INV-61 for the board: **the topmost visible card keeps its exact screen
offset across any mutation.** Measure the above-anchor height delta in a layout
effect and add it to `scrollTop`.

- The timeline gets its version of this from the **`virtua` virtualizer's `shift`
  prop on prepend** (`use-timeline-scroll.ts`), in a bottom-pinned chat model. The
  board is a top-anchored, non-virtualized feed, so it can't reuse that directly:
  either build a board anchor, or adopt `virtua` for the board and lean on `shift`
  (likely where it lands at scale anyway).
- **The hard part is async reflow:** avatars / link previews / images _above_ the
  viewport loading after the initial compensation and growing the region again. You
  must re-anchor on those, not only on the data mutation. This is the timeline's
  recurring cold-load pain (#1085/#1088/#1096); the board will hit the same.

### Edge cases (agreed open items)

1. **Pagination vs. frozen order — the sharp one.** Keyset paging by
   `(last_activity_at, id)` is incompatible with a frozen view: a bumped card moves
   its own cursor boundary, so "load older" can re-return or skip rows. A committed
   view needs a **stable paging key** (snapshot position, or `created_at`) with
   activity affecting only the buffer.
2. **Deletions / lost-access / resolved-and-removed.** A _visible_ seen card that
   disappears is the worst case for a stable list (removal shifts everything below).
   Tombstone in place until commit, or remove with anchor compensation. Above-
   viewport removals are absorbed by the anchor.
3. **Count semantics.** Pill = new conversations. Seen-card activity = in-place dot,
   not the pill (else "12 new" when nothing is actually new to look at). Decide
   whether a seen card bumping past the current top counts as "new."
4. **Reconnect re-seed.** The reconnect bootstrap updates IDB (truth) but must NOT
   mutate the committed view — it only grows the buffer/pill. Big post-disconnect
   counts are expected.
5. **At-the-top behavior.** When already scrolled to top, buffer + pill anyway (match
   X) and let a click scroll+commit, rather than auto-flowing items in.
6. **Definition of "seen."** v1 = the whole committed snapshot is frozen (matches X).
   Intersection-observer "only what scrolled past" is more faithful but much harder;
   defer.
7. **Virtualization.** At scale the board virtualizes; the anchor math and stable
   order must be designed with the virtualizer (`virtua` `shift`), not retrofitted.

### Foundation reuse

None of the realtime slice is wasted: the IDB store + sync-engine delivery +
visibility routing is exactly the data plane this sits on. What changes is the
**projection layer** (insert the committed-view/buffer between IDB and render) and
**dropping the optimistic bump-to-top**. It is a clean follow-up, not a rework, and
it partly subsumes the "reply bodies on the next seed" gap — a frozen view isn't
chasing a moving card, so body lag matters less.

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

With these, the design is settled. Step **(0)** — measure the floor — is now
done (below); what remains is **(1b)** build the authored board.

## Floor measurement — real prod data (2026-06-22)

Read-only pull (`cc_readonly`) over the live `conversations` table to size how
much the _derived_ path can carry. Scale: **625 conversations / 2 workspaces /
210 streams / 390 memos.**

**Verdict: derived is more mature than feared on the things that gate a board —
titles exist, clustering is real, the lifecycle runs. The actual gaps are title
_quality_ and scratchpad generic titles — both prompt/fallback fixes, not
architecture.**

- **Titles present, 0% null.** The "wall of Untitled" risk is empirically ~zero.
  But quality drifts: ~33% of titles run >8 words and lead with "Discussion
  about …" framing (the `topicSummary` spec says 2–5 words, _no_ framing — it's
  being ignored); casual one-line messages yield fragment-titles (the message
  text itself). Only ~23% land in the 3–5-word sweet spot. → cheap pre-work win:
  tighten the topic-summary prompt; it isn't following its own spec.
- **Clustering is substantial.** 60% of conversations hold 4–20 messages; 17%
  singletons, 3% empty shells. Not noise.
- **Lifecycle works.** 70% active / 25% resolved / 5% stalled — resolution
  actually happens (feeds the Needs-resolution lens and the resolved state).
- **Scratchpads = exactly 1 conversation each** (105 scratchpads, 1 convo each)
  — confirms the decision precisely. But each is titled "Scratchpad" (the stream
  name), so the board's scratchpad slice would be 105 identical cards. → refine
  decision #1: apply the first-message-excerpt fallback to the generic
  "Scratchpad" title too, not just to null.
- **Heavy concentration.** 454 of 485 DM conversations live in a single DM (an
  AI-persona DM). A workspace board with no scope filter would be flooded by one
  stream → the scope/lens filter is load-bearing, not optional.
- **Memo coverage 11%** (69/625) — modest but real fuel for the Decisions lens.
- **Realistic Active board ≈ 430 cards** (331 with ≥1 reply) — browsable; not
  empty, not absurd.

Net: green-light leaning on derived for channels/DMs; extend the title fallback
to generic scratchpad names; and a quick topic-summary prompt-tightening pass is
the highest-leverage pre-work before (or alongside) 1b.

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
