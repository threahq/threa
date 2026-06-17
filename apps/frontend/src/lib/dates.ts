/**
 * Centralized date utilities. All date formatting goes through this module so
 * user date/time-format preferences apply consistently and ad-hoc Date
 * manipulation doesn't scatter across the codebase.
 */
import {
  format,
  subDays,
  subWeeks,
  subMonths,
  subYears,
  addDays,
  addWeeks,
  addMonths,
  isSameDay as dateFnsIsSameDay,
  differenceInDays,
  startOfDay,
} from "date-fns"
import type { DateFormat, TimeFormat } from "@threa/types"

const DATE_FORMAT_MAP: Record<DateFormat, string> = {
  "YYYY-MM-DD": "yyyy-MM-dd",
  "DD/MM/YYYY": "dd/MM/yyyy",
  "MM/DD/YYYY": "MM/dd/yyyy",
}

interface DatePrefs {
  dateFormat?: DateFormat
}

interface TimePrefs {
  timeFormat?: TimeFormat
  /** IANA timezone (e.g. "America/New_York"); falls back to system local when absent. */
  timezone?: string
}

/**
 * Format a date as ISO date string (YYYY-MM-DD), for filter values and API calls.
 */
export function formatISODate(date: Date): string {
  return format(date, "yyyy-MM-dd")
}

/**
 * Format a date according to user preferences
 * (e.g., "2025-01-15", "15/01/2025", or "01/15/2025").
 */
export function formatDisplayDate(date: Date, prefs?: DatePrefs): string {
  const dateFormat = prefs?.dateFormat ?? "YYYY-MM-DD"
  return format(date, DATE_FORMAT_MAP[dateFormat])
}

/**
 * Format time according to user preferences (e.g., "14:30" or "2:30 PM").
 */
export function formatTime(date: Date, prefs?: TimePrefs): string {
  return format(date, prefs?.timeFormat === "12h" ? "h:mm a" : "HH:mm")
}

/**
 * Format time in 24-hour format (legacy, prefer formatTime with prefs).
 * Example: "14:30"
 */
export function formatTime24h(date: Date): string {
  return format(date, "HH:mm")
}

export { isSameDay as dateFnsIsSameDay }

export function isSameDay(a: Date, b: Date): boolean {
  return dateFnsIsSameDay(a, b)
}

/**
 * Local start-of-day timestamp (ms) — the stable per-day key for grouping
 * timeline rows into day buckets in the device's timezone (INV-42).
 */
export function localStartOfDayMs(date: Date): number {
  return startOfDay(date).getTime()
}

interface RelativeTimeOptions {
  /** Use terse format (e.g., "2m ago") vs verbose (e.g., "yesterday 14:30") */
  terse?: boolean
}

/**
 * Format a date relative to now.
 *
 * Verbose (default): "yesterday 14:30", "Monday 09:00" - includes time
 * Terse: "2m ago", "1h ago", "yesterday" - compact, no time
 */
export function formatRelativeTime(
  date: Date,
  now: Date = new Date(),
  prefs?: TimePrefs,
  options?: RelativeTimeOptions
): string {
  const terse = options?.terse ?? false

  if (terse) {
    return formatRelativeTimeTerse(date, now)
  }

  return formatRelativeTimeVerbose(date, now, prefs)
}

/** Verbose format: includes time (e.g., "yesterday 14:30", "Monday 09:00") */
function formatRelativeTimeVerbose(date: Date, now: Date, prefs?: TimePrefs): string {
  const time = formatTime(date, prefs)

  if (isSameDay(date, now)) {
    return time
  }

  // Days difference relative to the `now` parameter, not system time.
  const daysAgo = differenceInDays(startOfDay(now), startOfDay(date))

  if (daysAgo === 1) {
    return `yesterday ${time}`
  }

  if (daysAgo < 7 && daysAgo > 0) {
    const dayName = date.toLocaleDateString(undefined, { weekday: "long" })
    return `${dayName} ${time}`
  }

  if (date.getFullYear() === now.getFullYear()) {
    const monthDay = date.toLocaleDateString(undefined, { month: "long", day: "numeric" })
    return `${monthDay} ${time}`
  }

  const fullDate = date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  })
  return `${fullDate} ${time}`
}

