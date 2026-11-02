import { describe, expect, it } from "vitest"
import { conversationChipLabel } from "./conversation-chip-label"

describe("conversationChipLabel", () => {
  it.each([
    [true, "Loading encrypted conversation"],
    [false, "Encrypted conversation"],
  ])("never falls back to legacy attrs.name for an E2E link (pending=%s)", (pending, expected) => {
    expect(
      conversationChipLabel({
        accessTier: "full",
        resolvedName: null,
        isE2e: true,
        pending,
      })
    ).toBe(expected)
  })

  it("uses a generic label until a privacy-safe non-E2E title resolves", () => {
    expect(
      conversationChipLabel({
        accessTier: "full",
        resolvedName: null,
        isE2e: false,
        pending: false,
      })
    ).toBe("Conversation")
  })
})
