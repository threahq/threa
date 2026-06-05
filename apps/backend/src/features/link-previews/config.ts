/** Maximum number of link previews to extract per message */
export const MAX_PREVIEWS_PER_MESSAGE = 5

/** Timeout for fetching a single URL's metadata (ms) */
export const FETCH_TIMEOUT_MS = 10_000

/**
 * User-Agent string for metadata fetch requests.
 *
 * The `+`-prefixed contact URL is the long-standing polite-crawler convention (cf. Googlebot's
 * `+http://www.google.com/bot.html`, facebookexternalhit, Slackbot). Several large sites — Amazon
 * notably — gate their bot detection on it: a bare token like `Threa/1.0 (Link Preview)` (or even a
 * normal browser UA from a datacenter IP) is served a metadata-less captcha page, while the same
 * request carrying `(+https://…)` is served the real HTML. Keep the `+URL` form or Amazon-class
 * pages silently lose their previews.
 */
export const FETCH_USER_AGENT = "Threa/1.0 (Link Preview; +https://threa.io/bot)"

/** Maximum HTML bytes to read before stopping (some sites like YouTube put meta tags 600KB+ in) */
export const MAX_HTML_BYTES = 512 * 1024

/** Maximum description length to store */
export const MAX_DESCRIPTION_LENGTH = 500

/** Maximum title length to store */
export const MAX_TITLE_LENGTH = 300

/**
 * Known app origins for detecting internal message permalinks.
 * Loaded from CORS_ALLOWED_ORIGINS at startup, with dev defaults.
 */
export function getAppOrigins(): string[] {
  const env = process.env.CORS_ALLOWED_ORIGINS
  if (env) return env.split(",").map((s) => s.trim())
  return ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"]
}

/** oEmbed providers: URL pattern → endpoint. Tried before HTML scraping for faster, more reliable results. */
export const OEMBED_PROVIDERS: ReadonlyArray<{ pattern: RegExp; endpoint: string }> = [
  { pattern: /^https?:\/\/(?:www\.)?youtube\.com\/watch/, endpoint: "https://www.youtube.com/oembed" },
  { pattern: /^https?:\/\/youtu\.be\//, endpoint: "https://www.youtube.com/oembed" },
  { pattern: /^https?:\/\/(?:www\.)?vimeo\.com\/\d+/, endpoint: "https://vimeo.com/api/oembed.json" },
  {
    pattern: /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/,
    endpoint: "https://publish.twitter.com/oembed",
  },
]
