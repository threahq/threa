import { describe, expect, it } from "bun:test"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN, ENCRYPTED_MESSAGE_PREVIEW_LABEL } from "@threahq/types"
import { resolvePushPreview } from "./service"

describe("resolvePushPreview", () => {
  it("substitutes a generic label for the E2E placeholder instead of the blank zero-width char (E2EE-19)", () => {
    expect(resolvePushPreview(E2E_PLACEHOLDER_CONTENT_MARKDOWN)).toBe(ENCRYPTED_MESSAGE_PREVIEW_LABEL)
  })

  it("returns the truncated body for a normal message", () => {
    expect(resolvePushPreview("hello there")).toBe("hello there")
    expect(resolvePushPreview("x".repeat(300))).toHaveLength(200)
  })

  it("strips markdown so the OS notification never shows literal syntax (INV-60)", () => {
    expect(resolvePushPreview("**ship it** by [Friday](https://x.io)")).toBe("ship it by Friday")
  })

  it("renders mentions and channel links as their display text", () => {
    expect(resolvePushPreview("[@kris](user:usr_1) see [#general](channel:stream_1)")).toBe("@kris see #general")
  })

  it("resolves emoji shortcodes and keeps unknown ones as text", () => {
    expect(resolvePushPreview(":wave: hi :white_check_mark: :custom_party:")).toBe("👋 hi ✅ :custom_party:")
  })

  it("flattens multi-line bodies onto one line", () => {
    expect(resolvePushPreview("# Title\n\n> quoted\nplain")).toBe("Title quoted plain")
  })

  it("returns null when there is no content", () => {
    expect(resolvePushPreview(null)).toBeNull()
    expect(resolvePushPreview(undefined)).toBeNull()
  })
})
