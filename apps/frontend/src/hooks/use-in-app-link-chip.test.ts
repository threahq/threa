import { describe, it, expect } from "vitest"
import type { MessageLinkPreviewData } from "@threa/types"
import { buildMessageChipLabel } from "./use-in-app-link-chip"

function messageData(overrides: Partial<MessageLinkPreviewData>): MessageLinkPreviewData {
  return { kind: "message", accessTier: "full", ...overrides }
}

describe("buildMessageChipLabel", () => {
  it("phrases a DM as '{author} to {recipient}' with full names", () => {
    expect(
      buildMessageChipLabel(
        messageData({ streamType: "dm", authorName: "Pierre Boberg", recipientName: "Kristoffer Remback" })
      )
    ).toBe("Pierre Boberg to Kristoffer Remback")

    expect(
      buildMessageChipLabel(
        messageData({ streamType: "dm", authorName: "Kristoffer Remback", recipientName: "Pierre Boberg" })
      )
    ).toBe("Kristoffer Remback to Pierre Boberg")
  })

  it("phrases a channel message as '{author} in #slug'", () => {
    expect(
      buildMessageChipLabel(
        messageData({ streamType: "channel", authorName: "Kristoffer Remback", streamName: "tech-big-new-prop" })
      )
    ).toBe("Kristoffer Remback in #tech-big-new-prop")
  })

  it("does not double the '#' when the stream name already carries one", () => {
    expect(
      buildMessageChipLabel(messageData({ streamType: "channel", authorName: "Kris", streamName: "#general" }))
    ).toBe("Kris in #general")
  })

  it("phrases a scratchpad/thread message as '{author} in {name}' without a sigil", () => {
    expect(
      buildMessageChipLabel(messageData({ streamType: "scratchpad", authorName: "Kris", streamName: "My notes" }))
    ).toBe("Kris in My notes")
  })

  it("returns null when the author could not be resolved, so the caller falls back", () => {
    expect(buildMessageChipLabel(messageData({ streamType: "channel", streamName: "general" }))).toBeNull()
  })

  it("falls back to just the author when a DM recipient could not be resolved", () => {
    expect(buildMessageChipLabel(messageData({ streamType: "dm", authorName: "Pierre" }))).toBe("Pierre")
  })
})
