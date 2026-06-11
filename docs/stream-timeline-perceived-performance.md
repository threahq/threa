# Stream timeline perceived performance on mobile

Exploration of four user-visible sluggishness symptoms in the stream view on
mobile (reference device: a 2021 budget Android running the PWA). The goal was
to determine whether these are inherent PWA costs or things we built, and what
to change. Conclusion up front: all four symptoms trace to specific code we
own, none of them require abandoning the PWA, and most share two root causes.

Sibling exploration: `docs/sync-engine-v2-exploration.md` (PR #826) diagnoses
the data-layer side (two-tier sync model). This doc covers the render-layer
side. See "Relationship to sync v2" below for exactly which symptoms v2 would
and would not address.

## The two shared root causes

Almost everything below reduces to these two:

1. **The timeline row tree is not memoized, and its inputs churn identity.**
   `TimelineItemContent` is a plain function component
   (`event-list.tsx:366`), as are `EventItem` and `MessageEvent`. Every
   re-emission of the events array rebuilds all `TimelineItem` objects
   (`groupTimelineItems`, `event-list.tsx:237`), and `renderCtx` is rebuilt
   with fresh Maps/Sets on every message arrival or phase change
   (`stream-content.tsx:1774-1809`). Result: any data tick re-renders every
   visible row. `MarkdownContent` is memoized (`markdown-content.tsx:68`) so
   markdown parses are mostly contained, but everything else in a row
   (reactions, avatars, attachments, link previews, grouping chrome) runs
   again. On a slow CPU this is the difference between a 2ms and a 60ms+
   frame.

2. **Media has no stable identity across renders or sessions.** Image and GIF
   loading state is mount-local component state (`imgDecoded`,
   `thumbnailUrl` in `attachment-list.tsx:130-262`), and attachment URLs are
   presigned per session. Any remount replays skeleton-then-fade; any new
   session re-downloads every byte.

## Symptom 1: cold start feels laggy as content loads in

What happens on a cold open of a stream, in order:

1. Cached events paint from IndexedDB (good; this part works).
2. The network bootstrap arrives and `applyStreamBootstrap` bulk-writes rows
   back to IDB, including rows whose content did not change (two-tier merge,
   `sync/stream-sync.ts:192-217`; rows socket-patched after the snapshot are
   skipped, the rest are rewritten).
3. Dexie `useLiveQuery` re-runs and emits an entirely new array with all-new
   object identities (`stores/stream-store.ts:85-108`), even when content is
   byte-identical.
4. The memo chain (`events` → `displayEvents` → `timelineItems` →
   `visibleItems`) re-runs top to bottom and every visible row re-renders
   (root cause 1).
5. The coordinated-loading phase flips to `ready`, which flips
   `deferSecondaryHydration` on every row at once
   (`event-list.tsx:396`). All deferred secondary content hydrates in a
   single burst: every visible image fires a presign request
   (`api/attachments.ts:87`), link previews fetch, Giphy embeds load, and
   each arrival triggers a row state update plus a virtua re-measure.
6. Meanwhile the workspace bootstrap is bulk-writing 13+ IDB tables on the
   same thread (`sync/workspace-sync.ts:1706-1805`) and seeding the in-memory
   cache synchronously (`workspace-sync.ts:1822`).

The user-perceived "things become laggy as content loads in" is steps 3-6
landing within the first second or two after paint: a full-window re-render,
a hydration burst, and IDB indexing all competing for one slow core.

Additional churn source when bots are present: `bot_runtime:presence` patches
the stream bootstrap cache several times per second during active sessions
(`sync/stream-sync.ts:866-893`); each accepted patch is another full-window
re-render under root cause 1.

### Fix direction

- Memoize the row tree and stabilize inputs (see "Proposed work" below).
  This makes step 4 nearly free.
- Structural sharing in the liveQuery read: when re-reading events, reuse
  the previous row object if `id` and a cheap change marker match, so
  memoized rows bail out. Alternatively (or additionally), skip the IDB
  rewrite in step 2 when the merged payload is deep-equal to the existing
  row; that silences the liveQuery emission at the source.
- Stagger the hydration burst: release `deferSecondaryHydration` for rows
  near the viewport first (or in small batches over a few frames) instead of
  all at once on the phase flip. Also remove `phase` from `renderCtx` and
  let rows read it from context individually, so the flip does not also
  invalidate every row's props.

## Symptom 2: composer open/close makes content "load in again"

Two mechanisms stack here:

1. **The mobile composer animates layout.** The composer shell transitions
   `max-height`/`min-height` over 200ms (`message-composer.tsx:964-967`).
   Layout-affecting transitions re-run layout every frame, and because the
   timeline scroller's height depends on the composer, every frame of the
   transition fires the scroller ResizeObserver, re-pins to bottom, and
   forces virtua to re-measure (`use-timeline-scroll.ts:440-472`). With
   unmemoized rows this is a full-window re-render per frame. The PR #816
   work already established that animating the shell height yields ~10fps on
   this class of device; the composer's own expand/collapse still does it.

2. **Keyboard close triggers two height snaps.** The optimistic-close path
   snaps `--viewport-height` to the base height immediately and suppresses
   further writes for 500ms (`use-visual-viewport.ts:255-263`,
   `OPTIMISTIC_CLOSE_SUPPRESS_MS`), then a reconcile pass at 500ms applies a
   settled measurement if it differs (`use-visual-viewport.ts:269-272`).
   Each snap resizes the scroller, re-pins, and re-measures. Between the
   snap and the refill of the newly revealed strip, the compositor is
   showing a resized layer whose content has not painted yet; on low-end
   Android GPUs that surfaces as the black/white flash. Virtua's render
   window (`bufferSize={1000}` px, `stream-content.tsx:2008`) then has to
   mount/refill with expensive rows, which takes multiple frames, so content
   visibly pops back in.

Closing is worse than opening because close runs the optimistic snap plus
the deferred reconcile (two resize/re-measure cycles), while open is a
single coordinated snap (`openMobileChromeWithKeyboard`,
`message-composer.tsx:312-364`).

### Fix direction

- Stop animating `max-height` on the mobile composer. Snap the height (we
  already snap for keyboard choreography for exactly this reason), or if an
  animation is wanted, animate a `transform` on an inner element while the
  layout box snaps once.
- Make the reconcile pass a no-op in the common case: it already compares
  against `lastWrittenHeight`, but mid-freeze interim browser reports can
  make the settled value differ by a few px. Tolerate small deltas instead
  of re-snapping for them.
- Root cause 1's fix makes the refill after each snap cheap, which shrinks
  the visible blank window even when a resize is unavoidable.

## Symptom 3: infinite scroll shows blanks before messages render

Two distinct causes, and they cascade:

**Render-bound:** virtua's overscan is `bufferSize={1000}` px
(`stream-content.tsx:2008`). At fling velocity on a phone (~2000px/s) that
is half a second of scroll, but each newly mounted row is expensive
(root cause 1: full message DOM, reactions, attachments, no memo bailouts),
so mounting falls behind the scroll position and blanks show. The buffer was
deliberately kept small because large overscan with expensive rows caused
jank (comment at `stream-content.tsx:2007`); the parameter is trapped
between two costs that both come from expensive rows.

**Fetch-bound:** the older-page fetch triggers at a fixed
`EDGE_PREFETCH_PX = 1500` px from the edge (`stream-content.tsx:162`,
trigger logic at `stream-content.tsx:1853-1860`), with
`EVENT_PAGE_SIZE = 50` (`lib/constants.ts:2`). With variable row heights,
1500px is ~25 short rows but only ~3-4 image rows of lead time, so a fast
fling reaches the edge before the page lands. While fetching there is only a
floating "Loading older messages..." pill (`stream-content.tsx:1468`), no
placeholder rows, so the space where messages will appear is plain blank.
Prepend shift detection also happens one render after the data arrives
(`use-timeline-scroll.ts:213-221`), so a late shift can collide with
in-progress measurement and extend the blank.

### Fix direction

- Memoize rows first (root cause 1). Cheap rows unlock raising `bufferSize`
  without re-introducing the jank that forced it down to 1000.
- Render skeleton placeholder rows at the top while `isFetchingOlder`, so
  blank space reads as loading instead of broken.
- Make the prefetch lead adaptive: trigger on estimated rows-remaining
  rather than fixed px, or simply raise the px threshold once rows are cheap
  enough that the bigger window is affordable.

## Symptom 4: some messages flicker like they were replaced; images and GIFs reload

The "some but not all" pattern is explained by the two-tier merge: on
bootstrap apply, rows whose `_patchedAt` is newer than the snapshot are
skipped, everything else is rewritten with a new `_cachedAt`
(`sync/stream-sync.ts:192-217`). The rewritten rows come back from liveQuery
as new objects, re-render (root cause 1), and any component holding
mount-local load state replays its loading visuals:

- `ImageAttachment` holds `thumbnailUrl` (starts `null`) and `imgDecoded`
  (starts `false`, drives an opacity fade) as component state
  (`attachment-list.tsx:130-262`). Remount → skeleton → presign fetch →
  src set → fade-in replays, even when every cache is warm.
- Link previews hold fetched previews in component state
  (`link-preview-list.tsx:51`); Giphy embeds mount per ref
  (`giphy-preview-list.tsx`).

On top of that, media bytes genuinely re-download across sessions:

- `getDownloadUrl` has an in-memory cache with in-flight dedup and a 15-min
  TTL (`api/attachments.ts:43-49, 87-125`), but it is module-level state, so
  every cold start begins empty: one presign HTTP round trip per visible
  attachment before the `<img>` even has a `src`.
- Presigned URLs carry a fresh signature each time, so the browser HTTP
  cache misses across sessions. Every image and GIF re-downloads on every
  cold open. This is why media visibly "loads in again" each time the app
  starts.

### Fix direction

- **Stable media URLs.** Serve attachment bytes from a deterministic,
  cookie-authenticated endpoint (or a redirecting endpoint with proper
  `Cache-Control`) so the browser HTTP cache works across sessions. This is
  the single highest-leverage media fix: warm opens stop re-downloading
  anything, and the presign round trip leaves the critical path.
  Alternative if presigning must stay: persist resolved URL + expiry in IDB
  keyed by attachment id and seed it before paint.
- Skip the fade when the image is already decoded: if `img.complete` is true
  immediately (cache hit), set `imgDecoded` synchronously instead of waiting
  for `onLoad`, so warm renders do not flash.
- Root cause 1's fix prevents the rewritten-row re-render from reaching
  these components at all when nothing changed, and structural sharing in
  the liveQuery read (symptom 1 fix) removes the trigger.

## Relationship to sync v2 (PR #826)

The single-cursor direction in #826 helps two of the four symptoms, partially,
and none of the others:

- **Symptom 1 (cold-start lag):** partially addressed. The largest trigger is
  the bootstrap rewriting unchanged rows into IDB, which makes liveQuery
  re-emit everything. Under v2, warm catch-up is a cursor replay that applies
  only the delta, and "is my snapshot current" becomes an integer comparison,
  so the spurious full-rewrite churn largely disappears. The hydration burst,
  the presign round trips, and the workspace IDB indexing on a true cold
  start remain.
- **Symptom 4, flicker half:** addressed. The "some but not all" pattern is
  the `_patchedAt` two-tier merge deciding which rows to rewrite; v2
  dissolves that machinery. The media half (per-session presigned URLs,
  mount-local fade state) is untouched.
- **Symptoms 2 and 3:** not addressed. Composer blanking is a
  render/compositor problem and scroll blanks are row mount cost vs.
  overscan; neither has any sync component.

Two reasons the render-layer work is needed regardless of v2:

1. Dexie `liveQuery` re-runs `.toArray()` on any write to the events table,
   including a legitimate single-message delta, and materializes all-new
   object identities for every row. So even under a perfect delta protocol,
   one new message invalidates every visible row's props unless the row tree
   is memoized and the read path does structural sharing. v2 reduces how
   often the storm fires; items 1-2 below reduce what a storm costs.
2. v2's step 1 is backend-only (the sync-log spine, explicitly no client
   behavior change), so its render-side benefits arrive in a later phase. The
   fixes below are cheap and land immediately.

