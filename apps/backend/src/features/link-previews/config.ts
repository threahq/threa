import { threaFetchUserAgent } from "@threahq/types"

export const MAX_PREVIEWS_PER_MESSAGE = 5

export const FETCH_TIMEOUT_MS = 10_000

/**
 * The `+`-prefixed contact-URL convention is required: without it, Amazon-class sites serve a
 * metadata-less captcha page and previews silently go blank.
 */
export const FETCH_USER_AGENT = threaFetchUserAgent("Link Preview")

/** Some sites (e.g. YouTube) put meta tags 600KB+ into the response. */
export const MAX_HTML_BYTES = 512 * 1024

export const MAX_DESCRIPTION_LENGTH = 500

export const MAX_TITLE_LENGTH = 300

export function getAppOrigins(): string[] {
  const env = process.env.CORS_ALLOWED_ORIGINS
  if (env) return env.split(",").map((s) => s.trim())
  return ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"]
}

/** Tried before HTML scraping for faster, more reliable results. */
export const OEMBED_PROVIDERS: ReadonlyArray<{ pattern: RegExp; endpoint: string }> = [
  { pattern: /^https?:\/\/(?:www\.)?youtube\.com\/watch/, endpoint: "https://www.youtube.com/oembed" },
  { pattern: /^https?:\/\/youtu\.be\//, endpoint: "https://www.youtube.com/oembed" },
  { pattern: /^https?:\/\/(?:www\.)?vimeo\.com\/\d+/, endpoint: "https://vimeo.com/api/oembed.json" },
  { pattern: /^https?:\/\/(?:www\.)?loom\.com\/share\//, endpoint: "https://www.loom.com/v1/oembed" },
  {
    pattern: /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/,
    endpoint: "https://publish.twitter.com/oembed",
  },
]

export const FAVICON_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const FAVICON_RETRY_TTL_MS = 24 * 60 * 60 * 1000

export const MAX_FAVICON_BYTES = 256 * 1024

/** One deadline for every candidate of a host: the favicon fetch runs before the preview is published, so a slow icon host delays the card. */
export const FAVICON_FETCH_TIMEOUT_MS = 5_000
