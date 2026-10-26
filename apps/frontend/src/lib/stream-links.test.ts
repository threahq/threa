import { describe, it, expect, vi, beforeEach } from "vitest"
import { toast } from "sonner"
import {
  buildStreamLink,
  copyStreamLink,
  buildConversationLink,
  buildConversationPanelPath,
  copyConversationLink,
  splitThreadAnchor,
} from "./stream-links"

describe("buildStreamLink", () => {
  it("builds an absolute main-view URL from workspace and stream ids", () => {
    expect(buildStreamLink("ws_1", "stream_abc")).toBe(`${window.location.origin}/w/ws_1/s/stream_abc`)
  })
})

describe("buildConversationLink", () => {
  it("builds a board-hosted conversation panel URL", () => {
    expect(buildConversationLink("ws_1", "conv_1")).toBe(`${window.location.origin}/w/ws_1/board?panel=conv:conv_1`)
  })

  it("deep-links to a single message via ?m= when a messageId is given", () => {
    expect(buildConversationLink("ws_1", "conv_1", "msg_9")).toBe(
      `${window.location.origin}/w/ws_1/board?panel=conv:conv_1&m=msg_9`
    )
  })
})

describe("buildConversationPanelPath", () => {
  it("returns the origin-less router path the saved/activity Links consume", () => {
    expect(buildConversationPanelPath("ws_1", "conv_1")).toBe("/w/ws_1/board?panel=conv:conv_1")
  })

  it("carries the deep-link message id", () => {
    expect(buildConversationPanelPath("ws_1", "conv_1", "msg_9")).toBe("/w/ws_1/board?panel=conv:conv_1&m=msg_9")
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

describe("copyConversationLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("writes the conversation link to the clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const success = vi.spyOn(toast, "success").mockReturnValue("" as ReturnType<typeof toast.success>)

    await copyConversationLink("ws_1", "conv_1", "msg_9")

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/w/ws_1/board?panel=conv:conv_1&m=msg_9`)
    expect(success).toHaveBeenCalledWith("Link copied")
  })

  it("reports an error toast when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    Object.assign(navigator, { clipboard: { writeText } })
    const error = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)

    await copyConversationLink("ws_1", "conv_1")

    expect(error).toHaveBeenCalledWith("Failed to copy link")
  })
})

describe("splitThreadAnchor", () => {
  it("routes a doc block id to blockId and any other anchor to eventAnchorId", () => {
    const block = "blk_01HZY3K8W5Q9V7XG2M4N6P8R0T"
    expect({
      block: splitThreadAnchor(block),
      message: splitThreadAnchor("msg_01HZY3K8W5Q9V7XG2M4N6P8R0T"),
      card: splitThreadAnchor("event_01HZY3K8W5Q9V7XG2M4N6P8R0T"),
      malformedBlock: splitThreadAnchor("blk_not-a-ulid"),
      none: splitThreadAnchor(undefined),
    }).toEqual({
      block: { blockId: block, eventAnchorId: null },
      message: { blockId: null, eventAnchorId: "msg_01HZY3K8W5Q9V7XG2M4N6P8R0T" },
      card: { blockId: null, eventAnchorId: "event_01HZY3K8W5Q9V7XG2M4N6P8R0T" },
      malformedBlock: { blockId: null, eventAnchorId: "blk_not-a-ulid" },
      none: { blockId: null, eventAnchorId: null },
    })
  })
})
