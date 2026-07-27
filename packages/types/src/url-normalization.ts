/**
 * The VALUES behind link filtering and dedup, shared so the backend's
 * `link-previews/url-utils.ts` and the frontend's local context-row projection
 * agree on which links exist and which collapse into one (INV-33). Each side
 * keeps its own matching code; only these lists are the source of truth. A
 * client list that drifts narrower projects local rows the server never writes,
 * which can never reconcile.
 */

/** Private/reserved IP ranges that must not be fetched (SSRF protection). */
export const BLOCKED_IP_PATTERNS: readonly RegExp[] = [
  /^127\./, // loopback
  /^10\./, // private class A
  /^172\.(1[6-9]|2\d|3[01])\./, // private class B
  /^192\.168\./, // private class C
  /^169\.254\./, // link-local
  /^0\./, // current network
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?fe80:/i, // IPv6 link-local
  /^\[?fc00:/i, // IPv6 unique local
  /^\[?fd/i, // IPv6 unique local
]

/** Hostnames that must not be fetched (cloud metadata endpoints). */
export const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
])

/** Tracking parameters stripped during URL normalization. */
export const TRACKING_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "source",
]
