import { describe, it, expect } from "bun:test"
import { setStatusSchema, statusPresetSchema, statusDurationSchema } from "./schemas"

describe("setStatusSchema", () => {
  it("accepts an emoji-only status", () => {
    const result = setStatusSchema.safeParse({ emoji: "dart", text: null, expiresAt: null })
    expect(result.success).toBe(true)
  })

  it("accepts a text-only status and trims it", () => {
    const result = setStatusSchema.safeParse({ emoji: null, text: "  Focusing  ", expiresAt: null })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.text).toBe("Focusing")
  })

  it("rejects an empty status (no emoji, blank text)", () => {
    expect(setStatusSchema.safeParse({ emoji: null, text: "   ", expiresAt: null }).success).toBe(false)
    expect(setStatusSchema.safeParse({ emoji: null, text: null, expiresAt: null }).success).toBe(false)
  })

  it("accepts an ISO expiry and rejects a non-ISO one", () => {
    expect(
      setStatusSchema.safeParse({ emoji: "dart", text: null, expiresAt: "2026-06-04T13:00:00.000Z" }).success
    ).toBe(true)
    expect(setStatusSchema.safeParse({ emoji: "dart", text: null, expiresAt: "soon" }).success).toBe(false)
  })
})

describe("statusDurationSchema", () => {
  it("accepts duration and calendar variants", () => {
    expect(statusDurationSchema.safeParse({ kind: "duration", minutes: 60 }).success).toBe(true)
    expect(statusDurationSchema.safeParse({ kind: "calendar", calendar: "tomorrow-start" }).success).toBe(true)
  })

  it("rejects a non-positive or unknown calendar value", () => {
    expect(statusDurationSchema.safeParse({ kind: "duration", minutes: 0 }).success).toBe(false)
    expect(statusDurationSchema.safeParse({ kind: "calendar", calendar: "never" }).success).toBe(false)
  })
})

describe("statusPresetSchema", () => {
  it("accepts a valid preset with an indefinite duration", () => {
    const result = statusPresetSchema.safeParse({
      id: "focus",
      emoji: "dart",
      text: "Focus mode",
      defaultDuration: null,
    })
    expect(result.success).toBe(true)
  })

  it("rejects a preset with neither emoji nor text", () => {
    const result = statusPresetSchema.safeParse({ id: "x", emoji: null, text: null, defaultDuration: null })
    expect(result.success).toBe(false)
  })
})
