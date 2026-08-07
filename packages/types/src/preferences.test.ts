import { describe, expect, it } from "bun:test"
import { DEFAULT_BOARD_MASS_BADGE, DEFAULT_USER_PREFERENCES, normalizeBoardMassBadge } from "./preferences"

describe("user preference defaults", () => {
  it("inserts mobile-picked files into the message body by default", () => {
    expect(DEFAULT_USER_PREFERENCES.mobileInlineAttachments).toBe(true)
  })
})

describe("normalizeBoardMassBadge", () => {
  it("keeps a mode that still exists", () => {
    expect(normalizeBoardMassBadge("count")).toBe("count")
    expect(normalizeBoardMassBadge("off")).toBe("off")
  })

  it("reads a stored count-minutes row as the default count mode", () => {
    expect(normalizeBoardMassBadge("count-minutes")).toBe("count")
  })

  it("falls back for an unset or unknown value", () => {
    expect(normalizeBoardMassBadge(null)).toBe(DEFAULT_BOARD_MASS_BADGE)
    expect(normalizeBoardMassBadge(undefined)).toBe(DEFAULT_BOARD_MASS_BADGE)
    expect(normalizeBoardMassBadge("minutes")).toBe(DEFAULT_BOARD_MASS_BADGE)
  })

  it("is the shipped default", () => {
    expect(DEFAULT_USER_PREFERENCES.boardMassBadge).toBe(DEFAULT_BOARD_MASS_BADGE)
  })
})
