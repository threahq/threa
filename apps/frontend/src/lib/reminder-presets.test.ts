import { describe, test, expect } from "vitest"
import { type WorkSchedule, type Weekday, type ShiftInterval } from "@threa/types"
import { computeRemindAt, type ReminderPreset } from "./reminder-presets"

function schedule(days: Partial<Record<Weekday, ShiftInterval[]>>): WorkSchedule {
  const full: Record<Weekday, ShiftInterval[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
  for (const [day, shifts] of Object.entries(days)) full[Number(day) as Weekday] = shifts ?? []
  return { days: full }
}

const MON_FRI_9 = schedule({
  1: [{ start: "09:00", end: "17:00" }],
  2: [{ start: "09:00", end: "17:00" }],
  3: [{ start: "09:00", end: "17:00" }],
  4: [{ start: "09:00", end: "17:00" }],
  5: [{ start: "09:00", end: "17:00" }],
})

const SUN_THU_8 = schedule({
  0: [{ start: "08:00", end: "16:00" }],
  1: [{ start: "08:00", end: "16:00" }],
  2: [{ start: "08:00", end: "16:00" }],
  3: [{ start: "08:00", end: "16:00" }],
  4: [{ start: "08:00", end: "16:00" }],
})

// Wednesday 2026-06-03, noon UTC.
const NOW = new Date("2026-06-03T12:00:00Z")
const TZ = "UTC"

const tomorrow: ReminderPreset = { label: "Tomorrow morning", kind: "calendar", calendar: "tomorrow-start" }
const nextWeek: ReminderPreset = { label: "Next week", kind: "calendar", calendar: "next-week-start" }

describe("computeRemindAt — duration presets", () => {
  test("are schedule- and timezone-invariant", () => {
    const preset: ReminderPreset = { label: "In 1 hour", kind: "duration", minutes: 60 }
    expect(computeRemindAt(preset, NOW, TZ, MON_FRI_9).toISOString()).toBe("2026-06-03T13:00:00.000Z")
  })
})

describe("computeRemindAt — working hours (start of work)", () => {
  test("Tomorrow lands at the start of work, not a hardcoded 9am", () => {
    // Thursday is a working day in both; start time follows the schedule.
    expect(computeRemindAt(tomorrow, NOW, TZ, MON_FRI_9).toISOString()).toBe("2026-06-04T09:00:00.000Z")
    expect(computeRemindAt(tomorrow, NOW, TZ, SUN_THU_8).toISOString()).toBe("2026-06-04T08:00:00.000Z")
  })
})

describe("computeRemindAt — working week (next week)", () => {
  test("Mon–Fri resolves Next week to Monday", () => {
    expect(computeRemindAt(nextWeek, NOW, TZ, MON_FRI_9).toISOString()).toBe("2026-06-08T09:00:00.000Z")
  })

  test("Sun–Thu resolves Next week to 'this Sunday' (the working-week start)", () => {
    // From Wednesday, the next working week starts on the coming Sunday (06-07),
    // before the Monday that a hardcoded preset would have used.
    expect(computeRemindAt(nextWeek, NOW, TZ, SUN_THU_8).toISOString()).toBe("2026-06-07T08:00:00.000Z")
  })
})
