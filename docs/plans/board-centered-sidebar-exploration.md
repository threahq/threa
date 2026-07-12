# Exploration: the board-centered sidebar

Status: exploration, 2026-07-12. Companion to `docs/board-view-design.md` (design
of record for the board itself). This doc explores Kris's ask: the sidebar is
timeline-centered — every row navigates to a stream's timeline. Can the Board
button instead transition the app into a _board version_ of itself, where the
sidebar becomes the board's filter surface and clicking a stream/scratchpad
applies an in-place board filter?

Mock of the leading variants: `docs/assets/board-sidebar-variants.png`.

## What we already have (the design space is mostly built)

Three facts make this cheaper than it sounds:

1. **Mode can be pure route derivation.** The board is a route
   (`/w/:ws/board/:lens?`), and `sidebar.tsx` already computes `isBoardPage`.
   "Board mode" needs no new state: being on `/board` _is_ the mode. Back
   button exits it, refresh restores it, links share it (INV-59 for free).
2. **The sidebar already body-swaps.** Desktop search mode replaces the sidebar
   body with `SidebarSearchPanel` (`sidebar.tsx:414`). A board-mode body is the
   second instance of an existing pattern, not a new architecture.
3. **The filter engine is done; it lacks navigation-grade surface area.** The
   six-axis URL vocabulary (`?in/not-in/is/not-is/label/not-label`,
   `board-filter-params.ts`), tri-state pickers, per-user server-persisted
   saved views (`BoardView`, `savedViewHref`, `isViewActive`), pin-as-home
   (`boardDefaultViewId`), and per-stream mute all exist — but they live in a
   cramped filter bar. Saved views are buried two clicks deep in a menu. The
   sidebar is exactly the surface they're missing.

Other reusable parts: `streamTypeVisual` is already shared between sidebar rows
and board cards (visual continuity is free); conversations live in IDB with
`rootStreamId`/status, so per-stream topic counts and per-lens counts are a
client-side group-by, no backend work; `resolveSections` can feed a board-mode
list the same Important/Recent grouping users already know.

## The directions

### V1 — Same list, filter semantics (reinterpret in place)

