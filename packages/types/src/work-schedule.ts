// =============================================================================
// Work Schedule
// Working week + working hours, shared by user preferences (per-user override)
// and workspace settings (workspace default). Drives schedule-aware reminder /
// scheduled-message presets: "start of work" replaces the hardcoded 09:00, and
// "start of the working week" replaces the hardcoded Monday.
// =============================================================================

/** Weekday index, matching JS `Date.getDay()` (0 = Sunday … 6 = Saturday). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6]

/**
 * Weekdays in working-week reading order (Monday first, Sunday last). Used as
 * the deterministic tie-breaker when picking the start of the working week so
 * a plain Mon–Fri schedule resolves to Monday rather than some other day.
 */
export const WEEKDAYS_MONDAY_FIRST: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0]

/** A single shift within a day, as local wall-clock `"HH:MM"` (24h) strings. */
export interface ShiftInterval {
  start: string
  end: string
}

/**
 * A user's (or workspace's) working schedule. Shifts are stored per weekday, so
 * a day with an empty array is a non-working day. This one shape covers:
 *   - plain working weeks (Mon–Fri populated, Sat/Sun empty),
 *   - "holed" weeks (e.g. Mon/Tue/Fri populated, Wed/Thu empty),
 *   - split shifts / siesta (e.g. `[{08:00–11:00}, {15:00–20:00}]`),
 *   - per-day variation (short Fridays).
 */
export interface WorkSchedule {
  days: Record<Weekday, ShiftInterval[]>
}

const NINE_TO_FIVE: ShiftInterval[] = [{ start: "09:00", end: "17:00" }]

/** Mon–Fri, 09:00–17:00 — the fallback when nothing is configured. */
export const DEFAULT_WORK_SCHEDULE: WorkSchedule = {
  days: {
    0: [],
    1: [...NINE_TO_FIVE],
    2: [...NINE_TO_FIVE],
    3: [...NINE_TO_FIVE],
    4: [...NINE_TO_FIVE],
    5: [...NINE_TO_FIVE],
    6: [],
  },
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Parse `"HH:MM"` to minutes-since-midnight, or `null` if malformed. */
export function parseHHMM(value: string): number | null {
  const match = HHMM_PATTERN.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Render minutes-since-midnight back to `"HH:MM"`. */
export function minutesToHHMM(minutes: number): string {
  const clamped = ((minutes % 1440) + 1440) % 1440
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/** Shifts for a weekday, always an array (treats malformed input as empty). */
export function getDayShifts(schedule: WorkSchedule, weekday: Weekday): ShiftInterval[] {
  return schedule.days[weekday] ?? []
}

/** A weekday is a working day iff it has at least one shift. */
export function isWorkingDay(schedule: WorkSchedule, weekday: Weekday): boolean {
  return getDayShifts(schedule, weekday).length > 0
}

/** Every weekday that has at least one shift, in 0–6 order. */
export function workingDays(schedule: WorkSchedule): Weekday[] {
  return WEEKDAYS.filter((d) => isWorkingDay(schedule, d))
}

/**
 * Earliest shift start (minutes-since-midnight) on a given weekday, or `null`
 * when that day has no shifts. Callers that need a meaningful time on a
 * non-working day fall back to {@link typicalStartMinutes}.
 */
export function startOfWorkMinutes(schedule: WorkSchedule, weekday: Weekday): number | null {
  const starts = getDayShifts(schedule, weekday)
    .map((s) => parseHHMM(s.start))
    .filter((m): m is number => m !== null)
  return starts.length === 0 ? null : Math.min(...starts)
}

/**
 * A representative "when work starts" time for the schedule — the start of work
 * on the first working day of the week. Used for presets that land on a
 * non-working day (e.g. "Tomorrow morning" when tomorrow is a day off), where
 * there's no day-specific start to use. Falls back to 09:00 for an empty
 * schedule.
 */
export function typicalStartMinutes(schedule: WorkSchedule): number {
  const firstDay = firstWorkingWeekday(schedule)
  if (firstDay === null) return 9 * 60
  return startOfWorkMinutes(schedule, firstDay) ?? 9 * 60
}

/**
 * Start-of-work for a specific day: that day's earliest shift start when it's a
 * working day, otherwise the schedule's typical start so the preset still lands
 * on a sensible morning time.
 */
export function startOfWorkForDay(schedule: WorkSchedule, weekday: Weekday): number {
  return startOfWorkMinutes(schedule, weekday) ?? typicalStartMinutes(schedule)
}

/**
 * The weekday the working week "starts" on — the working day immediately
 * following the longest run of consecutive non-working days (the weekend gap),
 * read cyclically. Mon–Fri → Monday; Sun–Thu → Sunday (so "next Monday"
 * becomes "this Sunday"); Mon/Tue/Fri → Monday (tie broken toward Monday via
 * {@link WEEKDAYS_MONDAY_FIRST}). Returns `null` for an empty schedule.
 */
export function firstWorkingWeekday(schedule: WorkSchedule): Weekday | null {
  const working = new Set(workingDays(schedule))
  if (working.size === 0) return null
  if (working.size === 7) return 1 // every day worked → Monday by convention

  // For each working day, count the consecutive non-working days immediately
  // before it (wrapping around the week). The day with the largest preceding
  // gap opens the working week.
  let best: Weekday | null = null
  let bestGap = -1
  for (const day of WEEKDAYS_MONDAY_FIRST) {
    if (!working.has(day)) continue
    let gap = 0
    for (let step = 1; step <= 7; step++) {
      const prev = ((((day - step) % 7) + 7) % 7) as Weekday
      if (working.has(prev)) break
      gap++
    }
    if (gap > bestGap) {
      bestGap = gap
      best = day
    }
  }
  return best
}
