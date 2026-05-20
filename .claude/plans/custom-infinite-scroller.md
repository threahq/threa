# Custom Infinite Scroller Stability

## Goal

Make the stream timeline pixel-stable under virtualization while preserving the existing IndexedDB/offline-first data path. The timeline should not visibly jump when history is prepended, when live events append, when jump/deep-link windows replace the current event window, or when Virtuoso overscans beyond the viewport.

## What Was Built

### Virtual index anchoring

`useVirtuosoScroll` now tracks a map of stable item keys to indexes and adjusts `firstItemIndex` synchronously during render based on the first preserved item. This handles prepends, appends, mixed prepend+append updates, and leading removals without a one-frame mismatch between the data array and Virtuoso's virtual index base.

**Files:**
- `apps/frontend/src/hooks/use-virtuoso-scroll.ts` — synchronous key-preserving `firstItemIndex` updates, reset handling, bottom-distance tracking.
- `apps/frontend/src/hooks/use-virtuoso-scroll.test.tsx` — regression coverage for prepend/append anchoring, stream reset behavior, skip-initial-scroll behavior, and overscanned bottom-button visibility.

### Guarded edge pagination

Direct Virtuoso `startReached` / `endReached` callbacks were removed from the stream list. Pagination now runs through the existing guarded `rangeChanged` path, which can suppress transient edge ranges during initial mount, deep-link scroll convergence, and jump-mode windows.

**Files:**
- `apps/frontend/src/components/timeline/stream-content.tsx` — removes direct edge callbacks, resets range/prepend state around jump-window replacements, and keys range-settlement state by stream/jump mode.

### Overscan and pre-rendering

The timeline now pre-renders at least one viewport of content above and below the visible range, plus a minimum item-count overscan. The overscan distance tracks the actual scroller height via `ResizeObserver` so larger viewports get enough measured content without requiring a patched Virtuoso bundle change.

**Files:**
- `apps/frontend/src/components/timeline/stream-content.tsx` — dynamic `increaseViewportBy` and `minOverscanItemCount` configuration.

### Jump-to-latest correctness under overscan

The jump-to-latest affordance no longer relies solely on Virtuoso's rendered range, because overscan can render bottom rows while they are still physically offscreen. The hook now computes distance from bottom using actual scroll pixels when a scroller element is available.

**Files:**
- `apps/frontend/src/hooks/use-virtuoso-scroll.ts` — scroll listener and pixel-distance threshold.
- `apps/frontend/src/hooks/use-virtuoso-scroll.test.tsx` — regression for overscanned ranges not hiding the button.

### Zero-height row filtering

Timeline items that render as no visible row are filtered before virtualization count/key calculation. This prevents Virtuoso from measuring zero-height rows that can overlap subsequent content.

**Files:**
- `apps/frontend/src/components/timeline/event-list.tsx` — filters destination-side `messages:moved` rows and invalid command groups lacking `command_dispatched`.
- `apps/frontend/src/components/timeline/event-list.test.ts` — regression coverage for the new filters.

## Design Decisions

### Key-preserving index adjustment

**Chose:** Compare stable item keys across renders and adjust `firstItemIndex` by the preserved anchor delta.

**Why:** Count-only prepend detection fails when prepends and appends happen together or when leading rows are removed. A key-preserving anchor matches how the user perceives continuity: the same row should stay at the same pixel position.

**Alternatives considered:** Only comparing the first key and item count. That misses mixed update shapes and can misclassify window replacement.

### RangeChanged-only pagination

**Chose:** Route pagination through `rangeChanged` instead of Virtuoso's direct edge callbacks.

**Why:** The direct callbacks can fire during programmatic/deep-link scrolling and bypass existing guards. `rangeChanged` lets the component gate pagination on settled range state and scroll-abort state.

**Alternatives considered:** Keep `startReached` / `endReached` and add local guards around each. That leaves multiple edge-trigger paths to keep in sync.

### Pixel-distance bottom detection

**Chose:** Use physical scroll distance from the scroller element for `isScrolledFarFromBottom` when available.

**Why:** Overscan intentionally renders rows outside the viewport, so rendered range is no longer a reliable proxy for whether the user can see the bottom.

**Alternatives considered:** Increasing the rendered-range threshold. That still couples UI state to overscan configuration instead of actual scroll position.

## Design Evolution

- **Overscan regression:** Increasing pre-render/overscan improved row pop-in but made the rendered range include bottom rows too early. The bottom-button logic was updated to use physical scroll distance so overscan and UI affordance visibility do not conflict.
- **Jump-window replacement:** Jump/deep-link event windows are wholesale replacements, not incremental history prepends. The stream now resets prepend/range state before jump loads so the anchoring logic does not treat replacement as pagination.

## Schema Changes

None.

## What's NOT Included

- No IndexedDB/query/cache changes are included in this PR.
- No coordinated-loading changes are included; initial-load blank/skeleton behavior remains a separate follow-up.
- No patched `react-virtuoso` bundle changes are included; the fix uses public Virtuoso props and hook-level state.

## Status

- [x] Stabilize `firstItemIndex` across prepend/append/removal/reset cases.
- [x] Guard pagination through `rangeChanged` and reset jump/deep-link range state.
- [x] Increase dynamic pre-render/overscan without bundle changes.
- [x] Restore Jump to latest visibility under overscan via physical scroll distance.
- [x] Filter zero-height virtual rows before virtualization.
- [x] Add regression tests for scroll anchoring and row filtering.
