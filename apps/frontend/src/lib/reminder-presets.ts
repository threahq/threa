/**
 * Shared reminder-preset logic for the desktop hover popover, mobile sheet,
 * and Saved-view row popover. Preset math is timezone-aware via
 * `Intl.DateTimeFormat` so "Tomorrow morning" means the user's local morning,
 * not the browser's.
 *
 * Calendar presets resolve against the viewer's {@link WorkSchedule}: "morning"
 * is the start of work (replacing the old hardcoded 09:00) and "next week"
 * lands on the first working day of the next working week (replacing the old
 * hardcoded Monday — a Sun–Thu schedule resolves to Sunday).
 */
import {
  type WorkSchedule,
  type Weekday,
  type StatusDuration,
  DEFAULT_WORK_SCHEDULE,
  startOfWorkForDay,
  firstWorkingWeekday,
} from "@threa/types"

/**
 * A labelled {@link StatusDuration}: the shared duration descriptor (minutes
 * from now, or a calendar anchor) plus the display label for this surface.
 * Reusing `StatusDuration` keeps the reminder picker and the status picker on
 * one resolution path (INV-35) — `computeRemindAt` accepts either.
 */
export type ReminderPreset = { label: string } & StatusDuration

export const REMINDER_PRESETS: ReminderPreset[] = [
  { label: "In 15 minutes", kind: "duration", minutes: 15 },
  { label: "In 1 hour", kind: "duration", minutes: 60 },
  { label: "In 3 hours", kind: "duration", minutes: 180 },
  { label: "Tomorrow morning", kind: "calendar", calendar: "tomorrow-start" },
  { label: "Next week", kind: "calendar", calendar: "next-week-start" },
]

/** Resolve calendar parts (y/m/d + weekday index) as the user's timezone sees them. */
function calendarInZone(date: Date, timezone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    y: Number(get("year")),
    m: Number(get("month")) - 1,
    d: Number(get("day")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  }
}

/**
 * Build the UTC instant that a user in `timezone` would read as the given
 * local wall-clock time. Intl doesn't expose tz-offset lookup directly, so
 * we converge in two passes — enough to handle DST boundaries without a
 * dedicated date-fns-tz dep.
 *
 * The naive UTC instant (`Date.UTC(y,m,d,h,min)`) reads as `wall + offset`
 * in the target tz, so we subtract that offset to land on `wall`. The second
 * pass only fires when the offset *changed* across the adjusted instant —
 * the DST-spring-forward / fall-back case where the first-pass answer
 * straddles the transition. Without the equality guard we'd subtract the
 * offset a second time on every non-UTC tz, returning garbage.
 */
function buildZonedDate(timezone: string, y: number, m: number, d: number, hours: number, minutes: number): Date {
  let candidate = new Date(Date.UTC(y, m, d, hours, minutes))
  const readLocal = (date: Date) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date)
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0)
    return new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")))
  }
  const offset1 = readLocal(candidate).getTime() - candidate.getTime()
  candidate = new Date(candidate.getTime() - offset1)
  const offset2 = readLocal(candidate).getTime() - candidate.getTime()
  if (offset2 !== offset1) {
    // DST boundary spans the first-pass interval — apply the offset delta.
    candidate = new Date(candidate.getTime() - (offset2 - offset1))
  }
  return candidate
}

type CalendarDay = { y: number; m: number; d: number; weekday: number }

/**
 * Advance a zoned calendar date by whole days using civil-date arithmetic.
 * Adding fixed 24h chunks of milliseconds is wrong across DST transitions (a
 * fall-back day is 25h long, so `now + 24h` can read as the same local day);
 * incrementing the calendar `d` field instead always moves a whole day.
 */
function shiftCalendarDay(day: CalendarDay, delta: number): CalendarDay {
  const shifted = new Date(Date.UTC(day.y, day.m, day.d + delta))
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    weekday: (((day.weekday + delta) % 7) + 7) % 7,
  }
}

/** Build the start-of-work instant for a given local calendar day + weekday. */
function startOfWorkInstant(timezone: string, schedule: WorkSchedule, day: CalendarDay): Date {
  const minutes = startOfWorkForDay(schedule, day.weekday as Weekday)
  return buildZonedDate(timezone, day.y, day.m, day.d, Math.floor(minutes / 60), minutes % 60)
}

function nextWeekStart(now: Date, timezone: string, schedule: WorkSchedule): Date {
  const today = calendarInZone(now, timezone)
  // First working day of the week (Mon–Fri → Monday, Sun–Thu → Sunday). Empty
  // schedules fall back to Monday.
  const startWeekday = firstWorkingWeekday(schedule) ?? 1
  // Always skip into next week — if today already is the week-start day, jump a
  // full week so "Next week" never resolves to earlier today.
  const daysUntil = today.weekday === startWeekday ? 7 : (startWeekday - today.weekday + 7) % 7 || 7
  return startOfWorkInstant(timezone, schedule, shiftCalendarDay(today, daysUntil))
}

function tomorrowStart(now: Date, timezone: string, schedule: WorkSchedule): Date {
  return startOfWorkInstant(timezone, schedule, shiftCalendarDay(calendarInZone(now, timezone), 1))
}

export function computeRemindAt(
  preset: StatusDuration,
  now: Date,
  timezone: string,
  schedule: WorkSchedule = DEFAULT_WORK_SCHEDULE
): Date {
  switch (preset.kind) {
    case "duration":
      return new Date(now.getTime() + preset.minutes * 60_000)
    case "calendar":
      return preset.calendar === "tomorrow-start"
        ? tomorrowStart(now, timezone, schedule)
        : nextWeekStart(now, timezone, schedule)
  }
}