/** Terse format: compact, no time (e.g., "2m ago", "yesterday") */
function formatRelativeTimeTerse(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)

  if (diffSec < 60) {
    return "now"
  }

  if (diffMin < 60) {
    return `${diffMin}m ago`
  }

  if (diffHour < 24) {
    return `${diffHour}h ago`
  }

  // Days difference relative to the `now` parameter, not system time.
  const daysAgo = differenceInDays(startOfDay(now), startOfDay(date))

  if (daysAgo === 1) {
    return "yesterday"
  }

  if (daysAgo < 7 && daysAgo > 0) {
    return date.toLocaleDateString(undefined, { weekday: "short" })
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  })
}

/**
 * Format a full date-time for tooltips.
 * Uses user preferences for time format.
 * Example: "Wednesday, January 15, 2025, 14:30" or "Wednesday, January 15, 2025, 2:30 PM"
 */
export function formatFullDateTime(date: Date, prefs?: TimePrefs): string {
  const datePart = date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })
  const timePart = formatTime(date, prefs)
  return `${datePart}, ${timePart}`
}

/**
 * Label for an in-stream day divider, in the device's local calendar (INV-42).
 *
 *   today                 → "Today"
 *   yesterday             → "Yesterday"
 *   same calendar year    → "Monday, June 16"
 *   other year            → "Monday, June 16, 2024"
 *
 * Future days (rare — clock skew, a message dated ahead) fall through to the
 * absolute date. Weekday/month names come from the runtime locale.
 */
export function formatDayDivider(date: Date, now: Date = new Date()): string {
  if (isSameDay(date, now)) return "Today"

  const daysAgo = differenceInDays(startOfDay(now), startOfDay(date))
  if (daysAgo === 1) return "Yesterday"

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
  }
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })
}

/**
 * Extract y/m/d in a specific IANA timezone without extra deps. Intl is a
 * native, timezone-aware formatter; parsing its numeric parts gives the
 * user-local calendar day for boundary comparisons.
 */
function calendarDayInZone(date: Date, timezone: string | undefined): { y: number; m: number; d: number } {
  if (!timezone) {
    return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() }
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return { y: get("year"), m: get("month") - 1, d: get("day") }
}

function sameCalendarDay(a: Date, b: Date, timezone: string | undefined): boolean {
  const dayA = calendarDayInZone(a, timezone)
  const dayB = calendarDayInZone(b, timezone)
  return dayA.y === dayB.y && dayA.m === dayB.m && dayA.d === dayB.d
}

function calendarDaysBetween(from: Date, to: Date, timezone: string | undefined): number {
  if (!timezone) {
    return differenceInDays(startOfDay(to), startOfDay(from))
  }
  const a = calendarDayInZone(from, timezone)
  const b = calendarDayInZone(to, timezone)
  // Construct UTC dates for the two calendar days so differenceInDays handles
  // month/year rollover correctly regardless of the source timezone.
  const aDate = new Date(Date.UTC(a.y, a.m, a.d))
  const bDate = new Date(Date.UTC(b.y, b.m, b.d))
  return Math.round((bDate.getTime() - aDate.getTime()) / 86_400_000)
}

/**
 * Format a future timestamp as a compact relative-or-absolute string, in the
 * user's timezone (INV-42).
 *
 *   within next hour        → "Nm"   (5m, 47m, 0m = firing now-ish)
 *   today (>= 1h)           → "HH:mm" (user timeFormat + timezone)
 *   tomorrow                → "tomorrow HH:mm"
 *   within next 6 days      → "<weekday> HH:mm" (e.g. "Fri 09:00")
 *   beyond 6 days same year → "MMM d HH:mm" (e.g. "Apr 22 14:30")
 *   different year          → "MMM d, yy HH:mm"
 *
 * Past dates clamp to "now" (0m). The spec's UI clamping — we never render a
 * reminder time that's already elapsed even if the server hasn't fired yet.
 */
export function formatFutureTime(date: Date, now: Date = new Date(), prefs?: TimePrefs): string {
  const deltaMs = date.getTime() - now.getTime()
  const tz = prefs?.timezone

  if (deltaMs < 60 * 60_000) {
    const mins = Math.max(0, Math.ceil(deltaMs / 60_000))
    return `${mins}m`
  }

  const timeStr = formatTimeInZone(date, prefs)

  if (sameCalendarDay(date, now, tz)) {
    return timeStr
  }

  const daysAhead = calendarDaysBetween(now, date, tz)
  if (daysAhead === 1) return `tomorrow ${timeStr}`
  if (daysAhead >= 2 && daysAhead <= 6) {
    return `${formatPartInZone(date, tz, { weekday: "short" })} ${timeStr}`
  }

  const sameYear = calendarDayInZone(date, tz).y === calendarDayInZone(now, tz).y
  if (sameYear) {
    return `${formatPartInZone(date, tz, { month: "short", day: "numeric" })} ${timeStr}`
  }
  return `${formatPartInZone(date, tz, { month: "short", day: "numeric", year: "2-digit" })} ${timeStr}`
}

