/** Number of events fetched per page (bootstrap and pagination). */
export const EVENT_PAGE_SIZE = 50

/**
 * Fetch next page when this fraction of the current page remains ahead.
 * Used by the non-virtualized scroll path (threads); the virtualized timeline
 * uses EVENT_PREFETCH_DISTANCE instead.
 */
export const SCROLL_FETCH_RATIO = 0.75

/**
 * Prefetch lead for the virtualized timeline: how many loaded items may remain
 * beyond the rendered range before the next page fetch fires. Sits below
 * EVENT_PAGE_SIZE so a freshly prepended page pushes the trigger back out of
 * range (no runaway loop), and high enough that a page round-trip usually lands
 * before a fast scroll reaches the boundary — without it the user sees the
 * "loading older messages" indicator on every fling. The non-virtualized thread
 * path uses SCROLL_FETCH_RATIO for the equivalent trigger.
 */
export const EVENT_PREFETCH_DISTANCE = 15
