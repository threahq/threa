import { describe, test, expect } from "bun:test"
import {
  DEFAULT_WORK_SCHEDULE,
  type WorkSchedule,
  type Weekday,
  type ShiftInterval,
  parseHHMM,
  minutesToHHMM,
  isWorkingDay,
  workingDays,
  startOfWorkMinutes,
  typicalStartMinutes,
  startOfWorkForDay,
  firstWorkingWeekday,
} from "./work-schedule"

/** Build a schedule where every listed weekday gets the same shift(s). */
function schedule(days: Partial<Record<Weekday, ShiftInterval[]>>): WorkSchedule {
  const full: Record<Weekday, ShiftInterval[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
  for (const [day, shifts] of Object.entries(days)) {
    full[Number(day) as Weekday] = shifts ?? []
  }
  return { days: full }
}

const NINE_FIVE: ShiftInterval[] = [{ start: "09:00", end: "17:00" }]

describe("HH:MM parsing", () => {
  test("round-trips valid times", () => {
    expect(parseHHMM("09:00")).toBe(540)
    expect(parseHHMM("00:00")).toBe(0)
    expect(parseHHMM("23:59")).toBe(1439)
    expect(minutesToHHMM(540)).toBe("09:00")
    expect(minutesToHHMM(1439)).toBe("23:59")
  })

  test("rejects malformed times", () => {
    expect(parseHHMM("24:00")).toBeNull()
    expect(parseHHMM("9:00")).toBeNull()
    expect(parseHHMM("09:60")).toBeNull()
    expect(parseHHMM("")).toBeNull()
  })
})

describe("working-day predicates", () => {
  test("default schedule is Mon–Fri", () => {
    expect(workingDays(DEFAULT_WORK_SCHEDULE)).toEqual([1, 2, 3, 4, 5])
    expect(isWorkingDay(DEFAULT_WORK_SCHEDULE, 0)).toBe(false)
    expect(isWorkingDay(DEFAULT_WORK_SCHEDULE, 6)).toBe(false)
  })
})

describe("start of work", () => {
  test("uses earliest shift start on a day with split shifts", () => {
    const s = schedule({
      1: [
        { start: "15:00", end: "20:00" },
        { start: "08:00", end: "11:00" },
      ],
    })
    expect(startOfWorkMinutes(s, 1)).toBe(8 * 60)
  })

  test("returns null for a non-working day but falls back for the day-specific helper", () => {
    expect(startOfWorkMinutes(DEFAULT_WORK_SCHEDULE, 0)).toBeNull()
    // Sunday off → falls back to the typical (Monday) start of 09:00.
    expect(startOfWorkForDay(DEFAULT_WORK_SCHEDULE, 0)).toBe(9 * 60)
  })

  test("typical start follows the first working day", () => {
    const s = schedule({ 1: [{ start: "08:30", end: "16:00" }], 2: NINE_FIVE })
    expect(typicalStartMinutes(s)).toBe(8 * 60 + 30)
  })

  test("empty schedule falls back to 09:00", () => {
    expect(typicalStartMinutes(schedule({}))).toBe(9 * 60)
  })
})

describe("first working weekday (start of the working week)", () => {
  test("Mon–Fri starts on Monday", () => {
    expect(firstWorkingWeekday(DEFAULT_WORK_SCHEDULE)).toBe(1)
  })

  test("Sun–Thu starts on Sunday (so 'next Monday' becomes 'this Sunday')", () => {
    const s = schedule({ 0: NINE_FIVE, 1: NINE_FIVE, 2: NINE_FIVE, 3: NINE_FIVE, 4: NINE_FIVE })
    expect(firstWorkingWeekday(s)).toBe(0)
  })

  test("holed week Mon/Tue/Fri breaks the tie toward Monday", () => {
    const s = schedule({ 1: NINE_FIVE, 2: NINE_FIVE, 5: NINE_FIVE })
    expect(firstWorkingWeekday(s)).toBe(1)
  })

  test("a single working day is the start of the week", () => {
    expect(firstWorkingWeekday(schedule({ 3: NINE_FIVE }))).toBe(3)
  })

  test("all-seven defaults to Monday; empty is null", () => {
    const all = schedule({
      0: NINE_FIVE,
      1: NINE_FIVE,
      2: NINE_FIVE,
      3: NINE_FIVE,
      4: NINE_FIVE,
      5: NINE_FIVE,
      6: NINE_FIVE,
    })
    expect(firstWorkingWeekday(all)).toBe(1)
    expect(firstWorkingWeekday(schedule({}))).toBeNull()
  })
})
