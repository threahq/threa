import { beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "./client"
import { attachmentContentUrl, attachmentsApi, resetAttachmentUrlCache } from "./attachments"

describe("attachmentContentUrl", () => {
  it("builds a deterministic same-origin content URL per (attachment, variant)", () => {
    expect(attachmentContentUrl("ws_1", "attach_1")).toBe("/api/workspaces/ws_1/attachments/attach_1/content")
    expect(attachmentContentUrl("ws_1", "attach_1", { variant: "thumbnail" })).toBe(
      "/api/workspaces/ws_1/attachments/attach_1/content?variant=thumbnail"
    )
  })
})

describe("attachmentsApi.getDownloadUrl", () => {
  beforeEach(() => {
    resetAttachmentUrlCache()
    vi.restoreAllMocks()
  })

  it("reuses a resolved inline URL until it expires", async () => {
    const getSpy = vi.spyOn(api, "get").mockResolvedValue({
      url: "https://example.com/attachment",
      expiresIn: 900,
    })

    await expect(attachmentsApi.getDownloadUrl("ws_1", "attach_1")).resolves.toBe("https://example.com/attachment")
    await expect(attachmentsApi.getDownloadUrl("ws_1", "attach_1")).resolves.toBe("https://example.com/attachment")

    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it("refetches once the cached URL has expired", async () => {
    vi.useFakeTimers()
    const getSpy = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce({
        url: "https://example.com/attachment-1",
        expiresIn: 1,
      })
      .mockResolvedValueOnce({
        url: "https://example.com/attachment-2",
        expiresIn: 900,
      })

    await expect(attachmentsApi.getDownloadUrl("ws_1", "attach_1")).resolves.toBe("https://example.com/attachment-1")

    await vi.advanceTimersByTimeAsync(1_100)

    await expect(attachmentsApi.getDownloadUrl("ws_1", "attach_1")).resolves.toBe("https://example.com/attachment-2")
    expect(getSpy).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })
})
