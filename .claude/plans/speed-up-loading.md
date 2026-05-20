# Offline-First Coordinated Stream Loading

## Goal

Restore the initial stream-view loading contract after the virtual scroller changes: when IndexedDB already has stream messages, the app shell and stream timeline should stay hidden during the short coordinated blank phase, then reveal together from local data without waiting for a remote stream bootstrap. The stream should not show an intermediate blank viewport or a premature "Jump to latest" control before timeline rows are renderable.

## What Was Built

### Local stream event readiness for the coordinated gate

The coordinated loading provider now observes the visible stream IDs' IndexedDB event rows directly. A resolved local event read with cached events is enough to bypass pending remote bootstrap; an unresolved read is treated as "not done", not as "no data".

**Files:**
- `apps/frontend/src/contexts/use-visible-stream-events-snapshot.ts` — `useLiveQuery` helper that reads event counts for visible stream IDs from IndexedDB via the existing `loadStreamEvents` path.
- `apps/frontend/src/contexts/coordinated-loading-context.tsx` — folds local event readiness into the initial gate and debug state.

### Mounted-but-hidden shell/content coordination

The app shell and main content now remain mounted while hidden during the initial blank/skeleton phases. This lets the stream view's own IndexedDB reads and virtualizer setup run in parallel with workspace/sidebar reads, instead of starting only after the provider declares ready.

**Files:**
- `apps/frontend/src/contexts/coordinated-loading-context.tsx` — `CoordinatedLoadingGate` uses hidden/inert wrapping instead of unmounting; `MainContentGate` overlays the skeleton while keeping children mounted.

### Stream-content readiness reporting

The stream content reports when its own timeline data path has resolved and, for virtualized timelines, when Virtuoso has produced an item range. The provider waits for this signal before leaving the initial coordinated phase, so the shell does not reveal while the stream's separate `useLiveQuery` or virtualizer is still blank.

**Files:**
- `apps/frontend/src/contexts/coordinated-loading-context.tsx` — adds `reportStreamContentReady` and waits for visible server stream IDs.
- `apps/frontend/src/components/timeline/stream-content.tsx` — reports readiness after IDB/events resolve and the virtualized range has rendered.

### Premature Jump-to-latest suppression

The Jump-to-latest affordance is hidden until there are renderable timeline items and the virtualized list has produced a range. This prevents the button from appearing over a blank stream during the virtualizer's initial mount/reveal window.

**Files:**
- `apps/frontend/src/components/timeline/stream-content.tsx` — gates the button on renderable items and virtualizer readiness.

## Design Decisions

### Keep IndexedDB as the source of truth

**Chose:** Read local stream readiness from IndexedDB and reuse the existing `loadStreamEvents` path.

**Why:** The bug is a coordination/order issue, not an IDB performance issue. Adding an in-memory event cache would hide the underlying race and duplicate the local read model.

**Alternatives considered:** Reintroducing a stream event memory cache. Rejected because the requirement is offline-first IndexedDB, and the repo had already removed that cache.

### Coordinate on the stream's actual render path

**Chose:** Add a readiness report from mounted `StreamContent` back to the provider.

**Why:** A provider-level IDB query can prove messages exist, but the timeline's own `useLiveQuery` and Virtuoso mount can still be unresolved for a frame. Waiting for the child render path prevents the second blank phase.

**Alternatives considered:** Trust only the provider's local event count. Rejected after retesting showed the stream could still reveal before its own query/virtualizer was ready.

### Hide rather than unmount during the blank phase

**Chose:** Keep children mounted with `visibility: hidden`, `aria-hidden`, and `inert` during the initial blank phase.

**Why:** Unmounting prevents nested IDB live queries from starting. Hidden-but-mounted preserves the desired blank UI while allowing local reads and virtualizer measurement to complete.

## Design Evolution

- **Provider-only readiness was insufficient:** The first fix let the provider bypass remote bootstrap when it saw local event rows. Manual retesting showed the stream could still reveal before `StreamContent`'s own live query and virtualizer finished. The final approach additionally waits for stream-content readiness.
- **Jump button needed render readiness:** Hiding the Jump-to-latest button only when `visibleItems.length === 0` was not enough; it can be non-empty while Virtuoso is still mounting. The final guard waits for the virtualizer's range callback.

## Schema Changes

None.

## What's NOT Included

- No in-memory stream event cache.
- No changes to server bootstrap APIs.
- No react-virtuoso package or patch changes.
- No broad refactor of the timeline data model.

## Status

- [x] Treat unresolved local stream event reads as not done.
- [x] Let app shell and stream content mount hidden so local reads run together.
- [x] Wait for stream content/virtualizer readiness before coordinated reveal.
- [x] Hide Jump-to-latest until timeline rows are renderable.
- [x] Add regression tests for coordinated loading readiness.
