import { describe, it, expect } from "bun:test"
import { resolveActiveStatus, isStatusContentful, SYSTEM_DEFAULT_STATUSES, STATUS_TEXT_MAX_LENGTH } from "./user-status"

describe("isStatusContentful", () => {
  it("requires an emoji or non-empty text", () => {
    expect(isStatusContentful({ emoji: null, text: null })).toBe(false)
    expect(isStatusContentful({ emoji: null, text: "   " })).toBe(false)
    expect(isStatusContentful({ emoji: "dart", text: null })).toBe(true)
    expect(isStatusContentful({ emoji: null, text: "Focusing" })).toBe(true)
    expect(isStatusContentful({ emoji: "dart", text: "Focusing" })).toBe(true)
  })
})

describe("resolveActiveStatus", () => {
  const now = new Date("2026-06-04T12:00:00Z")

  it("returns null when there is no content", () => {
    expect(resolveActiveStatus({ statusEmoji: null, statusText: null, statusExpiresAt: null }, now)).toBeNull()
  })

  it("returns the status when indefinite", () => {
    expect(resolveActiveStatus({ statusEmoji: "dart", statusText: "Focus", statusExpiresAt: null }, now)).toEqual({
      emoji: "dart",
      text: "Focus",
      expiresAt: null,
    })
  })

  it("masks a status whose expiry has passed", () => {
    const expired = new Date(now.getTime() - 60_000).toISOString()
    expect(resolveActiveStatus({ statusEmoji: "dart", statusText: "Focus", statusExpiresAt: expired }, now)).toBeNull()
  })

  it("keeps a status whose expiry is still in the future", () => {
    const future = new Date(now.getTime() + 60_000).toISOString()
    const result = resolveActiveStatus({ statusEmoji: null, statusText: "Out", statusExpiresAt: future }, now)
    expect(result).toEqual({ emoji: null, text: "Out", expiresAt: future })
  })
})

describe("SYSTEM_DEFAULT_STATUSES", () => {
  it("are all contentful, uniquely identified, and within the text bound", () => {
    const ids = new Set<string>()
    for (const preset of SYSTEM_DEFAULT_STATUSES) {
      expect(isStatusContentful(preset)).toBe(true)
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
      if (preset.text) expect(preset.text.length).toBeLessThanOrEqual(STATUS_TEXT_MAX_LENGTH)
    }
  })

  it("matches the product-specified defaults", () => {
    expect(SYSTEM_DEFAULT_STATUSES.map((p) => p.text)).toEqual([
      "Focus mode",
      "Out and about",
      "Out of office",
      "Do not disturb",
      "Parental leave",
    ])
    const focus = SYSTEM_DEFAULT_STATUSES[0]
    expect(focus.defaultDuration).toEqual({ kind: "duration", minutes: 60 })
    const ooo = SYSTEM_DEFAULT_STATUSES[2]
    expect(ooo.defaultDuration).toEqual({ kind: "calendar", calendar: "tomorrow-start" })
    expect(SYSTEM_DEFAULT_STATUSES[3].defaultDuration).toBeNull()
  })
})
