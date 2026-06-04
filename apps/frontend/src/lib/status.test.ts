import { describe, it, expect } from "vitest"
import { DEFAULT_WORK_SCHEDULE, SYSTEM_DEFAULT_STATUSES, type StatusPreset } from "@threa/types"
import {
  STATUS_DURATION_OPTIONS,
  durationsEqual,
  mergeStatusPresets,
  statusDurationToExpiry,
  formatStatusClearLabel,
} from "./status"

describe("statusDurationToExpiry", () => {
  const now = new Date("2026-06-04T12:00:00Z")

  it("returns null for an indefinite duration", () => {
    expect(statusDurationToExpiry(null, "UTC", DEFAULT_WORK_SCHEDULE, now)).toBeNull()
  })

  it("adds minutes for a duration preset", () => {
    const expiry = statusDurationToExpiry({ kind: "duration", minutes: 60 }, "UTC", DEFAULT_WORK_SCHEDULE, now)
    expect(expiry).toBe(new Date("2026-06-04T13:00:00Z").toISOString())
  })

  it("resolves a calendar preset to the next working day's start", () => {
    // 2026-06-04 is a Thursday; tomorrow-start lands on Friday 09:00 local (UTC here).
    const expiry = statusDurationToExpiry(
      { kind: "calendar", calendar: "tomorrow-start" },
      "UTC",
      DEFAULT_WORK_SCHEDULE,
      now
    )
    expect(expiry).toBe(new Date("2026-06-05T09:00:00Z").toISOString())
  })
})

describe("durationsEqual", () => {
  it("compares duration descriptors structurally", () => {
    expect(durationsEqual(null, null)).toBe(true)
    expect(durationsEqual({ kind: "duration", minutes: 60 }, { kind: "duration", minutes: 60 })).toBe(true)
    expect(durationsEqual({ kind: "duration", minutes: 60 }, { kind: "duration", minutes: 30 })).toBe(false)
    expect(durationsEqual(null, { kind: "duration", minutes: 60 })).toBe(false)
  })

  it("every preset's defaultDuration maps to a known duration option", () => {
    for (const preset of SYSTEM_DEFAULT_STATUSES) {
      const match = STATUS_DURATION_OPTIONS.find((o) => durationsEqual(o.duration, preset.defaultDuration))
      expect(match).toBeDefined()
    }
  })
})

describe("mergeStatusPresets", () => {
  const custom: StatusPreset = { id: "status_custom", emoji: "coffee", text: "Coffee", defaultDuration: null }

  it("falls back to system presets when the workspace has none", () => {
    expect(mergeStatusPresets(undefined, [])).toEqual(SYSTEM_DEFAULT_STATUSES)
    expect(mergeStatusPresets([], [])).toEqual(SYSTEM_DEFAULT_STATUSES)
  })

  it("appends user presets additively after the workspace defaults", () => {
    const merged = mergeStatusPresets(SYSTEM_DEFAULT_STATUSES, [custom])
    expect(merged).toHaveLength(SYSTEM_DEFAULT_STATUSES.length + 1)
    expect(merged.at(-1)).toEqual(custom)
  })

  it("drops a user preset that collides with a workspace id", () => {
    const collide: StatusPreset = { id: "focus", emoji: "zzz", text: "Nope", defaultDuration: null }
    const merged = mergeStatusPresets(SYSTEM_DEFAULT_STATUSES, [collide])
    expect(merged.filter((p) => p.id === "focus")).toHaveLength(1)
    expect(merged.find((p) => p.id === "focus")?.text).toBe("Focus mode")
  })
})

describe("formatStatusClearLabel", () => {
  it("returns null for an indefinite status", () => {
    expect(formatStatusClearLabel(null)).toBeNull()
  })

  it("describes when the status clears", () => {
    const now = new Date("2026-06-04T12:00:00Z")
    const label = formatStatusClearLabel(new Date("2026-06-04T13:00:00Z").toISOString(), now)
    expect(label).toMatch(/^Clears /)
  })
})
