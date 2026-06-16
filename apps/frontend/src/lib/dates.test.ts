import { describe, it, expect } from "vitest"
import {
  formatISODate,
  formatDisplayDate,
  formatTime24h,
  isSameDay,
  formatRelativeTime,
  formatFullDateTime,
  formatFutureTime,
  getPastDatePresets,
  getFutureDatePresets,
  localStartOfDayISO,
} from "./dates"

describe("dates", () => {
  const fixedNow = new Date("2025-06-15T12:00:00Z")

  describe("formatISODate", () => {
    it("should format date as YYYY-MM-DD", () => {
      const date = new Date("2025-06-15T12:00:00Z")
      expect(formatISODate(date)).toBe("2025-06-15")
    })

    it("should handle single digit months and days", () => {
      const date = new Date("2025-01-05T12:00:00Z")
      expect(formatISODate(date)).toBe("2025-01-05")
    })
  })

  describe("formatDisplayDate", () => {
    it("should format date as ISO by default (YYYY-MM-DD)", () => {
      const date = new Date("2025-06-15T12:00:00Z")
      expect(formatDisplayDate(date)).toBe("2025-06-15")
    })

    it("should format date as DD/MM/YYYY when EU format specified", () => {
      const date = new Date("2025-06-15T12:00:00Z")
      expect(formatDisplayDate(date, { dateFormat: "DD/MM/YYYY" })).toBe("15/06/2025")
    })

    it("should format date as MM/DD/YYYY when US format specified", () => {
      const date = new Date("2025-01-05T12:00:00Z")
      expect(formatDisplayDate(date, { dateFormat: "MM/DD/YYYY" })).toBe("01/05/2025")
    })
  })

  describe("formatTime24h", () => {
    it("should format time in 24-hour format", () => {
      // Use local time constructor to avoid timezone issues
      const date = new Date(2025, 5, 15, 14, 30, 0)
      expect(formatTime24h(date)).toBe("14:30")
    })

    it("should pad single digit hours", () => {
      const date = new Date(2025, 5, 15, 9, 5, 0)
      expect(formatTime24h(date)).toBe("09:05")
    })

    it("should handle midnight", () => {
      const date = new Date(2025, 5, 15, 0, 0, 0)
      expect(formatTime24h(date)).toBe("00:00")
    })
  })

  describe("isSameDay", () => {
    it("should return true for same day", () => {
      // Use local time constructor to avoid timezone issues
      const a = new Date(2025, 5, 15, 10, 0, 0)
      const b = new Date(2025, 5, 15, 22, 0, 0)
      expect(isSameDay(a, b)).toBe(true)
    })

    it("should return false for different days", () => {
      const a = new Date(2025, 5, 15, 10, 0, 0)
      const b = new Date(2025, 5, 14, 10, 0, 0)
      expect(isSameDay(a, b)).toBe(false)
    })

    it("should return false for same day different month", () => {
      const a = new Date(2025, 5, 15, 10, 0, 0)
      const b = new Date(2025, 6, 15, 10, 0, 0)
      expect(isSameDay(a, b)).toBe(false)
    })
  })

  describe("formatRelativeTime", () => {
    it("should show just time for same day", () => {
      const date = new Date("2025-06-15T10:00:00Z")
      const result = formatRelativeTime(date, fixedNow)
      expect(result).toMatch(/\d{1,2}:\d{2}/)
      expect(result.toLowerCase()).not.toContain("yesterday")
    })

    it("should show 'yesterday' for yesterday", () => {
      const yesterday = new Date("2025-06-14T15:00:00Z")
      const result = formatRelativeTime(yesterday, fixedNow)
      expect(result.toLowerCase()).toContain("yesterday")
    })

    it("should show day name for dates within last week", () => {
      // Thursday, June 12 (3 days before Sunday June 15)
      const thursday = new Date("2025-06-12T10:00:00Z")
      const result = formatRelativeTime(thursday, fixedNow)
      expect(result).toMatch(/Thursday/i)
    })

    it("should show month and day for dates in same year over a week ago", () => {
      const twoWeeksAgo = new Date("2025-06-01T10:00:00Z")
      const result = formatRelativeTime(twoWeeksAgo, fixedNow)
      expect(result).toMatch(/June 1/i)
    })

    it("should show full date for dates in previous years", () => {
      const lastYear = new Date("2024-03-15T10:00:00Z")
      const result = formatRelativeTime(lastYear, fixedNow)
      expect(result).toMatch(/March 15, 2024/i)
    })
  })

  describe("formatFullDateTime", () => {
    it("should include weekday, full date, and time", () => {
      const date = new Date("2025-06-15T14:30:00Z")
      const result = formatFullDateTime(date)
      expect(result).toMatch(/Sunday/i)
      expect(result).toMatch(/June/i)
      expect(result).toMatch(/15/i)
      expect(result).toMatch(/2025/i)
    })
  })

  describe("getPastDatePresets", () => {
    it("should return array of past date presets", () => {
      const presets = getPastDatePresets(fixedNow)
      expect(presets.length).toBeGreaterThan(0)
      expect(presets[0].id).toBe("today")
      expect(presets[0].label).toBe("Today")
    })

    it("should include common past date options", () => {
      const presets = getPastDatePresets(fixedNow)
      const labels = presets.map((p) => p.label)
      expect(labels).toContain("Today")
      expect(labels).toContain("Yesterday")
      expect(labels).toContain("Last week")
      expect(labels).toContain("Last month")
    })

    it("should have correct date values", () => {
      const presets = getPastDatePresets(fixedNow)
      const today = presets.find((p) => p.id === "today")
      const yesterday = presets.find((p) => p.id === "yesterday")

      expect(formatISODate(today!.date)).toBe("2025-06-15")
      expect(formatISODate(yesterday!.date)).toBe("2025-06-14")
    })
  })

  describe("getFutureDatePresets", () => {
    it("should return array of future date presets", () => {
      const presets = getFutureDatePresets(fixedNow)
      expect(presets.length).toBeGreaterThan(0)
    })

    it("should include future-oriented options first", () => {
      const presets = getFutureDatePresets(fixedNow)
      const labels = presets.map((p) => p.label)
      expect(labels).toContain("Tomorrow")
      expect(labels).toContain("Next week")
      expect(labels).toContain("Next month")
    })

    it("should have correct date values for future dates", () => {
      const presets = getFutureDatePresets(fixedNow)
      const tomorrow = presets.find((p) => p.id === "tomorrow")

      expect(formatISODate(tomorrow!.date)).toBe("2025-06-16")
    })
  })

  describe("localStartOfDayISO", () => {
    it("converts a date-only string to the ISO instant of local midnight", () => {
      // Independent expectation: the Date(y, m, d) constructor is local-time
      expect(localStartOfDayISO("2026-06-19")).toBe(new Date(2026, 5, 19).toISOString())
    })

    it("round-trips through the date-only formatter", () => {
      const iso = localStartOfDayISO("2026-01-01")
      expect(iso).not.toBeNull()
      expect(formatISODate(new Date(iso!))).toBe("2026-01-01")
    })

    it("returns null for non-date values", () => {
      expect(localStartOfDayISO("yesterday")).toBeNull()
      expect(localStartOfDayISO("2026-06")).toBeNull()
      expect(localStartOfDayISO("2026-06-19T10:00:00Z")).toBeNull()
      expect(localStartOfDayISO("")).toBeNull()
    })
  })

  describe("formatFutureTime", () => {
    const NOW = new Date("2026-04-16T12:00:00.000Z")

    it("shows minutes for times within the next hour", () => {
      expect(formatFutureTime(new Date("2026-04-16T12:05:00.000Z"), NOW, { timeFormat: "24h" })).toBe("5m")
      expect(formatFutureTime(new Date("2026-04-16T12:47:00.000Z"), NOW, { timeFormat: "24h" })).toBe("47m")
    })

    it("clamps past dates to 0m (UI clamping per spec)", () => {
      expect(formatFutureTime(new Date("2026-04-16T11:45:00.000Z"), NOW, { timeFormat: "24h" })).toBe("0m")
    })

    it("shows absolute time for later today", () => {
      expect(formatFutureTime(new Date("2026-04-16T18:30:00.000Z"), NOW, { timeFormat: "24h" })).toBe("18:30")
    })

    it("prefixes 'tomorrow' for next-day times", () => {
      expect(formatFutureTime(new Date("2026-04-17T09:00:00.000Z"), NOW, { timeFormat: "24h" })).toBe("tomorrow 09:00")
    })

    it("shows weekday for dates 2-6 days out", () => {
      const label = formatFutureTime(new Date("2026-04-20T14:00:00.000Z"), NOW, { timeFormat: "24h" })
      expect(label).toMatch(/^Mon 14:00$/)
    })

    it("shows month+day beyond 6 days same year", () => {
      const label = formatFutureTime(new Date("2026-05-15T09:00:00.000Z"), NOW, { timeFormat: "24h" })
      expect(label).toMatch(/^May 15 09:00$/)
    })

    it("adds year suffix for different years", () => {
      const label = formatFutureTime(new Date("2099-01-01T00:00:00.000Z"), NOW, { timeFormat: "24h" })
      expect(label).toMatch(/99/)
    })

    it("respects 12h time preference", () => {
      expect(formatFutureTime(new Date("2026-04-16T18:30:00.000Z"), NOW, { timeFormat: "12h" })).toMatch(/PM|pm/i)
    })

    it("resolves 'today/tomorrow' boundaries in the user's timezone (INV-42)", () => {
      // 2026-04-17T02:00Z is still *April 16th* in Los Angeles (UTC-7), so in
      // an LA-timezoned user it's "today" not "tomorrow".
      const la = formatFutureTime(new Date("2026-04-17T02:00:00.000Z"), NOW, {
        timeFormat: "24h",
        timezone: "America/Los_Angeles",
      })
      expect(la).not.toMatch(/tomorrow/)
      // Same instant in Tokyo (UTC+9) is well into the next day.
      const tokyo = formatFutureTime(new Date("2026-04-17T02:00:00.000Z"), NOW, {
        timeFormat: "24h",
        timezone: "Asia/Tokyo",
      })
      expect(tokyo).toMatch(/tomorrow/)
    })

    it("formats same-day absolute time in the user's timezone", () => {
      // 18:30 UTC is 11:30 in LA (UTC-7).
      const label = formatFutureTime(new Date("2026-04-16T18:30:00.000Z"), NOW, {
        timeFormat: "24h",
        timezone: "America/Los_Angeles",
      })
      expect(label).toBe("11:30")
    })
  })
})
