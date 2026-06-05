import { describe, expect, it } from "bun:test"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"
import { resolveSavedReminderPreview } from "./service"

describe("resolveSavedReminderPreview (E2EE-19)", () => {
  it("substitutes a generic label for the E2E placeholder instead of the blank zero-width char", () => {
    expect(resolveSavedReminderPreview(E2E_PLACEHOLDER_CONTENT_MARKDOWN)).toBe("🔒 Encrypted message")
  })

  it("returns the truncated body for a normal message", () => {
    expect(resolveSavedReminderPreview("hello there")).toBe("hello there")
    expect(resolveSavedReminderPreview("x".repeat(300))).toHaveLength(200)
  })

  it("returns null when there is no content", () => {
    expect(resolveSavedReminderPreview(null)).toBeNull()
    expect(resolveSavedReminderPreview(undefined)).toBeNull()
  })
})