function formatTimeInZone(date: Date, prefs?: TimePrefs): string {
  if (!prefs?.timezone) return formatTime(date, prefs)
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: prefs.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: prefs.timeFormat === "12h",
  }
  return new Intl.DateTimeFormat(prefs.timeFormat === "12h" ? "en-US" : "en-GB", opts).format(date)
}

function formatPartInZone(date: Date, timezone: string | undefined, opts: Intl.DateTimeFormatOptions): string {
  if (!timezone) {
    // Map Intl options back to date-fns tokens for the system-local path so
    // tests on runners without a fixed TZ get stable output.
    if (opts.weekday === "short") return format(date, "EEE")
    if (opts.year === "2-digit") return format(date, "MMM d, yy")
    return format(date, "MMM d")
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...opts }).format(date)
}

export interface DatePreset {
  id: string
  label: string
  date: Date
}

/**
 * Get past date presets for "after:" filters.
 * Shows dates you might want to search after (looking back in time).
 */
export function getPastDatePresets(now: Date = new Date()): DatePreset[] {
  return [
    { id: "today", label: "Today", date: now },
    { id: "yesterday", label: "Yesterday", date: subDays(now, 1) },
    { id: "last-week", label: "Last week", date: subWeeks(now, 1) },
    { id: "last-month", label: "Last month", date: subMonths(now, 1) },
    { id: "last-3-months", label: "Last 3 months", date: subMonths(now, 3) },
    { id: "last-year", label: "Last year", date: subYears(now, 1) },
  ]
}

/**
 * Get future date presets for "before:" filters.
 * Shows dates you might want to search before (upper bounds).
 *
 * Note: "before:" typically means "messages sent before this date",
 * so we show a mix of past and future to allow flexible filtering.
 */
export function getFutureDatePresets(now: Date = new Date()): DatePreset[] {
  return [
    { id: "tomorrow", label: "Tomorrow", date: addDays(now, 1) },
    { id: "next-week", label: "Next week", date: addWeeks(now, 1) },
    { id: "next-month", label: "Next month", date: addMonths(now, 1) },
    { id: "today", label: "Today", date: now },
    { id: "yesterday", label: "Yesterday", date: subDays(now, 1) },
    { id: "last-week", label: "Last week", date: subWeeks(now, 1) },
  ]
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "150ms", "2.3s", "1m 30s"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

const padTwo = (n: number) => String(n).padStart(2, "0")

/** YYYY-MM-DD in local time — the shape `<input type="date">` expects. */
export function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`
}

/** HH:mm in local time — the shape `<input type="time">` expects. */
export function toTimeInputValue(date: Date): string {
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`
}

/** YYYY-MM-DDTHH:mm in local time — the shape `<input type="datetime-local">` expects. */
export function toDateTimeLocalValue(date: Date): string {
  return `${toDateInputValue(date)}T${toTimeInputValue(date)}`
}

/**
 * Parse the YYYY-MM-DD + HH:mm pair produced by split native pickers into a
 * Date (interpreted in the local timezone, matching `<input type="datetime-local">`).
 * Returns null when either half is empty or the combined string is invalid.
 */
export function parseLocalDateTime(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null
  const parsed = new Date(`${dateStr}T${timeStr}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Convert a date-only string (YYYY-MM-DD) to the ISO instant where that
 * calendar date starts in the device's local timezone. Used to widen the
 * date-only search filter syntax (`before:2026-06-19`) into the full ISO
 * datetimes the search API validates, anchored to the searcher's own day
 * boundaries. Returns null for anything that isn't a date-only string.
 */
export function localStartOfDayISO(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  return parseLocalDateTime(dateStr, "00:00")?.toISOString() ?? null
}

/**
 * Future-time label for surfaces that count down toward an imminent send —
 * scheduled message rows, the in-composer popover, etc. Wraps `formatFutureTime`
 * but collapses the sub-1m window ("0m" / "1m") to "Sending soon" so we don't
 * render a stressful 0m countdown while the worker is still claiming the row.
 */
export function formatSendCountdown(date: Date, now: Date = new Date(), prefs?: TimePrefs): string {
  const deltaMs = date.getTime() - now.getTime()
  if (deltaMs <= 60_000) return "Sending soon"
  return formatFutureTime(date, now, prefs)
}

export { subDays, subWeeks, subMonths, subYears, addDays, addWeeks, addMonths, format }
