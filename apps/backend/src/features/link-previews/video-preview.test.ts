import { describe, expect, test } from "bun:test"
import type { VideoPreviewProvider } from "@threahq/types"
import { buildVideoPreviewParams, detectVideoProvider } from "./video-preview"

describe("detectVideoProvider", () => {
  const cases: Array<[string, VideoPreviewProvider, string, string]> = [
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "youtube",
      "dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    [
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "youtube",
      "dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "youtube",
      "dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    ["https://vimeo.com/76979871", "vimeo", "76979871", "https://player.vimeo.com/video/76979871"],
    ["https://player.vimeo.com/video/76979871", "vimeo", "76979871", "https://player.vimeo.com/video/76979871"],
    ["https://vimeo.com/channels/staffpicks/76979871", "vimeo", "76979871", "https://player.vimeo.com/video/76979871"],
    [
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
      "loom",
      "0123456789abcdef0123456789abcdef",
      "https://www.loom.com/embed/0123456789abcdef0123456789abcdef",
    ],
    ["https://www.twitch.tv/videos/123456789", "twitch", "123456789", "https://player.twitch.tv/?video=123456789"],
    [
      "https://www.twitch.tv/somestreamer/clip/HappyClipSlug-abc123",
      "twitch",
      "HappyClipSlug-abc123",
      "https://clips.twitch.tv/embed?clip=HappyClipSlug-abc123",
    ],
    [
      "https://clips.twitch.tv/HappyClipSlug-abc123",
      "twitch",
      "HappyClipSlug-abc123",
      "https://clips.twitch.tv/embed?clip=HappyClipSlug-abc123",
    ],
  ]
  test.each(cases)("classifies %s", (url, provider, videoId, embedUrl) => {
    expect(detectVideoProvider(url)).toEqual({ provider, videoId, embedUrl })
  })

  test.each([
    ["https://example.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=short"], // id too short
    ["https://www.youtube.com/watch?list=PLxyz"], // no v param
    ["https://vimeo.com/about"], // no numeric id
    ["https://vimeo.com/blog/12345"], // non-video page with an incidental numeric segment
    ["https://vimeo.com/settings/67890"], // settings page, not a video
    ["https://www.loom.com/share/tiny"], // id too short
    ["https://www.twitch.tv/somestreamer"], // bare channel, not a VOD/clip
    ["https://www.twitch.tv/clip/videos/12345"], // channel named "clip" browsing VODs — not a clip
    ["javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ"],
    ["not a url"],
  ])("returns null for %s", (url) => {
    expect(detectVideoProvider(url)).toBeNull()
  })

  test("embed URL is always reconstructed from the parsed id, never from surrounding junk", () => {
    // Even with an attacker-controlled query/fragment, the embed origin is fixed.
    const match = detectVideoProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ&evil=<script>")
    expect(match?.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")
  })
})

describe("buildVideoPreviewParams", () => {
  const match = detectVideoProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!
  const fetchedAt = "2026-07-01T00:00:00.000Z"

  test("produces a completed video preview whose embed URL comes from the match, not oEmbed html", () => {
    const params = buildVideoPreviewParams(
      match,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      {
        title: "Never Gonna Give You Up",
        posterUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        authorName: "Rick Astley",
        width: 480,
        height: 270,
        siteName: "YouTube",
        faviconUrl: "https://www.youtube.com/favicon.ico",
      },
      fetchedAt
    )

    expect(params).toEqual({
      title: "Never Gonna Give You Up",
      description: null,
      imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      faviconUrl: "https://www.youtube.com/favicon.ico",
      siteName: "YouTube",
      contentType: "video",
      previewType: "video",
      previewData: {
        type: "video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        posterUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        aspectRatio: 480 / 270,
        title: "Never Gonna Give You Up",
        authorName: "Rick Astley",
        fetchedAt,
      },
      status: "completed",
      expiresAt: expect.any(Date),
    })
  })

  test("falls back to 16:9 when the provider gives no usable dimensions", () => {
    const params = buildVideoPreviewParams(
      match,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      { title: null, posterUrl: null, authorName: null, width: null, height: 0, siteName: null, faviconUrl: null },
      fetchedAt
    )
    expect((params.previewData as { aspectRatio: number }).aspectRatio).toBe(16 / 9)
  })
})
