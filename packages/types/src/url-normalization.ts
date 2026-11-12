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
  /^\[?::\]?$/, // IPv6 unspecified: connects to this host
  /^\[?fe80:/i, // IPv6 link-local
  /^\[?fc00:/i, // IPv6 unique local
  /^\[?fd/i, // IPv6 unique local
  /^\[?::ffff:/i, // IPv4-mapped IPv6: reaches any IPv4 address, loopback and private included
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

/** A DNS name is at most 253 characters; a longer host is no site, and it would not fit the indexes keyed on it. */
export const LINK_FAVICON_HOST_MAX_LENGTH = 255

/**
 * Key for a link's favicon: `URL.host` (lowercased, punycoded, non-default port kept). Null for non-http(s), for an
 * over-long host, and for a host of dots alone, which would be a path segment of its own in the favicon URL.
 */
export function linkFaviconHost(url: string): string | null {
  try {
    const { protocol, host } = new URL(url)
    if (protocol !== "http:" && protocol !== "https:") return null
    if (!host || host.length > LINK_FAVICON_HOST_MAX_LENGTH || /^\.+$/.test(host)) return null
    return host
  } catch {
    return null
  }
}
