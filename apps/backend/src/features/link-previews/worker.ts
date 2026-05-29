import { logger } from "@threa/backend-common"
import type { Job, JobHandler } from "../../lib/queue"
import type { LinkPreviewExtractJobData } from "../../lib/queue/job-queue"
import type { LinkPreviewService } from "./service"
import type { LinkPreview, UpdateLinkPreviewParams } from "./repository"
import { detectContentType, isBlockedUrl, parseGitHubUrl, parseLinearUrl } from "./url-utils"
import { fetchGitHubPreview } from "./github-preview"
import { fetchLinearPreview } from "./linear-preview"
import {
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENT,
  MAX_DESCRIPTION_LENGTH,
  MAX_HTML_BYTES,
  MAX_TITLE_LENGTH,
  OEMBED_PROVIDERS,
} from "./config"
import type { WorkspaceIntegrationService } from "../workspace-integrations"

const log = logger.child({ module: "link-preview-worker" })
const TWITTER_IMAGE_FETCH_USER_AGENT = "Twitterbot/1.0"

interface WorkerDeps {
  linkPreviewService: LinkPreviewService
  workspaceIntegrationService: WorkspaceIntegrationService
}

// ── oEmbed ──────────────────────────────────────────────────────────

interface OEmbedResponse {
  title?: string
  author_name?: string
  provider_name?: string
  thumbnail_url?: string
  html?: string
}

/**
 * Try fetching structured metadata via oEmbed for known providers.
 * Returns null if the URL doesn't match any known provider or the request fails.
 */
