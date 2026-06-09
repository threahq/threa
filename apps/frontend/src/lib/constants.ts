/** Number of events fetched per page (bootstrap and pagination). */
export const EVENT_PAGE_SIZE = 50

/**
 * Fetch next page when this fraction of the current page remains ahead.
 * Used by the non-virtualized scroll path (threads); the virtualized timeline
 * uses EDGE_PREFETCH_PX (in stream-content.tsx) instead.
 */
export const SCROLL_FETCH_RATIO = 0.75
