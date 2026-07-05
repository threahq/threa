import { describe, expect, it } from "vitest"
import { customDurationToDate } from "./custom-duration-picker"

describe("customDurationToDate", () => {
  const now = new Date("2026-01-01T12:00:00.000Z")

  it("treats numbers as minutes by default surface unit", () => {
    expect(customDurationToDate(30, "minutes", now)?.toISOString()).toBe("2026-01-01T12:30:00.000Z")
  })

  it("supports hours", () => {
    expect(customDurationToDate(2, "hours", now)?.toISOString()).toBe("2026-01-01T14:00:00.000Z")
  })

  it("rejects non-positive durations", () => {
    expect(customDurationToDate(0, "minutes", now)).toBeNull()
  })

  it("rejects date overflows", () => {
    expect(customDurationToDate(9e15, "minutes", now)).toBeNull()
  })
})
