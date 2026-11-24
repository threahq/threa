import { describe, expect, it } from "bun:test"
import { isVideoAttachment } from "./config"

describe("isVideoAttachment", () => {
  it("accepts video MIME types", () => {
    expect(isVideoAttachment("video/mp4", "upload.bin")).toBe(true)
  })

  it("accepts known video extensions even when MIME detection is generic or vendor-specific", () => {
    expect(isVideoAttachment("application/octet-stream", "clip.MOV")).toBe(true)
    expect(isVideoAttachment("application/x-matroska", "clip.mkv")).toBe(true)
  })

  it("rejects non-video files", () => {
    expect(isVideoAttachment("application/pdf", "document.pdf")).toBe(false)
  })

  it("rejects audio MIME types even with a video-container extension", () => {
    expect(isVideoAttachment("audio/webm", "voice.webm")).toBe(false)
  })
})
