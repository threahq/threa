# Exploration: The Board — a second way to interact with a stream

Status: design of record, v4 — the board is largely **shipped** (flag-gated
`board-view`); this doc tracks the settled model, resolved decisions, and the
active plan. Sibling to
[`nonlinear-stream-views-exploration.md`](./nonlinear-stream-views-exploration.md),
which argues a stream is a container and the timeline is one projection.

> **v3 (after Kris's "turn it on its head"):** the board's "post" is a
> **conversation**, but conversations are now seeded **two ways** — _authored_
> (posting from the board declares a new topic; no AI needed) and _derived_ (AI
> clustering, as before). Authored-first makes the board good from day one and
> retires the maturity caveats. Headline surface stays a **workspace-wide board
> as your entrypoint**, per-stream a scoped filter. v1's thread-as-post framing
> is the de-risking appendix.

> **v4 (2026-07-03, shipped-state pass):** the original Phasing is replaced by
> "Where we are + what's next"; the soft-thread open decisions are resolved by
> #1146 (filing is a hidden message field, **not** a content node — reversing
> the earlier lean); new sections: **Agents on the board** (traces visible in
> conversation surfaces, never bumping) and **Hide & mute** (per-viewer
> exclusions, two grains).

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

> **Reshaped 2026-07-05 (Kris's steer, superseding the first tab-strip cut):**
> lenses are **true filters, not pages**. The board's job is to _surface_ —
> so the default home is **All** (everything, newest activity first, nothing
> hidden), and a lens is an optional narrowing picked from a filter control
> (like the search page's stream-type filter), never a mode you must opt out
> of. The first cut rendered the lenses as header tabs with Active-as-default
> doubling as "everything"; dogfooding killed it — acting on a card changed
> its lens membership and _hid_ it (a reply made a Needs-resolution card
> fresh → gone), and the tab strip read as "the intended ways to use the
> board." Two rules came out of that: **filters never yank what's on screen**
> (a committed card that stops matching keeps rendering, content live, until
> the viewer commits a fresh view), and **your own action always surfaces**
> (posting from a filtered view returns to All and reveals the card).

**Structural lenses (same signal for everyone):**

> **Per-user home lens (shipped):** where the bare query-less `/board` entry
> redirects is the `boardDefaultLens` preference (or a pinned saved view via
> `boardDefaultViewId`) — **All** for everyone who hasn't changed it. It only
> moves the landing: the whole board view is query state (`?lens=all`,
> `?lens=active&in=…`), every rendered board URL carries an explicit `?lens=`,
> and the bare path is never rested on. Filtered-state chrome measures against
> the absolute unfiltered All baseline, so even the viewer's own home is
> clearable ("Clear filters" targets `?lens=all`). The
> surfacing rule ("your own action always surfaces") still routes a fresh post to
> **All** — the only lens that always contains it — _unless_ the current view
> already does: an unfiltered `all` or `mine` (a self-authored post is `isMine`).
> A status/memo lens (`active`/`needs-resolution`/`decisions`) can't be trusted to
> match a brand-new post, so posting from one still returns to All.

- **All** (default) — everything, `lastActivityAt` desc. The resurfacing wall.
- **Active** — `status = active`: still in motion, not stalled or resolved.
- **Needs resolution** — `status = stalled`, or high `temporalStaleness` with
  low `completenessScore`. Loose ends, things hanging.
- ~~**Decisions / Knowledge**~~ — retired 2026-08-03 (unused in practice; memo
  discovery lives in the memory explorer). Stored `decisions` values degrade to
  All via `degradeBoardLens`.

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
  (Done since the realtime slice, #1100: board reads are IDB-reactive; TanStack
  Query remains the bootstrap/pagination fetcher that seeds the store — what
  changed is that the query result is no longer treated as the live store.)
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

Status: **v1 shipped 2026-06-28** (committed-view projection + "N new" pill +
commit triggers + top scroll-anchor); `virtua` adoption and the backend
stable-paging-key are deferred follow-ups (see "What shipped" below).
**Supersedes the live re-sort behavior shipped in the
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

### What shipped (v1, 2026-06-28)

The projection layer landed as `useStableBoardView`
(`apps/frontend/src/hooks/use-stable-board-view.ts`), wrapping the live
`useBoardPosts` IDB feed:

- **Committed snapshot** — a frozen ordered list of conversation ids. Render walks
  it; each card reads content reactively (a reply fills in place) but never moves
  while committed. A card that vanishes from the live feed (delete / lost access)
  keeps rendering from last-known content until the next commit (tombstone-in-
  place, edge 2), so a removal never shifts the rows below it.
- **Buffer + "N new" pill** — a live id newer than the committed floor that isn't
  committed → buffered, counted in the pill; an id below the floor is older content
  paged in by "Load more" → appended below the frozen window with no pill (the
  `reconcileStableView` split, edge 1's pragmatic v1 take — the client cursor is
  captured per page so re-return/skip is rare and self-heals via socket→IDB).
- **Commit triggers** — pill click (scroll to top, then commit) and remount; the
  viewer's own authored post arms a one-shot `revealNext` so it surfaces instead of
  hiding behind its own pill. At-top still buffers (edge 5).
- **Dropped the rendered bump-to-top** — `optimisticBoardReply` still bumps
  `_lastActivityMs` as IDB truth, but the committed view ignores it, so the
  viewer's own reply updates in place.
- **Top scroll-anchor** — `useBoardScrollAnchor` keeps the topmost visible card's
  screen offset stable across above-fold async reflow via a `ResizeObserver` on the
  content (the board's hand-rolled equivalent of the timeline's `virtua` `shift`).

**Deferred (not in v1):** `virtua` adoption for the board (stays non-virtualized —
the floor measurement is ~430 active cards); the backend stable-paging-key (edge 1's
full fix); the intersection-observer "only what scrolled past is seen" (v1 freezes
the whole snapshot per edge 6); and the optional per-card "updated" dot for seen-card
activity (edge 3).

## Conversations as soft threads — panel + provenance + attached context (Kris)

Two recurring worries motivate this: (1) conversation **classification is still not
right**, and (2) **late replies to a flat conversation read as non-sequiturs** — we
talked lunch, then a bug, the demo, a feature, and now someone out of a meeting
replies "Pizza" from the board. In the flat timeline that "Pizza" lands at the tail,
detached from the lunch thread three hours up. Worse for long-dormant revived topics.

The load-bearing constraint (Kris): **never mutate a stream automatically.** The
rejected fix was converting a dormant conversation into a thread — that moves
existing messages and reorders, "fucks with your ordering." So the rule stays: a new
message is always sequence-appended at the tail (INV-61); nothing relocates.

### The weirdness lives in exactly one projection

A late reply is only jarring in the **flat timeline**. The other two surfaces are
already fine:

- **Board** → correct by design: the topic's card resurfaces (and the "Stable view"
  section above keeps it from yanking the eye).
- **Conversation panel** (below) → coherent by construction: it gathers the topic's
  scattered messages.
- **Flat timeline** → the only broken read. The fix is to make it _self-explaining_
  at the one spot it misleads, not to move anything.

### The reframe: a conversation is a "soft thread"

A **thread** is an _explicit, structural_ grouping (a child stream off a message;
contiguous by construction). A **conversation** is a _projected_ grouping (a filter
over the parent stream's flat messages; scattered). Make them peers: both
**openable in the side panel** and **reply-able**. The difference is only how the
group is defined — and the panel infra is already generic enough for both.

Three mechanisms, all on existing rails:

**A. On-message provenance indicator (read).** Mirror the thread affordance —
`ThreadSlot` renders under a message and links to the thread panel
(`timeline/thread-slot.tsx`, `thread-card.tsx`). The data already exists: the client
builds `conversationIdByMessageId` from the conversation list
(`conversation-overlay/model.ts`) and `annotateConversationRows` already stamps each
row with its conversation **and a `blockStart` flag** (`timeline/event-list.tsx`).
A late reply is therefore already detectable — a `blockStart` whose conversation's
previous message is old / non-adjacent. Render a quiet inline chip on it, `↪ Pizza ·
3h ago`, opening the conversation panel. Show the loud "continues from earlier"
variant only on a **revival** (old/non-adjacent prior message); an ordinary
sequential topic switch needs at most a subtle tick. Unlike a thread (one card under
one root), a conversation has no single root, so the marker is **per context
boundary**, not one card — mirror the affordance, not the layout.

**B. Conversation as a first-class side panel (interact).** The panel is already
fully generic: `panel-context.tsx` routes `?panel=streamId`, `ThreadPanelSlot` +
`usePanelLayout` host arbitrary content, `StreamPanel` just renders `StreamContent`.
Add a panel kind `?panel=conv:<id>` whose content is a **projection** of the stream's
events filtered to that conversation — not a stream, no mutation (dead-on with the
doc's projection thesis). Replying from the panel scopes the message to that
conversation → the explicit, **determinable** path → synchronous assign + bump (no
LLM), per "Realtime / sync model" above.

**C. Attached context (author) — the unifying primitive.** In Threa, "attach a thing
to a message" already means "embed a reference node in the message content":
attachments are `attachmentReference` ProseMirror nodes
(`packages/types/src/prosemirror.ts:243,403`; `markdown.ts`, `extractors.ts`) and
quote-reply is the same pattern (`editor/quote-reply-extension.ts`). A
`conversationReference` node is the same shape — and it produces all three needs in
one gesture: from the normal tail composer you "attach context," pick Pizza, a
removable pill appears, you send. That single act is **the explicit determinable
declaration** (sync assign+bump, clean hand-labeled data for #1), **the authoritative
source of the provenance chip** in (A) — rendered from the reference, instant, no
dependence on the async classifier — and **reply-to-conversation without opening the
panel** (B minus the friction; from the panel the pill is just pre-filled). It
**subsumes quote-reply** (quoting a message is the message-level version of the same
move) and generalizes (the slot could later attach a memo / file / stream link —
**scope guard: ship the conversation type first**, INV-36).

### Tone down the overlay

Today `convOverlay=on` paints the whole wall — 4.5% row tint + colored rails + a
floating dot-pill (`timeline/conversation-overlay/conversation-overlay.tsx`) — the
"over-feature" Kris wants softened. Move its _information_ (membership, jump-to-topic,
correct-topic) to quieter expressions: **drop the always-on tint** to an opt-in color
mode (default off); keep the per-message **reassign** swatch but on-demand
(hover/long-press) — it's the correction that trains #1; **promote** the panel as the
way to see a topic coherently.

### Why this also relaxes #1 (classification)

Once explicit participation flows through scoped/attached replies (determinable, no
classifier) and corrections are first-class (visible reassign → labeled examples, the
forcing-function loop), **the classifier only has to be good for the genuinely
ambient case** — free-form messages nobody filed. #1 stays "simple but hard," but
stops being load-bearing for the surfaces people actually drive.

### Open decisions — all resolved (2026-07-03)

1. **Indicator trigger** — loud `↪ continues X` only on revivals. **Shipped that
   way (#1140); reversed (2026-07-14, PR #1345).** The "revival-only" gate
   required proof the conversation had appeared before — either locally
   rendered earlier in the same load, or (a since-reverted attempt) a
   server-stamped prior-activity timestamp. Both failed the same way: a
   long-dormant conversation revived from the board, with nothing else of it
   loaded in the viewer's timeline, showed no chip at all — the report that
   started this ("nothing else of that Convo was visible"). Kris's call:
   don't try to distinguish "genuine dormant revival" from "topic switch I
   haven't rendered yet" — with replies routinely landing via the board out of
   sequence, both need the same grounding. The chip now fires on every block
   start (the previous conversation-bearing row differs from this one),
   matching `annotateConversationRows`' existing block-start convention
   exactly. `previousActivityAt` is filled in when locally known (a real
   revival within the loaded window) and omitted otherwise — the chip still
   renders, just without a time it can't honestly claim.
2. **Attached context: content node vs. envelope field.** **Resolved the
   _opposite_ of the earlier lean (#1146): a hidden field, not a
   `conversationReference` content node.** The counter-argument won — a
   `conversation` `ConversationDirective` rides the send input
   (`CreateMessageInputJson.conversation`), assigned synchronously in the
   message's transaction, and the payload carries `declaredConversationId`;
   never a node in `contentJson`. The content-node cut was built first and
   rejected: it duplicated the footer provenance chip with an in-body chip, and
   it baked a routing pointer into user-authored body content (plus a markdown
   round-trip) when filing is message _metadata_, not content. Nothing renders
   in the body.
3. **Chip source** — **resolved (#1146): declared id first, async membership map
   as fallback.** One follow-up rule so the two sources can't drift: when a
   declared id no longer resolves (the conversation was merged/retired by a
   later extraction pass), fall back to the async map instead of pointing at a
   dead shell.
4. **Panel routing** — **shipped (#1119)** as `?panel=conv:<id>` rendering a
   projection, peer to `?panel=streamId` for threads.
5. **Filing tag vs. context anchor** — **moot under the field resolution**:
   nothing renders in the body, the footer chip is the only surface. Revisit
   only if a self-contained "re: Pizza, this morning" anchor card is wanted
   later.

## Conversations span streams within one root — the model, made precise (2026-06-30)

This doc has said from the start that a conversation "spans a root message and its
thread replies" (see "The post = a conversation" above). The implementation drifted
from it, and dogfooding surfaced the gap: a DM top-level message rendered as missing
from the board because its conversation also held a thread reply, and the board card
reads only one stream. Three places assume one-stream-per-conversation:

- **Boundary extraction** scopes assignment to a single stream
  (`boundary-extraction-service.ts`), and the synchronous `existing` assigner
  rejects any cross-stream attach (`conversation-assigner.ts`,
  `streamId !== message.streamId` → `CONVERSATION_NOT_IN_STREAM`).
- **The board card** reads one stream's event rail
  (`useBoardCardMessages` → `useStreamRail(conversation.streamId)`), so a member
  message in another stream of the same conversation never draws.
- **Convert-to-thread** (#1113): a board reply to a lone post **retires** the source
  conversation and **mints a new** thread conversation, rather than letting one
  conversation span both. #1114 then built optimistic-swap machinery
  (`usePendingThreadConversions`, a pending-row bridge, `revealNext`-on-convert) to
  mask the cross-row card swap that retire+mint creates. **#1114 is closed**; this
  section is the corrected model.

**The invariant: a conversation is confined to exactly one root stream.** It may span
that root and any of its threads (equal `root_stream_id` across every member message);
it may **never** hold messages from two different roots. This matches the access model
exactly — access is **root-stream membership only**; thread membership is participation,
not access (INV-62, `core-concepts.md:42-45,261`). So a single access check on the
conversation's root (`streamAccessPredicateSql` on `conversation.stream_id`, whose
effective root `COALESCE(root_stream_id, id)` is that one root) gates **every** member,
with **no per-message-stream gating**. The per-message-access worry only exists in a
cross-root world, which this invariant forbids.

**Why span streams at all** (rather than forcing one): the real cases require it —
a **top-level discussion that continues in a thread**, and a **thread answered at the
top level** (the Slack case — a thread holds the topic, a less thread-savvy person
replies in the channel). Both are _the same conversation_ split across the root and a
thread; forcing one stream either loses half of it or shoves unrelated content together.
Moving messages to "fix" alignment is rejected for the same reason it always is here
(never mutate a stream's order automatically — see "soft threads" above).

**Convert-to-thread, corrected.** A board reply to a lone post still creates the thread
(keeps the channel/DM top level clean — Kris's ruling), but the reply joins the **same**
conversation as a cross-stream member (root opener + thread reply, one root). No retire,
no new conversation, **stable conversation id**. The board card never swaps — it renders
in place across the root + thread. The seamless behavior #1114 chased with optimistic
gymnastics falls out for free: the reply is an ordinary optimistic message tagged to the
conversation, shown via the existing rail tagging (#1111).

**Continuation is recency-biased.** Once a conversation spans streams, "where does the
next message go?" is answered by **where the conversation is currently live**, not its
anchor. A board reply / continuation targets the conversation's most-recently-active
stream (the thread, if it moved there) — posting into the anchor root would re-interleave
the channel, the exact mess convert-to-thread avoids. Both `planBoardReply` and the
extractor's continuation need this; lone-post→thread stays the one special case.

**Board rendering.** The card renders a conversation's messages **flattened-chronological
across the root + its threads, live** — it subscribes to the rails of the streams its
members span (a bounded set under one root) and merges by time. A thread-anchored
conversation (legacy, below) still shows its thread parent as the opener; a root-anchored
multi-stream conversation's opener is just its earliest member. _The flatten is a v1
rendering choice, not a model constraint — see "Nested threads × conversations" below
for the structured rendering that replaces it._

**Boundary extraction needs no tightening.** Same-root thread conversations appearing as
assignment candidates (`findByMessageIds` over thread-context messages,
`boundary-extraction-service.ts:120-131`) is **correct** under this model — they share
the root. The misclassification that surfaced all this (a DM-root message clustered into
a same-root thread conversation) was a **quality** error, not a structural one; it's
addressed by recency-biased continuation and the eval loop, not by forbidding the shape.
The one structural rule to enforce: assignment never crosses roots — relax the
synchronous `existing` guard from same-**stream** to same-**root**, and reject cross-root.

**Follow-ups / constraints.**

1. **Legacy data.** Conversations converted under #1113 are thread-anchored with the
   source retired (empty). They render fine via the thread-anchored path; the empty
   sources stay filtered by `cardinality(message_ids) > 0`. An optional backfill could
   re-anchor them to the root and re-absorb the opener, but it isn't required.
2. **Move-message** must respect one-root: moving a member message to a different root
   removes/reassigns it from its conversation, or the invariant breaks.
3. **Access stays a single root check** everywhere a conversation's messages are read
   (board list, expand, rails). Do **not** add per-message-stream gating — it's redundant
   under the invariant and only invites drift.

## Agents on the board — traces visible, never bumping (2026-07-03)

How agent activity meets conversations today:

- **Agent replies are already conversation members.** Every persona/bot reply is
  assigned deterministically — no LLM — to the conversation it replies within,
  minting one if needed (`agent_reply`, stream-locked against double-mint;
  `boundary-extraction-service.ts:587`), and #1170 anchors them to the
  _trigger's_ conversation. Agent conversations are ordinary board cards. (This
  is also why the scope filter is load-bearing: the floor data's 454-of-485 DM
  concentration is one AI-persona DM.)
- **Traces are not conversations, by construction — and stay that way.** Trace
  steps live in `agent_session_steps`, stream to the session room, and render
  via `components/trace/`; the timeline's working indicator is the
  `agent_session:started/completed/failed` stream events rendered by
  `AgentSessionEvent` (`timeline/agent-session-event.tsx`) with live step counts
  from the session socket. None of this passes through `message:created`, so
  none of it feeds extraction or bumps `last_activity_at` — only the agent's
  final reply message does. **Invariant to keep: session/step events never bump
  a conversation.**

**The gap (Kris, dogfooding): trigger an agent from the board and it looks
dead.** The board card and the conversation panel render member _messages_ only
(`MessageItem` rows in `board-card.tsx` / `conversation-panel.tsx`), so
`agent_session:*` events never draw there — between the invoking message and
the final reply there is no sign the agent is working. The timeline shows the
running card; the board shows nothing.

**Fix shape (build item):** conversation surfaces interleave the
`agent_session:*` events of sessions **whose invoking message is a conversation
member**, at their chronological slot, reusing `AgentSessionEvent` + the
live-activity hook as-is. The events already ride the stream rails the card
subscribes to (they're ordinary stream events in IDB), so this is a
projection/filter change — include them alongside member messages — not new
delivery. Rendering only: no assignment, no bump, no read-state effect.

**Scratchpad-linked agents:** an agent working a linked scratchpad writes real
messages, and scratchpad = one conversation — so a long-running agent is one
board card that bumps on every message it sends. Coherent ("what is my agent up
to?"), but ambient churn on the Active lens. The mitigation is the per-viewer
stream mute below — not special-casing agent messages out of the bump.

## Hide & mute — per-viewer exclusions (2026-07-03)

Nothing exists yet. Two grains, deliberately separate:

- **Mute a stream on the board** — "never board-surface my Ariadne DM / that
  agent scratchpad." A per-viewer scope exclusion; ships as part of the scope
  filter (next-up item 2 below). The higher-value grain, given the floor data's
  one-DM concentration and agent-scratchpad churn.
- **Hide a card** — per-conversation. Read-state shipped as a _message_-granular
  sparse overlay (#1165, `stream_member_message_reads` — read iff below the
  watermark or in the overlay), so there is no per-(user, conversation) row for
  hide to piggyback: it gets its own small table (`hidden_at` /
  `snoozed_until`), one extra left-join on the board query. Decide hide-forever
  vs snooze-until-activity at build time (lean: snooze — a hidden topic that
  genuinely revives is exactly what the board exists to resurface).

Dismissals are signal (quiet-collector precedent): hiding a derived card is a
soft "this topic wasn't worth surfacing" label for the eval loop.

## Nested threads × conversations — soft vs true threads (2026-07-04)

The worry (Kris): the board either hides or flattens nested threads depending on
how they wound up being used — and thread nesting in the timeline is one of the
genuinely useful things recently added; it must not be lost because the
conversation system struggles with it.

**Fact of the model first: a sub-thread is neither forced into the parent
conversation nor forced to branch — it's classified.** For a message in any
thread (any depth), the extractor fetches the conversation of the thread's
_parent message_ and hands it to the LLM as an explicit candidate
(`parentMessageConversations`, `boundary-extraction-service.ts:148-155`, in the
prompt and `validUpdateTargets`). Both outcomes occur today: a thread that
continues the discussion joins the parent's conversation as a cross-stream
member (one root); a thread that changes subject gets a fresh conversation.

**And nesting cannot be lost at the data layer.** Thread structure lives in the
stream graph (`parentStreamId`/`parentMessageId`), not in conversation
membership — conversations are flat sets of message ids, and every member still
knows which thread it sits in. The v1 card _chose_ to flatten (see "Board
rendering" above); the structure was never discarded. The only place nesting
can be lost is the renderer, so the renderer is the fix.

**The rule: topic decides membership; structure decides rendering.** Two named
cases (Kris's vocabulary — and behavior the classifier already exhibits, just
invisible and unnamed today):

- **Soft thread** — the thread is _transport_, not a new subject: the
  migrate-to-thread continuation, quote-reply spillover, convert-to-thread.
  Same conversation, same card. Renders as continuation — at most a subtle
  "moved to thread" seam, **no indent**, because topically nothing branched.

  _Refined 2026-07-06 (Kris)._ Convert-to-thread gets **no seam at all**: when
  the pre-boundary run is just the lone opener (the first reply to a lone post
  files into a thread), the thread carries the whole conversation by design, so
  it renders seamlessly forever — regardless of how large the thread grows.
  The seam (and its "split into its own topic" heal) marks only a discussion
  that ran flat in the channel/DM and then migrated into a thread
  mid-conversation. The signal is the pre-boundary run (opener-only vs ≥2
  messages), never thread size or author count.

- **True thread** — the thread is a _sub-topic_. Own conversation in the data
  model, but **rendered nested inside the parent card** (corrected 2026-07-05,
  below): a branch group at the fork point — "↳ _GPU budget_" header plus the
  child's messages indented under it — not a separate card. "Branched from
  _Hardware refresh_" provenance still renders on the child's own panel view.

  _Corrected 2026-07-05 (Kris, dogfooding over tailscale)._ The first ship
  rendered true threads **between** cards — child = own board card, parent gets
  a "↳ stub" link. Verdict: "I tried creating a new subtopic which then opened
  a thread which creates two separate cards in the board. Not what I expected.
  I expected Facebook/Instagram-like nested comments effectively. Or like,
  reddit style." The rule that replaces it: **one card per root discussion** —
  a conversation whose anchor thread forks off another conversation's member
  message is folded into that parent's card as an indented branch group
  (recursively, same depth cap as spanning); it is suppressed from the
  top-level board list **iff its parent card is itself visible in the same
  view** (no access / filtered-out parent ⇒ the child stays standalone rather
  than vanishing). A branch reply counts toward the parent card's effective
  activity for ordering. The child conversation keeps existing in the data
  model exactly as before — classification, memos, split, and the panel all
  operate on it; only the board projection changed. The same session's second
  ruling: **replying happens inline on the card** — a branch tail (and the
  "new sub-topic" gesture itself) expands a composer in place; it must not
  bounce into a thread/panel view (mobile especially).

- **Spanning case** (one conversation genuinely across nested threads with
  back-and-forth in several) — Reddit-style but bounded: indent per **thread
  boundary** only (never per reply; Threa's tree is structural, not
  reply-chain-deep), visible depth capped ~2, deeper collapsed behind a
  "continue this thread →" link into the conversation panel / thread. Slack's
  strictness stays right for the _timeline_ (the room); the card is the
  overview surface, and an overview that can't show shape is why the flatten
  feels unnatural. Likely the rarest of the three.

**No depth special-case.** The rejected alternative was "the conversation chip
covers top-level + first-level threading; nest everything deeper." That
hard-codes a depth rule where soft/true does the work uniformly at every depth:
a first-level thread can be a true sub-topic, a third-level thread can be a
soft continuation. Depth is the wrong signal; topic trajectory is the signal —
and topic trajectory is exactly what's being classified.

**The decider shouldn't only be the LLM.** The channel case — a top-level
message in an otherwise flat channel conversation branches off into a thread —
is where the classifier is weakest, and it fights the "conversation starts in
channel, migrates to thread" flow only apparently: recency-biased continuation
answers _where new messages go_, not what renders where. Extend the #1146
declared-beats-inferred rule to the **thread-opening moment**: the open carries
a directive — _continue this conversation_ vs _new sub-topic_ — defaulting to
continue for quote-reply/convert-to-thread, classifier-decides for a bare
thread open. Add the human correction for when it lands wrong: **"split this
thread into its own topic"** (cheap: reassign the thread's members to a minted
conversation; the stub falls out of the branch relationship).

**The branch gesture must live on the board/panel (Kris, 2026-07-04).** The
board and conversation panel are where conversations turn from implicit to
explicit, so the explicit branch originates there, not only in the timeline:
on any member message row, a **"new sub-topic"** action opens a real thread
under that message _and_ mints the child conversation in the same declared,
determinable path (sync assign + bump, no LLM). That completes the symmetry of
declared gestures from the board: **reply = declared continue**
(recency-routed into the conversation's live stream); **new sub-topic =
declared branch** (thread under the chosen message + minted conversation).
Both are clean labels; neither touches the source stream's order — a thread
under a message is additive. The branch relationship needs **no new column**:
the child conversation's anchor thread hangs off a `parentMessageId` that is a
member of the parent conversation, so the parent card's stub and the child's
"branched from" provenance both derive from the graph — structure decides
rendering, here too.

**What stays correct as-is:** the sync determinable path files thread replies
into the parent message's conversation — right even when a later pass splits
(the split is refinement, not correction; same blessing as the realtime
section). Read-state is message-grain (#1165), so it follows messages wherever
they nest.

**Build notes:** the card's contiguous-run logic (`board-card.tsx:109`) and
`isContinuation` grouping assume a flat run — per-branch grouping replaces
them; the stable-view rule extends naturally (a branch growing while committed
updates in place, it never re-sorts siblings).

## Where we are + what's next (2026-07-03; replaces the original Phasing)

Shipped, all flag-gated behind `board-view`:

- **The board** — workspace-wide feed at `/w/:ws/board`, message-led cards
  grouped by recency, authored posts via the board composer.
- **Sync data plane** — conversations in IDB, `conversation:*` through
  `SocketEventGate`, synchronous determinable assign + bump
  (#1100/#1106/#1109/#1111).
- **Stable view v1** — committed snapshot + "N new" pill + top scroll-anchor
  (2026-06-28, section above).
- **One-root cross-stream model** — the assigner enforces same-root attach
  (section above).
- **Soft threads** — conversation panel `?panel=conv:<id>` (#1119); provenance
  chip on revivals (#1140); declared filing via hidden field + "Reply in
  conversation" (#1146), with thread-follow routing for the directive (#1161),
  carried through scheduled sends (#1168) with a drift signal when a scheduled
  reply files into a conversation that moved (#1171), and agent replies
  anchored to the trigger's conversation (#1170).
- **Read-state (#1165)** — sparse read overlay: `stream_member_message_reads`
  holds individually-read messages above the member's watermark (read iff below
  watermark or in overlay); conversation-aware read state on board/panel +
  phantom-unread fixes. The "rising baseline + exceptions" shape, shipped at
  message grain.
- **Board row actions** — reply, quote-reply, quote-selection, react,
  copy-link, edit, delete (#1124–#1136); conversation-aware save (#1141) and
  share back-link (#1143).
- **Extraction quality** — time-grounded boundaries + memo dedup (#1131); the
  topic-title prompt tightening the floor measurement asked for is in
  (`boundary-extraction/config.ts` now enforces ≤5 words, no framing).

Next, in order (re-sequenced 2026-07-03):

1. **Scope filter + structural lenses** (+ stream-level board mute, above).
   _This — not AI quality — is the promotion blocker:_ the floor data's worst
   defect is flooding, and flooding is a WHERE clause. **Shipped 2026-07-05
   (reshaped per the Lenses section):** All-default home; Active /
   Needs-resolution / Decisions as true filters behind a lens picker (INV-59
   route segments, `all` canonical at bare `/board`); stream scope via `?in=`
   and stream-TYPE scope via `?is=` (both root-resolving — a thread-anchored
   conversation stays in its channel's scope and counts as its root's type),
   matched client-side on the post's server-computed
   `rootStreamId`/`rootStreamType`. Stream-level board _mute_ (a persisted
   per-viewer exclusion) remains open.
   **Extended 2026-07-05 — negative filtering + labels:** every filter
   dimension is now include _and_ exclude — `?in=`/`?not-in=` (streams),
   `?is=`/`?not-is=` (types), and a new label dimension
   `?label=`/`?not-label=` over the viewer's own label assignments (a
   conversation matches a label when its anchor or effective root stream
   carries it; matching for the stream veto is also anchor-or-root, so a
   thread id can be excluded without dropping its channel, while include keeps
   root-only semantics). Include narrows, exclude vetoes, exclude wins on
   overlap; the SQL fragments and the `use-stable-board-view` matchers stay in
   lockstep like the positive filters. Picker rows are tri-state
   (checkbox = include, ban toggle = exclude, "Not:" chips), and saved views
   store all six axes.
2. **Agent sessions visible in conversation surfaces** (section above) — small
   projection change, big perceived-liveness win when driving agents from the
   board.
3. **Declared-id fallback rule** (resolved decision 3 above) — small; keeps the
   chip honest when a declared conversation is later merged/retired.
4. **Per-card hide** (above) — its own per-(user, conversation) table now that
   read-state shipped at message grain.
5. **Nested threads on the card** (section above) — branch stubs + "branched
   from" provenance, the soft-thread seam, bounded spanning-tree rendering;
   the declared thread-open directive — with the "new sub-topic" action on
   board-card and panel message rows as its primary home — and "split this
   thread into its own topic" ride along.
6. **Mine lens** (Saved later, per the 2026-06-22 decisions).
7. **Retitle + mark-resolved** on cards. Merge/split UI drops to backlog —
   declared filing has replaced corrections as the primary eval fuel, and
   merge/split is the expensive end of the correction set. (The nested-threads
   "split this thread into its own topic" is the exception that stays — it's a
   structural split along an existing thread boundary, not the free-form
   message-picker split that made the UI expensive.)
8. **Promotion gate, with numbers** — re-run the floor query post-scope-filter;
   watch declared share of new assignments (up) and correction rate per active
   conversation (down); one dogfood week with the scoped Active lens as the
   actual landing page. Land Q4 as a **per-user default-landing setting**, not
   a global flip — reversible, and solo-first anyway.

Deferred, unchanged: `virtua` for the board and the backend stable-paging key
(revisit at ~2–3× the current ~430-card floor), intersection-observer "seen",
the per-card "updated" dot.

## Phasing (superseded 2026-07-03 — kept for the record)

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

_Update (2026-07-03):_ declared filing (#1146, plus the reply-in-conversation
follow-up) now yields a clean label on every filed reply, so corrections are no
longer the primary eval fuel. Retitle and mark-resolved stay on the plan (user
value in themselves); merge/split UI drops to backlog.

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

With these, the design is settled. Step **(0)** — measure the floor — is done
(below), and **(1b)** — the authored board — has shipped; the live plan is
"Where we are + what's next" above.

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
