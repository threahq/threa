import { describe, it, expect } from "bun:test"
import {
  isValidIanaTimezone,
  getUtcOffset,
  parseUtcOffsetMinutes,
  hasSameOffset,
  formatTime,
  formatDate,
  getDateKey,
  monthRangeInTimezone,
  formatCurrentTime,
  buildTemporalPromptSection,
  type TemporalContext,
  type ParticipantTemporal,
} from "./temporal"

describe("temporal utilities", () => {
  describe("monthRangeInTimezone", () => {
    const NOW = new Date("2026-07-14T12:00:00.000Z")

    it("computes the [start, end) month window as UTC instants of local midnights", () => {
      expect(monthRangeInTimezone("UTC", NOW)).toEqual({
        start: new Date("2026-07-01T00:00:00.000Z"),
        end: new Date("2026-08-01T00:00:00.000Z"),
      })
      // CEST is UTC+2 in July: local July starts at June 30 22:00 UTC
      expect(monthRangeInTimezone("Europe/Stockholm", NOW)).toEqual({
        start: new Date("2026-06-30T22:00:00.000Z"),
        end: new Date("2026-07-31T22:00:00.000Z"),
      })
      // JST is UTC+9 year-round
      expect(monthRangeInTimezone("Asia/Tokyo", NOW)).toEqual({
        start: new Date("2026-06-30T15:00:00.000Z"),
        end: new Date("2026-07-31T15:00:00.000Z"),
      })
      // PDT is UTC-7 in July
      expect(monthRangeInTimezone("America/Los_Angeles", NOW)).toEqual({
        start: new Date("2026-07-01T07:00:00.000Z"),
        end: new Date("2026-08-01T07:00:00.000Z"),
      })
    })

    it("crosses a year boundary and a DST change inside the month", () => {
      // Dec 14 in Stockholm (CET, UTC+1); local instant near UTC midnight
      // still resolves to the local month
      expect(monthRangeInTimezone("Europe/Stockholm", new Date("2026-12-14T12:00:00.000Z"))).toEqual({
        start: new Date("2026-11-30T23:00:00.000Z"),
        end: new Date("2026-12-31T23:00:00.000Z"),
      })
      // October 2026 in Stockholm spans the CEST→CET fallback: start is +2, end is +1
      expect(monthRangeInTimezone("Europe/Stockholm", new Date("2026-10-10T12:00:00.000Z"))).toEqual({
        start: new Date("2026-09-30T22:00:00.000Z"),
        end: new Date("2026-10-31T23:00:00.000Z"),
      })
    })

    it("resolves 'today' by the zone's wall clock, not UTC", () => {
      // 2026-07-31T23:30Z is already August 1 in Tokyo
      const { start } = monthRangeInTimezone("Asia/Tokyo", new Date("2026-07-31T23:30:00.000Z"))
      expect(start).toEqual(new Date("2026-07-31T15:00:00.000Z"))
    })
  })

  describe("isValidIanaTimezone", () => {
    it("accepts real IANA identifiers", () => {
      expect(isValidIanaTimezone("Europe/Stockholm")).toBe(true)
      expect(isValidIanaTimezone("America/New_York")).toBe(true)
      expect(isValidIanaTimezone("UTC")).toBe(true)
    })

    it("rejects garbage, empty, and oversized input", () => {
      expect(isValidIanaTimezone("Not/AZone")).toBe(false)
      expect(isValidIanaTimezone("")).toBe(false)
      expect(isValidIanaTimezone("<script>")).toBe(false)
      expect(isValidIanaTimezone("x".repeat(65))).toBe(false)
    })
  })

  describe("getUtcOffset", () => {
    it("should return UTC offset for a timezone", () => {
      const date = new Date("2026-01-06T12:00:00Z")
      const offset = getUtcOffset("America/New_York", date)
      // New York is UTC-5 in winter
      expect(offset).toBe("UTC-5")
    })

    it("should handle UTC timezone", () => {
      const date = new Date("2026-01-06T12:00:00Z")
      const offset = getUtcOffset("UTC", date)
      expect(offset).toBe("UTC+0")
    })

    it("should handle positive offsets", () => {
      const date = new Date("2026-01-06T12:00:00Z")
      const offset = getUtcOffset("Europe/Stockholm", date)
      // Stockholm is UTC+1 in winter
      expect(offset).toBe("UTC+1")
    })

    it("should fallback to UTC+0 for invalid timezone", () => {
      const offset = getUtcOffset("Invalid/Timezone")
      expect(offset).toBe("UTC+0")
    })
  })

  describe("parseUtcOffsetMinutes", () => {
    it("should parse positive UTC offset", () => {
      expect(parseUtcOffsetMinutes("UTC+1")).toBe(60)
      expect(parseUtcOffsetMinutes("UTC+5")).toBe(300)
    })

    it("should parse negative UTC offset", () => {
      expect(parseUtcOffsetMinutes("UTC-5")).toBe(-300)
      expect(parseUtcOffsetMinutes("UTC-8")).toBe(-480)
    })

    it("should parse zero offset", () => {
      expect(parseUtcOffsetMinutes("UTC+0")).toBe(0)
    })

    it("should parse half-hour offsets", () => {
      expect(parseUtcOffsetMinutes("UTC+5:30")).toBe(330)
      expect(parseUtcOffsetMinutes("UTC-9:30")).toBe(-570)
    })

    it("should return 0 for invalid format", () => {
      expect(parseUtcOffsetMinutes("invalid")).toBe(0)
      expect(parseUtcOffsetMinutes("GMT+5")).toBe(0)
    })
  })

  describe("hasSameOffset", () => {
    it("should return true for empty array", () => {
      expect(hasSameOffset([])).toBe(true)
    })

    it("should return true when all offsets are the same", () => {
      expect(hasSameOffset(["UTC+1", "UTC+1", "UTC+1"])).toBe(true)
    })

    it("should return false when offsets differ", () => {
      expect(hasSameOffset(["UTC+1", "UTC+3"])).toBe(false)
    })

    it("should return true for single offset", () => {
      expect(hasSameOffset(["UTC+5"])).toBe(true)
    })
  })

  describe("formatTime", () => {
    it("should format time in 24h format", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      const time = formatTime(date, "UTC", "24h")
      expect(time).toBe("14:30")
    })

    it("should format time in 12h format", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      const time = formatTime(date, "UTC", "12h")
      expect(time).toBe("2:30 PM")
    })

    it("should respect timezone", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      const time = formatTime(date, "America/New_York", "24h")
      // New York is UTC-5 in winter, so 14:30 UTC = 09:30 EST
      expect(time).toBe("09:30")
    })
  })

  describe("formatDate", () => {
    it("should format date in ISO format (YYYY-MM-DD)", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      expect(formatDate(date, "UTC", "YYYY-MM-DD")).toBe("2026-01-06")
    })

    it("should format date in EU format (DD/MM/YYYY)", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      expect(formatDate(date, "UTC", "DD/MM/YYYY")).toBe("06/01/2026")
    })

    it("should format date in US format (MM/DD/YYYY)", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      expect(formatDate(date, "UTC", "MM/DD/YYYY")).toBe("01/06/2026")
    })

    it("should respect timezone for date boundaries", () => {
      // 2026-01-07T01:00:00Z is still Jan 6 in New York (UTC-5)
      const date = new Date("2026-01-07T01:00:00Z")
      expect(formatDate(date, "America/New_York", "YYYY-MM-DD")).toBe("2026-01-06")
      expect(formatDate(date, "UTC", "YYYY-MM-DD")).toBe("2026-01-07")
    })
  })

  describe("getDateKey", () => {
    it("should return ISO date string for grouping", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      expect(getDateKey(date, "UTC")).toBe("2026-01-06")
    })
  })

  describe("formatCurrentTime", () => {
    it("should format current time with date and time", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      const result = formatCurrentTime(date, "UTC", "YYYY-MM-DD", "24h")
      expect(result).toBe("2026-01-06 14:30")
    })

    it("should use user's preferred formats", () => {
      const date = new Date("2026-01-06T14:30:00Z")
      const result = formatCurrentTime(date, "UTC", "DD/MM/YYYY", "12h")
      expect(result).toBe("06/01/2026 2:30 PM")
    })
  })

  describe("buildTemporalPromptSection", () => {
    const baseContext: TemporalContext = {
      currentTime: "2026-01-06T14:30:00Z",
      timezone: "UTC",
      utcOffset: "UTC+0",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "24h",
    }

    it("should build simple time section without participants", () => {
      const section = buildTemporalPromptSection(baseContext)
      expect(section).toContain("Current time: 2026-01-06 14:30")
      expect(section).toContain("invocation-time definition of now")
      expect(section).toContain("not your training cutoff date")
      expect(section).toContain("not the stream creation date")
      expect(section).toContain("Resolve relative times silently")
      expect(section).toContain("use 24-hour format")
    })

    it("should include 12-hour format instruction when timeFormat is 12h", () => {
      const context: TemporalContext = {
        ...baseContext,
        timeFormat: "12h",
      }
      const section = buildTemporalPromptSection(context)
      expect(section).toContain("use 12-hour format")
      expect(section).toContain("2:30 PM")
    })

    it("should build simple section when all participants have same offset", () => {
      const participants: ParticipantTemporal[] = [
        { id: "1", name: "Alice", timezone: "UTC", utcOffset: "UTC+0" },
        { id: "2", name: "Bob", timezone: "UTC", utcOffset: "UTC+0" },
      ]
      const section = buildTemporalPromptSection(baseContext, participants)
      expect(section).toContain("Current time: 2026-01-06 14:30")
      expect(section).not.toContain("Participant timezones")
    })

    it("should show participant offsets when timezones differ", () => {
      const context: TemporalContext = {
        ...baseContext,
        timezone: "Europe/London",
        utcOffset: "UTC+0",
      }
      const participants: ParticipantTemporal[] = [
        { id: "1", name: "Alice", timezone: "Europe/Stockholm", utcOffset: "UTC+1" },
        { id: "2", name: "Bob", timezone: "America/New_York", utcOffset: "UTC-5" },
      ]
      const section = buildTemporalPromptSection(context, participants)
      expect(section).toContain("canonical")
      expect(section).toContain("Participant timezones")
      expect(section).toContain("Alice: UTC+1")
      expect(section).toContain("Bob: UTC-5")
    })
  })
})
