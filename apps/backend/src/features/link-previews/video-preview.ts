import type { VideoPreview, VideoPreviewProvider } from "@threa/types"
import { VideoPreviewProviders, VideoPreviewTypes } from "@threa/types"
import { MAX_TITLE_LENGTH } from "./config"
import type { UpdateLinkPreviewParams } from "./repository"

/** Landscape 16:9, the default when a provider gives no dimensions. */
const DEFAULT_VIDEO_ASPECT_RATIO = 16 / 9

/** How long a completed video preview stays fresh before the worker refetches. */
const VIDEO_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000

export interface VideoProviderMatch {
  provider: VideoPreviewProvider
  videoId: string
  /**
   * Player URL on a trusted per-provider origin, built purely from `videoId`.
   * Twitch players additionally require a `parent` query param matching the
   * host — the frontend appends that at play time (it can't be known here).
   */
  embedUrl: string
}

/** Metadata harvested from oEmbed or HTML, folded into the stored VideoPreview. */
export interface VideoMetaSource {
  title: string | null
  posterUrl: string | null
  authorName: string | null
  width: number | null
  height: number | null
  siteName: string | null
  faviconUrl: string | null
}

// YouTube ids are exactly 11 url-safe base64 chars; the tight shape stops a junk
// path segment from being templated into an embed src.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID = /^\d+$/
const LOOM_ID = /^[A-Za-z0-9]{16,64}$/
const TWITCH_VOD_ID = /^\d+$/
const TWITCH_CLIP_SLUG = /^[A-Za-z0-9_-]+$/

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, "").replace(/^m\./, "")
}

function detectYouTube(url: URL, host: string): VideoProviderMatch | null {
  let id: string | undefined
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0]
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v") ?? undefined
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)
      id = match?.[1]
    }
  }
  if (!id || !YOUTUBE_ID.test(id)) return null
  return {
    provider: VideoPreviewProviders.YOUTUBE,
    videoId: id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
  }
}

function detectVimeo(url: URL, host: string): VideoProviderMatch | null {
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null
  const segments = url.pathname.split("/").filter(Boolean)
  // Vimeo nests the numeric id at the tail of several shapes: /<id>,
  // /video/<id>, /channels/<name>/<id>, /groups/<name>/videos/<id>.
  const id = [...segments].reverse().find((s) => VIMEO_ID.test(s))
  if (!id) return null
  return { provider: VideoPreviewProviders.VIMEO, videoId: id, embedUrl: `https://player.vimeo.com/video/${id}` }
}

function detectLoom(url: URL, host: string): VideoProviderMatch | null {
  if (host !== "loom.com") return null
  const match = url.pathname.match(/^\/(?:share|embed)\/([^/]+)/)
  const id = match?.[1]
  if (!id || !LOOM_ID.test(id)) return null
  return { provider: VideoPreviewProviders.LOOM, videoId: id, embedUrl: `https://www.loom.com/embed/${id}` }
}

function detectTwitch(url: URL, host: string): VideoProviderMatch | null {
  if (host === "clips.twitch.tv") {
    // /embed?clip=<slug> or /<slug>
    const slug = url.searchParams.get("clip") ?? url.pathname.split("/").filter(Boolean).pop()
    if (!slug || slug === "embed" || !TWITCH_CLIP_SLUG.test(slug)) return null
    return {
      provider: VideoPreviewProviders.TWITCH,
      videoId: slug,
      embedUrl: `https://clips.twitch.tv/embed?clip=${slug}`,
    }
  }
  if (host !== "twitch.tv") return null
  const segments = url.pathname.split("/").filter(Boolean)
  if (segments[0] === "videos" && segments[1] && TWITCH_VOD_ID.test(segments[1])) {
    return {
      provider: VideoPreviewProviders.TWITCH,
      videoId: segments[1],
      embedUrl: `https://player.twitch.tv/?video=${segments[1]}`,
    }
  }
  // /<channel>/clip/<slug>
  const clipIndex = segments.indexOf("clip")
  if (clipIndex >= 0 && segments[clipIndex + 1] && TWITCH_CLIP_SLUG.test(segments[clipIndex + 1])) {
    const slug = segments[clipIndex + 1]
    return {
      provider: VideoPreviewProviders.TWITCH,
      videoId: slug,
      embedUrl: `https://clips.twitch.tv/embed?clip=${slug}`,
    }
  }
  return null
}

/**
 * Classify a URL as an embeddable video and return the trusted embed URL built
 * from the parsed id. Returns null for anything that isn't a supported video
 * link. The returned `embedUrl` never derives from provider-supplied markup.
 */
export function detectVideoProvider(rawUrl: string): VideoProviderMatch | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  const host = stripWww(url.hostname.toLowerCase())

  return detectYouTube(url, host) ?? detectVimeo(url, host) ?? detectLoom(url, host) ?? detectTwitch(url, host) ?? null
}

/**
 * Build the `UpdateLinkPreviewParams` for a matched video link. `imageUrl`
 * mirrors the poster so non-video surfaces (that only read `imageUrl`) still
 * show a thumbnail. Aspect ratio comes from provider dimensions when present,
 * else falls back to 16:9 so the card can reserve a fixed box (INV-21).
 */
export function buildVideoPreviewParams(
  match: VideoProviderMatch,
  url: string,
  meta: VideoMetaSource,
  fetchedAt: string
): UpdateLinkPreviewParams {
  const aspectRatio =
    meta.width && meta.height && meta.height > 0 ? meta.width / meta.height : DEFAULT_VIDEO_ASPECT_RATIO
  const title = meta.title?.slice(0, MAX_TITLE_LENGTH) ?? null

  const preview: VideoPreview = {
    type: VideoPreviewTypes.VIDEO,
    url,
    provider: match.provider,
    videoId: match.videoId,
    embedUrl: match.embedUrl,
    posterUrl: meta.posterUrl,
    aspectRatio,
    title,
    authorName: meta.authorName,
    fetchedAt,
  }

  return {
    title,
    description: null,
    imageUrl: meta.posterUrl,
    faviconUrl: meta.faviconUrl,
    siteName: meta.siteName,
    contentType: "video",
    previewType: VideoPreviewTypes.VIDEO,
    previewData: preview,
    status: "completed",
    expiresAt: new Date(Date.now() + VIDEO_PREVIEW_TTL_MS),
  }
}
