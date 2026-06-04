import { describe, it, expect, vi, beforeEach } from "vitest"
import { toast } from "sonner"
import { buildStreamLink, copyStreamLink } from "./stream-links"

describe("buildStreamLink", () => {
  it("builds an absolute main-view URL from workspace and stream ids", () => {
    expect(buildStreamLink("ws_1", "stream_abc")).toBe(`${window.location.origin}/w/ws_1/s/stream_abc`)
  })
})

describe("copyStreamLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("writes the stream link to the clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const success = vi.spyOn(toast, "success").mockReturnValue("" as ReturnType<typeof toast.success>)

    await copyStreamLink("ws_1", "stream_abc")

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/w/ws_1/s/stream_abc`)
    expect(success).toHaveBeenCalledWith("Link copied")
  })

  it("reports an error toast when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    Object.assign(navigator, { clipboard: { writeText } })
    const error = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)

    await copyStreamLink("ws_1", "stream_abc")

    expect(error).toHaveBeenCalledWith("Failed to copy link")
  })
})
