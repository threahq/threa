/** Giphy REST API base for the GIF endpoints used by the picker. */
export const GIPHY_API_BASE = "https://api.giphy.com/v1/gifs"

/** Default page size for search/trending requests. */
export const GIPHY_PAGE_SIZE = 24

/** Upper bound a caller may request per page. */
export const GIPHY_MAX_PAGE_SIZE = 50

/** Longest query string we forward to Giphy. */
export const GIPHY_MAX_QUERY_LENGTH = 100

/**
 * Content rating ceiling. The picker is a workspace-wide surface, so we cap at
 * `pg-13` rather than surfacing `r`-rated results by default.
 */
export const GIPHY_RATING = "pg-13"

/**
 * Hosts the byte proxy will download GIF bytes from. Giphy serves media off
 * `*.giphy.com` (e.g. `media0.giphy.com`, `i.giphy.com`). Re-resolving the URL
 * by id keeps it server-controlled; this suffix check is defense-in-depth
 * against an unexpected redirect target (SSRF).
 */
export const GIPHY_ALLOWED_MEDIA_HOST_SUFFIX = ".giphy.com"

/**
 * Hard ceiling on proxied GIF bytes. The `downsized` rendition Giphy returns is
 * capped near 2MB; this is a safety ceiling so a surprising rendition can't
 * stream an unbounded body through the API server.
 */
export const GIPHY_MAX_FILE_BYTES = 8 * 1024 * 1024

/** Abort any outbound Giphy request that hasn't responded in this window. */
export const GIPHY_FETCH_TIMEOUT_MS = 10_000
