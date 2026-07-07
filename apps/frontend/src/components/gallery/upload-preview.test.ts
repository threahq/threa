import { describe, it, expect } from "vitest"
import type { GalleryItem } from "@/components/image-gallery"
import { buildPendingGalleryItem, uploadGalleryType } from "./upload-preview"
import { isPendingGalleryId } from "./pending-gallery-id"

// One representative uploaded file per gallery type — keyed on GalleryItem["type"]
// so adding a new gallery type is a COMPILE error here until someone decides
// whether an uploaded file previews as it (a fixture) or can never be one (null).
// This is the drift guard: the composer's previewable set can't fall behind the
// gallery's renderable set without failing this file.
const FIXTURE_BY_TYPE: Record<GalleryItem["type"], { mimeType: string; filename: string } | null> = {
  image: { mimeType: "image/png", filename: "shot.png" },
  video: { mimeType: "video/mp4", filename: "clip.mp4" },
  // Link-preview iframe — no attachment bytes, so it can never come from an upload.
  "video-embed": null,
  pdf: { mimeType: "application/pdf", filename: "report.pdf" },
  markdown: { mimeType: "text/markdown", filename: "notes.md" },
  html: { mimeType: "text/html", filename: "page.html" },
  text: { mimeType: "text/plain", filename: "log.txt" },
}

const ALL_TYPES = Object.keys(FIXTURE_BY_TYPE) as GalleryItem["type"][]

describe("uploadGalleryType", () => {
  for (const type of ALL_TYPES) {
    const fixture = FIXTURE_BY_TYPE[type]
    if (fixture) {
      it(`classifies a ${type} upload`, () => {
        expect(uploadGalleryType(fixture)).toBe(type)
      })
    } else {
      it(`never produces ${type} from an upload`, () => {
        const producible = ALL_TYPES.map((t) => FIXTURE_BY_TYPE[t])
          .filter((f): f is NonNullable<typeof f> => f !== null)
          .map((f) => uploadGalleryType(f))
        expect(producible).not.toContain(type)
      })
    }
  }

  it("returns null for non-previewable files", () => {
    expect(uploadGalleryType({ mimeType: "application/zip", filename: "archive.zip" })).toBeNull()
    expect(uploadGalleryType({ mimeType: "application/octet-stream", filename: "data.bin" })).toBeNull()
  })

  it("classifies by extension when the mime is octet-stream", () => {
    expect(uploadGalleryType({ mimeType: "application/octet-stream", filename: "clip.mov" })).toBe("video")
    expect(uploadGalleryType({ mimeType: "application/octet-stream", filename: "report.pdf" })).toBe("pdf")
    expect(uploadGalleryType({ mimeType: "application/octet-stream", filename: "index.ts" })).toBe("text")
  })

  it("treats a .ts file as text, not an mp2t video", () => {
    expect(uploadGalleryType({ mimeType: "video/mp2t", filename: "module.ts" })).toBe("text")
  })
})

describe("buildPendingGalleryItem", () => {
  it("builds an image item that self-thumbnails, tagged with the pending sentinel", () => {
    const item = buildPendingGalleryItem("image", "blob:x", "shot.png", "blob:x")
    expect(item).toMatchObject({ type: "image", url: "blob:x", thumbnailUrl: "blob:x", filename: "shot.png" })
    expect(isPendingGalleryId(item.attachmentId)).toBe(true)
  })

  it("builds a video item with an empty poster (no client-side thumbnail pre-send)", () => {
    const item = buildPendingGalleryItem("video", "blob:v", "clip.mp4", "blob:v")
    expect(item).toMatchObject({ type: "video", url: "blob:v", thumbnailUrl: "", filename: "clip.mp4" })
  })

  it("builds document items without a thumbnail field", () => {
    for (const type of ["pdf", "markdown", "html", "text"] as const) {
      const item = buildPendingGalleryItem(type, "blob:d", `f.${type}`, "blob:d")
      expect(item).toMatchObject({ type, url: "blob:d", filename: `f.${type}` })
      expect("thumbnailUrl" in item).toBe(false)
    }
  })
})