async function tryOEmbed(url: string): Promise<UpdateLinkPreviewParams | null> {
  const provider = OEMBED_PROVIDERS.find((p) => p.pattern.test(url))
  if (!provider) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const oembedUrl = `${provider.endpoint}?format=json&url=${encodeURIComponent(url)}`
    const response = await fetch(oembedUrl, {
      headers: { "User-Agent": FETCH_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    })

    if (!response.ok) {
      response.body?.cancel()
      return null
    }

    const data = (await response.json()) as OEmbedResponse
    const oembedDescription = extractOEmbedDescription(data.html)
    const isTwitterProvider = (data.provider_name ?? "").toLowerCase() === "twitter"
    const fallbackTitle = isTwitterProvider ? (data.author_name ?? null) : null
    let fallbackImageUrl = isTwitterProvider ? await fetchOEmbedFallbackImage(url) : null
    if (!fallbackImageUrl && isTwitterProvider) {
      fallbackImageUrl = await fetchLinkedOEmbedImage(data.html)
    }

    // Derive a favicon from the provider's origin
    let faviconUrl: string | null = null
    try {
      faviconUrl = `${new URL(url).origin}/favicon.ico`
    } catch {
      /* ignore */
    }

    return {
      title: (data.title ?? fallbackTitle)?.slice(0, MAX_TITLE_LENGTH) ?? null,
      description: oembedDescription?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null,
      imageUrl: data.thumbnail_url ?? fallbackImageUrl,
      faviconUrl,
      siteName: data.provider_name ?? null,
      contentType: "website",
      status: "completed",
      expiresAt: hoursFromNow(24),
    }
  } catch (err) {
    log.debug({ err, url }, "oEmbed fetch failed, falling back to HTML")
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Extract plain-text content from oEmbed HTML payloads (used by providers like X/Twitter
 * where `title` may be omitted but tweet text is embedded in a blockquote).
 */
export function extractOEmbedDescription(html: string | undefined): string | null {
  if (!html) return null

  const paragraphMatch = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)
  const candidate = paragraphMatch?.[1] ?? html
  const withoutTags = candidate.replace(/<[^>]+>/g, " ")
  const decoded = decode(withoutTags)
  const compact = decoded?.replace(/\s+/g, " ").trim() ?? null
  return compact || null
}

function extractOEmbedLinkHrefs(html: string | undefined): string[] {
  if (!html) return []
  const urls: string[] = []
  const hrefRegex = /<a\b[^>]*href=(["'])(.*?)\1/gi
  let match: RegExpExecArray | null
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[2]?.trim()
    if (href?.startsWith("http://") || href?.startsWith("https://")) {
      urls.push(href)
    }
  }
  return urls
}

async function fetchLinkedOEmbedImage(html: string | undefined): Promise<string | null> {
  const urls = extractOEmbedLinkHrefs(html)
  const seen = new Set<string>()
  const supported = /^(https?:\/\/(?:t\.co|pic\.twitter\.com|x\.com|twitter\.com)\/)/i

  for (const candidate of urls) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (!supported.test(candidate)) continue

    const imageUrl = await fetchOEmbedFallbackImage(candidate)
    if (imageUrl) return imageUrl
  }

  return null
}

/**
 * Some X/Twitter oEmbed responses omit `thumbnail_url` even when the tweet has media.
 * In those cases, attempt one additional metadata fetch against the canonical URL and
 * read `twitter:image` / `og:image` via the same HTML parser used for generic pages.
 */
async function fetchOEmbedFallbackImage(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": TWITTER_IMAGE_FETCH_USER_AGENT,
        Accept: "text/html, application/xhtml+xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    })

    if (!response.ok) {
      response.body?.cancel()
      return null
    }

    const contentTypeHeader = response.headers.get("content-type") ?? ""
    if (contentTypeHeader.startsWith("image/")) {
      response.body?.cancel()
      return response.url || url
    }
    if (!contentTypeHeader.includes("text/html") && !contentTypeHeader.includes("application/xhtml")) {
      response.body?.cancel()
      return null
    }

    const html = await response.text()
    const metadata = await parseHtmlMeta(html.slice(0, MAX_HTML_BYTES), response.url || url)
    return metadata.imageUrl ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ── HTML metadata fetching ──────────────────────────────────────────

/**
 * Fetch OpenGraph / meta tag metadata from a URL.
 * Tries oEmbed first for known providers, then falls back to HTML parsing.
 * Runs outside of any DB transaction (INV-41).
 */
async function fetchGenericMetadata(url: string): Promise<UpdateLinkPreviewParams> {
  // Defense-in-depth SSRF check (primary filter is in extractUrls)
  if (isBlockedUrl(url)) {
    log.warn({ url }, "Blocked SSRF attempt in fetchMetadata")
    return { status: "failed", expiresAt: minutesFromNow(1) }
  }

  // Fast path: try oEmbed for known providers
  const oembedResult = await tryOEmbed(url)
  if (oembedResult) return oembedResult

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        Accept: "text/html, application/xhtml+xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    })

    // Validate the final URL after redirects to prevent SSRF via open redirects
    if (response.url && isBlockedUrl(response.url)) {
      log.warn({ url, finalUrl: response.url }, "Redirect led to blocked internal URL")
      response.body?.cancel()
      return { status: "failed", expiresAt: minutesFromNow(1) }
    }

    const contentTypeHeader = response.headers.get("content-type") ?? ""

    // For images, we don't need to parse HTML
    if (contentTypeHeader.startsWith("image/")) {
      response.body?.cancel()
      return {
        contentType: "image",
        status: "completed",
        expiresAt: hoursFromNow(24),
      }
    }

    // For PDFs, extract basic info from headers
    if (contentTypeHeader.includes("application/pdf")) {
      response.body?.cancel()
      const disposition = response.headers.get("content-disposition") ?? ""
      const filenameMatch = disposition.match(/filename[*]?="?([^";]+)"?/)
      const filename = filenameMatch?.[1] ?? new URL(url).pathname.split("/").pop() ?? "Document"

      return {
        title: decodeURIComponent(filename).replace(/\.pdf$/i, ""),
        contentType: "pdf",
        status: "completed",
        expiresAt: hoursFromNow(24),
      }
    }

    // For non-HTML content types, detect from URL extension
    if (!contentTypeHeader.includes("text/html") && !contentTypeHeader.includes("application/xhtml")) {
      response.body?.cancel()
      return { status: "completed", contentType: detectContentType(url), expiresAt: hoursFromNow(24) }
    }

    // Read HTML up to MAX_HTML_BYTES (some sites like YouTube put meta tags far into the response).
    // We collect raw bytes and defer decoding so we can honor the page's declared charset
    // (HTTP Content-Type header first, then <meta charset>/<meta http-equiv>). Not all HTML is UTF-8
    // — Swedish/European sites commonly serve ISO-8859-1 / Windows-1252.
    const reader = response.body?.getReader()
    if (!reader) return { status: "failed", expiresAt: minutesFromNow(1) }

    const chunks: Uint8Array[] = []
    let totalBytes = 0
    // Rolling ASCII view of the tail of what we've received, used only to detect </head>.
    // Latin-1 is byte-faithful for the ASCII characters in the sentinel, independent of the
    // page's true encoding.
    let asciiTail = ""
    const HEAD_CLOSE = "</head>"
    const TAIL_WINDOW = 4096
    // Streaming-SSR frameworks (Next.js App Router and friends) emit a metadata-less <head>
    // and then stream the real <title>/<meta og:*> into the <body> after </head> closes. So
    // </head> alone is not a safe stop signal — only stop once we've actually seen a metadata
    // signal. Pages that never provide one are bounded by MAX_HTML_BYTES. Scanned per-chunk
    // (not on the trimmed tail) so a signal isn't lost when a large chunk overflows the window.
    // This is a best-effort early-stop gate, not a correctness gate: a missed signal only costs
    // extra bytes (parseHtmlMeta runs on the full buffer regardless). The `name=…description`
    // arm is anchored on the value's end so body attributes like `name="descriptionField"`
    // don't flip the gate early and re-trigger the very </head> bug this guards against.
    const META_SIGNAL =
      /<title[\s>]|og:title|twitter:title|og:image|twitter:image|og:description|twitter:description|name=["']?description["'\s>]/i
    let seenMeta = false

    try {
      while (totalBytes < MAX_HTML_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        totalBytes += value.byteLength

        const chunkStr = new TextDecoder("latin1").decode(value)
        if (!seenMeta && META_SIGNAL.test(chunkStr)) seenMeta = true

        asciiTail += chunkStr
        if (asciiTail.length > TAIL_WINDOW) asciiTail = asciiTail.slice(-TAIL_WINDOW)
        if (seenMeta && asciiTail.toLowerCase().includes(HEAD_CLOSE)) break
      }
    } finally {
      reader.cancel()
    }

    const bytes = concatChunks(chunks, totalBytes)
    const html = decodeHtmlBytes(bytes, contentTypeHeader)
    return await parseHtmlMeta(html, url)
  } catch (err) {
    log.warn({ err, url }, "Failed to fetch link preview metadata")
    return { status: "failed", expiresAt: minutesFromNow(1) }
  } finally {
    clearTimeout(timeout)
  }
}

// ── HTML parsing via Bun's HTMLRewriter (lol-html) ──────────────────

/**
 * Parse OpenGraph and standard meta tags from HTML using Bun's HTMLRewriter.
 * Uses CSS selectors instead of regex for robust extraction from malformed HTML.
 */
export async function parseHtmlMeta(html: string, url: string): Promise<UpdateLinkPreviewParams> {
  const meta: Record<string, string> = {}
  let titleText = ""
  let faviconHref = ""

  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(el) {
        const content = el.getAttribute("content")
        if (!content) return

        const property = el.getAttribute("property")
        if (property) {
          // Only capture first occurrence of each property (og: takes priority)
          if (!meta[property]) meta[property] = content
          return
        }

        const name = el.getAttribute("name")
        if (name) {
          if (!meta[name]) meta[name] = content
        }
      },
    })
    .on("title", {
      text(chunk) {
        titleText += chunk.text
      },
    })
    .on('link[rel="icon"], link[rel="shortcut icon"]', {
      element(el) {
        if (!faviconHref) {
          faviconHref = el.getAttribute("href") ?? ""
        }
      },
    })

  // HTMLRewriter requires consuming the transformed response to trigger handlers
  await rewriter.transform(new Response(html)).text()

  const title = decode(meta["og:title"]) ?? decode(meta["twitter:title"]) ?? (titleText.trim() || null)
  const description =
    decode(meta["og:description"]) ?? decode(meta["twitter:description"]) ?? decode(meta["description"]) ?? null
  const imageUrl = decode(meta["og:image"]) ?? decode(meta["twitter:image"]) ?? null
  const siteName = decode(meta["og:site_name"]) ?? fallbackSiteName(url)
  const fallbackTitle = !title && !description && !imageUrl ? fallbackTitleFromUrl(url) : null

  // Resolve favicon
  let faviconUrl: string | null = null
  if (faviconHref) {
    faviconUrl = resolveUrl(faviconHref, url)
  } else {
    try {
      faviconUrl = `${new URL(url).origin}/favicon.ico`
    } catch {
      /* ignore */
    }
  }

  return {
    title: (title ?? fallbackTitle)?.slice(0, MAX_TITLE_LENGTH) ?? null,
    description: description?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null,
    imageUrl: imageUrl ? resolveUrl(imageUrl, url) : null,
    faviconUrl,
    siteName,
    contentType: "website",
    status: "completed",
    expiresAt: hoursFromNow(24),
  }
}

