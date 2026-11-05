import { describe, it, expect } from "bun:test"
import { DEFAULT_WORK_SCHEDULE, type WorkSchedule } from "@threahq/types"
import { isOutsideWorkingHours } from "./quiet-hours"

const EVENINGS: WorkSchedule = {
  days: { 0: [], 1: [{ start: "18:00", end: "22:00" }], 2: [], 3: [], 4: [], 5: [], 6: [] },
}
// Monday 2026-11-02 19:00 in Stockholm (CET, UTC+1).
const MONDAY_EVENING_STOCKHOLM = new Date("2026-11-02T18:00:00Z")

describe("isOutsideWorkingHours", () => {
  it("reads the user's own schedule over the workspace default", () => {
    const base = {
      workspaceSchedule: DEFAULT_WORK_SCHEDULE,
      deviceTimezone: "Europe/Stockholm",
      preferenceTimezone: "UTC",
      now: MONDAY_EVENING_STOCKHOLM,
    }
    expect({
      inherited: isOutsideWorkingHours({ ...base, userSchedule: null }),
      own: isOutsideWorkingHours({ ...base, userSchedule: EVENINGS }),
    }).toEqual({ inherited: true, own: false })
  })

  it("reads the device zone first, then the home timezone, skipping invalid zones", () => {
    const base = { userSchedule: null, workspaceSchedule: DEFAULT_WORK_SCHEDULE }
    // Monday 2026-11-02 16:30 UTC: 17:30 in Stockholm (after hours), 16:30 in London (working).
    const now = new Date("2026-11-02T16:30:00Z")
    expect({
      device: isOutsideWorkingHours({
        ...base,
        deviceTimezone: "Europe/Stockholm",
        preferenceTimezone: "Europe/London",
        now,
      }),
      noDevice: isOutsideWorkingHours({ ...base, deviceTimezone: null, preferenceTimezone: "Europe/London", now }),
      badDevice: isOutsideWorkingHours({
        ...base,
        deviceTimezone: "Nowhere/City",
        preferenceTimezone: "Europe/London",
        now,
      }),
      noValidZone: isOutsideWorkingHours({ ...base, deviceTimezone: null, preferenceTimezone: "Nowhere/City", now }),
    }).toEqual({ device: true, noDevice: false, badDevice: false, noValidZone: null })
  })
})
