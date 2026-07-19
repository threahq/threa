import { describe, expect, test } from "bun:test"
import { monthlyPartitionName, monthlyPartitionBounds } from "./monthly"

describe("monthlyPartitionName", () => {
  test("names by the UTC month of the date", () => {
    expect(monthlyPartitionName("access_log", new Date("2026-07-18T12:00:00Z"))).toBe("access_log_2026_07")
  })

  test("zero-pads single-digit months", () => {
    expect(monthlyPartitionName("access_log", new Date("2026-01-01T00:00:00Z"))).toBe("access_log_2026_01")
  })

  test("uses UTC, not local time — offset instants straddling the UTC month roll sort by UTC", () => {
    // Explicit offsets (not `Z`) so a local-time implementation fails regardless
    // of the runner's timezone: both instants are the same UTC wall-clock minute
    // on either side of the Aug 1 UTC boundary.
    expect(monthlyPartitionName("access_log", new Date("2026-08-01T00:30:00+02:00"))).toBe("access_log_2026_07")
    expect(monthlyPartitionName("access_log", new Date("2026-08-01T00:30:00-02:00"))).toBe("access_log_2026_08")
  })
})

describe("monthlyPartitionBounds", () => {
  test("returns half-open [first-of-month, first-of-next-month)", () => {
    expect(monthlyPartitionBounds(new Date("2026-07-18T12:00:00Z"))).toEqual({
      from: "2026-07-01",
      to: "2026-08-01",
    })
  })

  test("rolls the year at December", () => {
    expect(monthlyPartitionBounds(new Date("2026-12-15T00:00:00Z"))).toEqual({
      from: "2026-12-01",
      to: "2027-01-01",
    })
  })
})