One overlap to be aware of: item 2's "skip no-op IDB rewrites in the
bootstrap merge" is a tactical version of what v2 provides structurally. It
is still worth doing as cheap interim relief, but it is the one item below
that v2 eventually subsumes.

## Proposed work, in order

1. **Memoize the timeline row tree.** `React.memo` on `TimelineItemContent`,
   `EventItem`, `MessageEvent`; split `renderCtx` so volatile parts
   (`newMessageIds`, agent activity maps, `phase`) stop invalidating rows
   that do not use them. This is the keystone: it improves all four
   symptoms and unlocks the overscan raise.
2. **Structural sharing on the events read path**, and/or skip no-op IDB
   rewrites in the bootstrap merge, so unchanged rows keep identity and the
   memo bailouts actually fire.
3. **Stable attachment URLs** (deterministic authed endpoint or persisted
   presign cache) + `img.complete` fast path. Kills the per-session media
   re-download and the warm-render flash.
4. **Composer: snap instead of animating `max-height`**; tolerate small
   deltas in the keyboard reconcile pass.
5. **Infinite scroll: skeleton rows while fetching older + raise
   `bufferSize`** once rows are cheap; consider adaptive prefetch lead.
6. **Stagger `deferSecondaryHydration` release** after the reveal-gate phase
   flip instead of hydrating everything at once.

Items 1-2 are pure frontend refactors with no protocol implications. Item 3
touches the backend attachment routes. Items 4-6 are small and local. None
of them conflict with sync v2; 1-2 make the current engine's rewrite-heavy
behavior cheap to absorb, which also buys time for v2 to land on its own
schedule (see "Relationship to sync v2" above).

## How to verify

Profile on a real low-end device or Chrome DevTools with 6x CPU throttle:

- Cold open a media-heavy stream: count presign requests and image bytes
  fetched (should drop to ~zero warm after item 3), and trace the long task
  around the phase flip (should shrink after items 1-2 and 6).
- React Profiler on bootstrap apply: rows re-rendered should drop from "all
  visible" to "only changed" after items 1-2.
- Record composer open/close: frame rate during the transition (should hold
  near 60 after item 4) and absence of the black/white flash.
- Fling-scroll history: blank-row occurrences per 10s of scrolling, before
  and after items 1 and 5.
