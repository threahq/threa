import { describe, expect, it } from "vitest"
import { giphyGalleryId, isGiphyGalleryId } from "./giphy-gallery-id"

describe("giphy gallery id", () => {
  it("round-trips a recognizable sentinel for a CDN url", () => {
    const id = giphyGalleryId("https://media.giphy.com/media/abc/giphy.gif")
    expect(isGiphyGalleryId(id)).toBe(true)
    expect(id).toContain("https://media.giphy.com/media/abc/giphy.gif")
  })

  it("does not classify a real attachment id as Giphy", () => {
    expect(isGiphyGalleryId("attach_01HXYZ")).toBe(false)
  })
})
