import { describe, expect, it } from "bun:test"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN, ENCRYPTED_MESSAGE_PREVIEW_LABEL } from "@threa/types"
import { resolveSavedReminderPreview } from "./service"

describe("resolveSavedReminderPreview (E2EE-19)", () => {
  it("substitutes a generic label for the E2E placeholder instead of the blank zero-width char", () => {
    expect(resolveSavedReminderPreview(E2E_PLACEHOLDER_CONTENT_MARKDOWN)).toBe(ENCRYPTED_MESSAGE_PREVIEW_LABEL)
  })

  it("returns the truncated body for a normal message", () => {
    expect(resolveSavedReminderPreview("hello there")).toBe("hello there")
    expect(resolveSavedReminderPreview("x".repeat(300))).toHaveLength(200)
  })

  it("strips markdown so the OS notification never shows literal syntax (INV-60)", () => {
    expect(resolveSavedReminderPreview("**ship it** by [Friday](https://x.io)")).toBe("ship it by Friday")
  })

  it("returns null when there is no content", () => {
    expect(resolveSavedReminderPreview(null)).toBeNull()
    expect(resolveSavedReminderPreview(undefined)).toBeNull()
  })
})
