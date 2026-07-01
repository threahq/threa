import type { GitHubPreview, LinearPreview, VideoPreview, VideoPreviewProvider } from "@threa/types"

/**
 * Narrow a link preview's `previewData` union to the video-embed variant.
 * Video previews carry `type === "video"`; GitHub/Linear use prefixed types.
 */
export function isVideoPreview(
  preview: GitHubPreview | LinearPreview | VideoPreview | null | undefined
): preview is VideoPreview {
  return !!preview && preview.type === "video"
}

/**
 * Build the iframe `src` for click-to-play. Appends the provider's autoplay
 * param (playback is only ever started after an explicit user gesture) and,
 * for Twitch, the required `parent` matching the current host. `embedUrl` is a
 * trusted per-provider origin baked server-side from the parsed video id, so
 * appending query params here is safe.
 */
export function buildEmbedPlaybackSrc(embedUrl: string, provider: VideoPreviewProvider): string {
  try {
    const url = new URL(embedUrl)
    if (provider === "twitch") {
      url.searchParams.set("autoplay", "true")
      url.searchParams.set("parent", window.location.hostname)
    } else {
      url.searchParams.set("autoplay", "1")
    }
    return url.toString()
  } catch {
    return embedUrl
  }
}

export function videoPlaybackSrc(preview: VideoPreview): string {
  return buildEmbedPlaybackSrc(preview.embedUrl, preview.provider)
}
