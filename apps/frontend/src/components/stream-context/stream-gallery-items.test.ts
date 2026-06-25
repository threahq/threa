import { describe, expect, it } from "vitest"
import type { ContextItem } from "@/lib/stream-context/types"
import { buildStreamGalleryItems, galleryFetchKind } from "./stream-gallery-items"

const base = { createdAt: "2026-06-24T10:00:00.000Z", sourceMessageId: "msg_1", snippet: "" }

const mediaImage: ContextItem = {
  ...base,
  key: "media:att_img",
  category: "media",
  mediaKind: "image",
  attachmentId: "att_img",
  giphyUrl: null,
  filename: "shot.png",
}
const mediaGiphy: ContextItem = {
  ...base,
  key: "media:giphy",
  category: "media",
  mediaKind: "gif",
  attachmentId: null,
  giphyUrl: "https://media.giphy.com/media/abc/giphy.gif",
  filename: "party",
}
const mediaVideo: ContextItem = {
  ...base,
  key: "media:att_vid",
  category: "media",
  mediaKind: "video",
  attachmentId: "att_vid",
  giphyUrl: null,
  filename: "clip.mp4",
}
const filePdf: ContextItem = {
  ...base,
  key: "file:att_pdf",
  category: "file",
  attachmentId: "att_pdf",
  fileCategory: "pdf",
  mimeType: "application/pdf",
  filename: "spec.pdf",
  sizeBytes: 10,
}
const fileZip: ContextItem = {
  ...base,
  key: "file:att_zip",
  category: "file",
  attachmentId: "att_zip",
  fileCategory: "archive",
  mimeType: "application/zip",
  filename: "bundle.zip",
  sizeBytes: 10,
}
const link: ContextItem = {
  ...base,
  key: "link:x",
  category: "link",
  url: "https://example.com",
  title: null,
  siteName: null,
  faviconUrl: null,
  imageUrl: null,
  previewKind: "generic",
  badge: null,
  refCount: 1,
}

describe("buildStreamGalleryItems", () => {
  it("includes media + previewable files in order, dropping links and non-previewable files", () => {
    const out = buildStreamGalleryItems("ws_1", [mediaImage, link, mediaGiphy, mediaVideo, filePdf, fileZip])

    expect(out.map((i) => i.type)).toEqual(["image", "image", "video", "pdf"])
    expect(out.map((i) => i.attachmentId)).toEqual([
      "att_img",
      "giphy:https://media.giphy.com/media/abc/giphy.gif",
      "att_vid",
      "att_pdf",
    ])
  })

  it("renders an uploaded image from a content url and a Giphy from its CDN url", () => {
    const [img, gif] = buildStreamGalleryItems("ws_1", [mediaImage, mediaGiphy])
    expect(img.url).toContain("att_img")
    expect(gif.url).toBe("https://media.giphy.com/media/abc/giphy.gif")
  })

  it("leaves video/document urls empty for lazy presigning, with a video thumbnail", () => {
    const [vid, pdf] = buildStreamGalleryItems("ws_1", [mediaVideo, filePdf])
    expect(vid.url).toBe("")
    expect(vid.type === "video" && vid.thumbnailUrl).toContain("att_vid")
    expect(pdf.url).toBe("")
  })
})

describe("galleryFetchKind", () => {
  it("maps gallery types to the URL kind they need", () => {
    expect(galleryFetchKind({ type: "video", url: "", thumbnailUrl: "", filename: "v", attachmentId: "a" })).toBe(
      "video"
    )
    expect(galleryFetchKind({ type: "pdf", url: "", filename: "p", attachmentId: "a" })).toBe("document")
    expect(
      galleryFetchKind({ type: "image", url: "x", thumbnailUrl: "x", filename: "i", attachmentId: "a" })
    ).toBeNull()
  })
})