function fallbackSiteName(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

function fallbackTitleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const cleanedPath = parsed.pathname.replace(/\/+$/, "")
    const lastSegment = cleanedPath.split("/").filter(Boolean).at(-1)
    if (!lastSegment) return parsed.hostname.replace(/^www\./, "")

    const decoded = decodeURIComponent(lastSegment).replace(/[-_]+/g, " ").trim()
    return decoded || parsed.hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

/** Decode HTML entities in attribute values (HTMLRewriter returns raw attribute text). */
function decode(value: string | undefined): string | null {
  if (!value) return null
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00A0")
}

/**
 * Detect the character encoding of an HTML byte stream.
 *
 * Priority (mirrors the HTML Standard's encoding sniffing algorithm in spirit, simplified):
 *   1. `charset` parameter on the HTTP `Content-Type` response header.
 *   2. `<meta charset>` or `<meta http-equiv="Content-Type" content="…; charset=…">` in the first
 *      few KB of the document. These declarations are by definition ASCII-safe, so we can
 *      sniff them without knowing the final encoding yet.
 *   3. Fall back to UTF-8.
 */
export function detectCharset(contentTypeHeader: string, bytes: Uint8Array): string {
  const headerMatch = contentTypeHeader.match(/charset\s*=\s*"?([^";\s]+)"?/i)
  if (headerMatch?.[1]) return headerMatch[1].toLowerCase()

  const sampleLen = Math.min(bytes.byteLength, 4096)
  const sample = new TextDecoder("latin1").decode(bytes.subarray(0, sampleLen))

  // Matches both `<meta charset="…">` and `<meta http-equiv="Content-Type" content="…; charset=…">`.
  // The charset token can appear as a standalone attribute or nested inside the `content` value.
  const metaMatch = sample.match(/<meta\b[^>]*?charset\s*=\s*["']?([^"'>\s;/]+)/i)
  if (metaMatch?.[1]) return metaMatch[1].toLowerCase()

  return "utf-8"
}

/**
 * Decode raw HTML bytes using the charset declared by the server or the document itself.
 * Falls back to UTF-8 when the label is unknown to `TextDecoder`.
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentTypeHeader: string): string {
  const charset = detectCharset(contentTypeHeader, bytes)
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000)
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

/**
 * Create the link preview extraction worker.
 * Thin handler: extracts URLs, fetches metadata (network, INV-41),
 * then delegates DB persistence + outbox to the service (INV-6, INV-34).
 */
export function createLinkPreviewWorker(deps: WorkerDeps): JobHandler<LinkPreviewExtractJobData> {
  return async (job: Job<LinkPreviewExtractJobData>) => {
    const { workspaceId, messageId, streamId, contentMarkdown, isEdit } = job.data

    log.info({ messageId, workspaceId, isEdit }, "Processing link previews for message")

    // 1. Extract URLs and create pending records (DB work via service)
    //    For edits, clear old junction rows first so stale previews are removed.
    const pendingPreviews = isEdit
      ? await deps.linkPreviewService.replacePreviewsForMessage(workspaceId, messageId, contentMarkdown)
      : await deps.linkPreviewService.extractAndCreatePending(workspaceId, messageId, contentMarkdown)

    if (pendingPreviews.length === 0) {
      // For edits with no URLs, publish empty set so frontend clears stale previews
      if (isEdit) {
        await deps.linkPreviewService.publishEmptyPreviews(workspaceId, streamId, messageId)
      }
      log.debug({ messageId, isEdit }, "No URLs found in message")
      return
    }

    // 2. Check which previews are already cached, then fetch metadata for the rest
    //    Network work runs outside any DB transaction (INV-41)
    //    Message link previews are already completed at insert time — skip fetch entirely.
    const fetchResults = await Promise.allSettled(
      pendingPreviews.map(async (p) => {
        const existing = await deps.linkPreviewService.getPreviewById(workspaceId, p.id)
        if (!existing) {
          return { id: p.id, skipped: true }
        }
        if (existing.contentType === "message_link") {
          return { id: p.id, skipped: true }
        }
        const isGitHubUrl = parseGitHubUrl(p.url) !== null
        const isLinearUrl = !isGitHubUrl && parseLinearUrl(p.url) !== null
        const isProviderUrl = isGitHubUrl || isLinearUrl
        const shouldAttemptProviderUpgrade = isProviderUrl && existing.previewType === null

        if (isPreviewCacheFresh(existing) && !shouldAttemptProviderUpgrade) {
          return { id: p.id, skipped: true }
        }

        let providerMetadata = null
        if (isGitHubUrl) {
          providerMetadata = await fetchGitHubPreview(workspaceId, p.url, deps.workspaceIntegrationService)
        } else if (isLinearUrl) {
          providerMetadata = await fetchLinearPreview(workspaceId, p.url, deps.workspaceIntegrationService)
        }

        if (existing.previewType && providerMetadata === null) {
          return { id: p.id, skipped: true }
        }
        if (shouldAttemptProviderUpgrade && providerMetadata === null && isPreviewCacheFresh(existing)) {
          return { id: p.id, skipped: true }
        }

        const metadata = providerMetadata ?? (await fetchGenericMetadata(p.url))

        return { id: p.id, metadata, skipped: false, overwrite: existing.status !== "pending" }
      })
    )

    // 3. Collect settled results, delegate persistence + outbox to service (INV-6)
    const settled = fetchResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))

    await deps.linkPreviewService.completePreviewsAndPublish(workspaceId, streamId, messageId, settled, {
      forcePublish: isEdit,
    })

    log.info({ messageId, count: pendingPreviews.length }, "Link preview extraction complete")
  }
}

function isPreviewCacheFresh(preview: LinkPreview): boolean {
  if (!preview.expiresAt) {
    return preview.status === "completed"
  }
  return preview.expiresAt.getTime() > Date.now()
}