On `/board`, the sidebar keeps its exact familiar structure — quick links,
Important/Recent (or the user's configured sections), same rows, same
`streamTypeVisual` tiles — but the rows change verb: **clicking a stream
toggles it into the board's `?in=` scope instead of navigating to `/s/:id`.**

- Active state = filter membership: included row gets `bg-primary/10` + a check
  badge on the tile; excluded row dims with a ban badge (mirrors the filter
  bar's tri-state rows).
- A pinned "Filtering the board" chips block sits under the header: include
  chips, destructive "Not:" chips, Clear, **Save view**.
- The preview line swaps from last-message text to **topic stats** ("14 topics ·
  6 active · 2 unread") — the sidebar answers the board's question ("what
  matters where") instead of the timeline's ("what was said last").

Pros: zero new IA to learn; one sidebar codebase; smallest diff (click handler
swap + chips + stats line). Cons: the silent verb change is the risk — same
rows, different action. The chips block, tile badges, and a header that reads
"Board · ← Chats" carry the burden of signalling the mode. Smart sections are
also unread-driven, which is a timeline notion; they may rank streams oddly for
board scoping.

### V2 — Board navigator (full body swap, the Linear model)

On `/board` the sidebar body swaps entirely (search-mode precedent) to a
purpose-built navigator:

- **Views** — saved views as first-class nav rows with counts, pinned-home
  marked, "+" to save the current filter set. (Highest-value single piece in
  this whole exploration, in any direction.)
- **Lenses** — All / Active / Needs resolution / Decisions / Mine from
  `BOARD_LENS_DEFS`, with live counts, active by route segment.
- **Labels** — the viewer's labels as filter rows (`?label=`).
- **Streams** — a flat tri-state filter list (include / exclude / neutral) with
  per-stream topic counts; muted streams surfaced at the bottom with a bell-off.

Pros: purpose-built IA; the six-axis vocabulary becomes directly manipulable;
saved views finally get navigation status; matches the Linear/GitHub-Projects
mental model of "views on the left, items on the right". Cons: a second sidebar
surface to maintain; the sidebar's soul (unread bolding, urgency strips, drag
DnD, custom sections, the editor) doesn't apply — deliberately, but users lose
their configured groupings when boarding; more build.

### V3 — Posture toggle hybrid (Chats | Board as a persistent switch)

A segmented control at the sidebar top: **Chats | Board**. Board posture =
lens chips + a Views section above the _familiar_ stream list running V1's
filter semantics. Two escalation levers, both optional:

- The toggle is just navigation (route-derived like V1/V2) — or it graduates to
  a **persisted landing preference** (`defaultSurface: chats | board`), which
  is exactly the "per-user default-landing setting" the board design doc's
  promotion gate (item 8) called for. `WorkspaceHome` today redirects to the
  last stream; under board posture it redirects to the board home
  (`boardHomeRedirectHref` already exists).
- The segmented control makes the mode _legible at all times_ — the antidote to
  V1's silent-verb-change risk — at the cost of permanent header chrome in both
  postures.

This is V1 + V2's top blocks, with the mode made explicit. Most of the build is
shared with V1/V2.

### V4 — Two faces per stream (no sidebar change)

Don't reinterpret the sidebar; give every stream a board face. In board
context, clicking a sidebar row opens that stream _as a board_ — either
`/board?in=<id>` (canonical, one surface) or a per-stream face
`/s/:id/board` — with a timeline ⇄ board toggle in the stream header. The
"mode" is which face the app currently prefers (sticky while you stay in board
context).

Pros: no verb surprise — click still _opens_ the thing; per-stream boards get a
real home; the stream header toggle is discoverable. Cons: doesn't deliver the
thing Kris actually described (the sidebar as a _composable filter surface_ —
this is one-stream-at-a-time); a second face per stream is a parity treadmill
(the exact drift `docs/board-timeline-drift-audit.md` was written to kill).
Worth keeping only as the _card-locator_ behavior inside other directions:
board-mode click = scope filter, and the escape hatch to the timeline lives in
the row's context menu ("Open timeline").

### V5 — Board keeps its own rail; sidebar untouched

The board page grows an internal left rail (Views/Lenses/Labels/Streams — V2's
content) inside the page, and the app sidebar auto-collapses to its 6px strip
when you enter `/board`. Pros: zero risk to the sidebar; self-contained; the
collapse mechanism exists. Cons: two competing side surfaces; the app sidebar
becomes dead weight in board mode rather than becoming _useful_; fails the
prompt ("the sidebar becomes filtered on filters of the board"). Listed for
completeness — it's the do-least option.

### Rejected: sidebar lists conversations in board mode

An inbox-style sidebar of top conversation cards. Rejected: it duplicates the
feed one panel to the right — the sidebar's job is scoping/navigation, the
feed's job is content. (Pinned conversations could someday be a small sidebar
section, but that's a different feature.)

## Cross-cutting semantics (apply to V1/V2/V3)

**Click model.** The sharp decision. Two candidates:

- **Focus model (recommended):** click = replace scope with this stream
  (`?in=<id>`); click the active one again = clear. Matches sidebar muscle
  memory ("show me this"). Additive selection via the tile's
  checkbox-on-hover / cmd-click (desktop) and the long-press action drawer
  ("Add to filter", "Exclude from board") on touch — the drawer and context
  menu already exist per row.
- **Accumulate model:** every click toggles membership. Faithful to "filters",
  but makes the common case ("just show me #design") two taps and breaks the
  click-means-go instinct. Better as the checkbox affordance than the row verb.

Exclude stays one level deeper (context menu / drawer / chip), like the filter
bar's Ban toggle. `MAX_BOARD_SCOPE_STREAMS` already bounds multi-select.
Clicking a _muted_ stream into `?in=` deliberately reveals it — that's the
existing mute-skip rule, and it's the right semantics (an explicit scope beats
a standing mute).

**Escape hatch to the timeline.** Board-mode rows keep "Open timeline" in the
context menu/drawer, and board cards keep their stream-locator link. Nothing
loses access to the room; the default verb changes, not the capability.

**Unread/urgency in board mode.** Keep the urgency strip and bold-on-unread
(they're real signals and visually anchor the two modes as one app), but the
stats line replaces the message preview. Conversation-aware read state (#1165)
already gives "N unread topics" per stream cheaply from IDB.

**Counts.** Per-stream topic counts and per-lens counts come from the IDB
`conversations` table (client-side group-by on `rootStreamId` / the existing
lens matchers in `use-stable-board-view`). Extract the matchers into a shared
`lib/board/` helper so the sidebar and the stable view can't drift. No backend.

**Mobile.** The drawer stays open on _narrowing_ actions (checkbox toggles —
live count feedback beats reopening the drawer per selection) and closes on
_navigation-shaped_ actions (focus-click, lens pick, saved view pick) — same
rule as today's collapseOnMobile, applied to the new verbs.

**Transition.** The body swap gets a short crossfade/slide (respect
`accessibility.reducedMotion`); the Board quick link becomes the "← Chats"
back affordance in-place (V1/V2) or the segmented control carries it (V3).
"Transition to a board version of the app" is 90% the sidebar body swap plus
the existing route change — no new layout machinery.

**Sidebar config.** V1/V3 inherit the user's configured sections verbatim
(cheapest, and custom sections keep meaning as scoping shortcuts: clicking a
custom _section header_ could scope to all its streams — nice compounding).
V2 would eventually want its own section config; resist that until dogfooding
demands it (INV-36).

## Feature parity — stream features carry into board mode (Kris, 2026-07-12)

Kris's ruling on open question 3: the board sidebar **inherits** the stream
feature ecosystem — labels, unread indicators, the opt-in Unread section, the
configured layout. Board mode re-aims the sidebar's verbs; it must not shed its
features. The mapping, feature by feature:

| Sidebar feature                                    | In board mode                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unread bold + urgency strip**                    | Keep, same signals (they're true regardless of projection; the strip colors — mention/AI/bot/activity — still tell you _why_ a stream matters). The stats line adds board-grain detail: "N unread topics" from conversation-aware read state (#1165), already in IDB.                                                                                                                                                                                                     |
| **Mention badge**                                  | Keep. A mention is a mention.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Unread section** (opt-in)                        | Keeps claiming unread streams out of their home sections. Clicking a row scopes the board to that stream. Section header gains "scope to all unread" (one `?in=` write of the section's ids).                                                                                                                                                                                                                                                                             |
| **Smart sections** (Important/Recent/Other)        | Carry over verbatim — they rank by mentions/AI/unread/recency, all still meaningful for "which stream's topics do I look at".                                                                                                                                                                                                                                                                                                                                             |
| **Label sections** (pinned label = section)        | The header's open affordance switches from the label page to the board's own label axis: `?label=<id>` — _better_ than expanding to stream ids, since the board's label matching is anchor-or-root and stays live as assignments change. Rows inside still toggle `?in=`. The header itself carries no active/"Filtering" tint when its label is the current `?label=` — the chips block already renders that active state, so tinting the header too would be redundant. |
| **Label dots on rows** (`StreamLabelDots`)         | Keep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Custom sections**                                | Rows filter as usual; the section header scopes to the whole section's streams (clamped to `MAX_BOARD_SCOPE_STREAMS` = 50, chips show what got in). Hand-curated sections become saved-view-shaped shortcuts for free.                                                                                                                                                                                                                                                    |
| **Drag & drop filing** (streams → sections/labels) | Stays enabled — drag is organizing, click is scoping; no gesture conflict. Filing a stream into a label while in board mode immediately affects `?label=` matching, which is correct and legible.                                                                                                                                                                                                                                                                         |
| **Context menu / long-press drawer**               | Keep all existing actions (Settings, Labels…, Copy link, Add to section…) and add the board verbs: Add to filter / Exclude from board / **Mute on board** (bell-off — surfacing the existing per-stream board mute here beats the picker burial) / **Open timeline** (the escape hatch).                                                                                                                                                                                  |
| **Board-muted streams**                            | Render dimmed with a bell-off glyph instead of disappearing — the sidebar is where you _manage_ scoping, so the muted set must be visible and reversible here. Distinct copy from notification-mute (two different mutes).                                                                                                                                                                                                                                                |
| **Virtual DM drafts** (members with no DM yet)     | Hidden in board mode — a nonexistent DM has no conversations; the row would be dead weight.                                                                                                                                                                                                                                                                                                                                                                               |
| **E2E streams**                                    | Extraction skips E2E (`boundary-extraction-outbox-handler.ts:40`), so they have no board cards. Show dimmed with a lock and "not on the board" hint rather than omitting — omission reads as a bug to the stream's owner.                                                                                                                                                                                                                                                 |
| **Section collapse states**                        | Shared with chats mode (same localStorage `sectionStates`) — one mental model of "my sidebar layout", two verbs.                                                                                                                                                                                                                                                                                                                                                          |
| **Sidebar editor / config**                        | One `SidebarConfig` drives both modes. No board-specific section config until dogfooding demands it (INV-36).                                                                                                                                                                                                                                                                                                                                                             |
| **Search / quick-switcher**                        | Unchanged — both stay "take me there" navigation even in board posture (open question 4's lean, now firmer: search results and the switcher never become filters).                                                                                                                                                                                                                                                                                                        |

The one genuinely new decision this forces: **counts vs previews on the stats
line.** "14 topics · 6 active · 2 unread" needs per-stream group-bys over IDB
conversations plus the #1165 read overlay; cheap, but it must be memoized at
the list level (one pass over `db.conversations`, not one liveQuery per row) or
a 100-stream sidebar re-renders on every conversation bump.

## Resume where you left off (Kris, 2026-07-12)

Which surface you were on — chats vs board, lens, filters, and therefore the
sidebar mode — must survive an app/device restart. Scroll position explicitly
out of scope. Because mode and filters are all URL in this design, this is a
**generalization of the existing last-stream restore**, not a new mechanism:

- Today: `lib/last-stream.ts` stores `threa-last-stream:<userId>:<wsId>` →
  a stream id; `usePersistLastStream` (mounted in `workspace-layout.tsx`)
  writes it; `useLastStream` reads it at the workspace index route
  (`WorkspaceHome`), validates against bootstrap streams, evicts stale ids,
  falls back to most-recently-active.
- Generalize to **last location**: `threa-last-location:<userId>:<wsId>`
  storing `{ surface: "stream" | "board", streamId: string | null,
board: { lens: string | null, search: string } | null }` — `streamId` is the
  last visited stream (retained while on the board, so "← Chats" has a target),
  `board` the last board state, `surface` which one is current. `search` is
  the _sanitized_ board query — the six filter axes + `archived` only.
  `?panel=` and `?m=` are deliberately stripped: a cold start into a
  months-old conversation panel is a worse default than the filtered feed,
  and the streams side never restored panels either. (Shared deep links
  still carry panels — this only governs the entry redirect.)
- Writer: `usePersistLastStream` grows into `usePersistLastLocation` — same
  mount point, watches the stream match it already gets plus the board route's
  pathname/search, writes on lens/filter change.
- Reader: `useLastStream` grows the board arm: require the `board-view` flag
  (off → fall through to the stream logic), validate the lens against
  `BOARD_LENSES` (unknown → bare `/board`), optionally sweep stale stream ids
  out of `?in=`/`?not-in=` the same way the stream arm evicts (cheap; a stale
  id otherwise renders a placeholder chip). Stream arm and fallbacks unchanged.
- **Composition with the pinned board home:** restore writes explicit URLs, so
  the bare-`/board` bounce to `boardDefaultViewId` never double-fires; and if
  the stored record _is_ a bare board (no lens, no filters), landing on
  `/board` and letting the home redirect run is exactly right — you get your
  pinned home view.
- Migration: fallback-read the legacy `threa-last-stream` key, write only the
  new one, delete the legacy key on first write.
- Per-device by design (localStorage), matching the existing stream behavior.
  Cross-device "continue where my phone was" is a non-goal here.

Sidebar mode needs nothing extra: it derives from the restored URL.

## Recommendation

Build the **route-derived hybrid**: V3's body (Views + Lenses above the
familiar stream list with V1 focus-click filter semantics and topic-stat
previews), _without_ the persisted posture in the first cut — mode stays pure
route derivation, entered by the existing Board quick link, exited by "← Chats"
/ back. Then:

0. **Slice 0 — last-location restore** ("Resume where you left off" above).
   Independent of all sidebar work and valuable today: a PWA cold start
   currently drops a filtered board back to the last stream. Small.
1. **Slice 1 — Views + Lenses in the sidebar on `/board`** (V2's top blocks).
   Unambiguous win, no semantics change anywhere, surfaces saved views as
   navigation. Small.
2. **Slice 2 — stream rows become filter rows on `/board`** (V1 semantics:
   focus-click, tri-state badges, chips block, stats preview line), with the
   feature-parity mappings above.
3. **Slice 3 — the posture preference** (`defaultSurface`), landing the
   promotion-gate item 8 as a user choice once 0-2 have been dogfooded.

Slice 1 is independently shippable and valuable even if 2 gets redesigned.

## Open questions for Kris

1. ~~Row verb~~ — **resolved 2026-07-12 (build greenlit on the
   recommendation): focus-click.** Click replaces the stream scope; clicking
   the sole-included stream clears it; additive via tile checkbox /
   cmd-click / long-press drawer.
2. ~~Chrome~~ — **resolved 2026-07-12 (build greenlit on the recommendation):
   no segmented control.** The Board quick link enters; the board block's
   "← Chats" row (targeting the last visited stream) exits. Revisit the
   segmented toggle only if dogfooding shows the mode isn't legible.
3. ~~How much of the chats sidebar survives in board mode~~ — **resolved
   2026-07-12 (Kris): inherit.** Labels, unread indicators, the Unread section,
   and the configured layout all carry over; see "Feature parity" above. This
   rules out V2-as-shipped (purpose-built navigator that sheds the stream
   features); V2's Views/Lenses blocks survive as the top of the inherited
   list (the V3 body).
4. **Does the posture ever capture the _stream click_ globally** — i.e. in
   board posture, should opening a stream from search/quick-switcher also land
   on its scoped board? (Lean: no — quick-switcher is "take me to the room";
   only sidebar rows change verb.)
