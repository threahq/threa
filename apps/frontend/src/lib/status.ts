import { type StatusDuration, type StatusPreset, SYSTEM_DEFAULT_STATUSES, type WorkSchedule } from "@threa/types"
import { computeRemindAt } from "@/lib/reminder-presets"
import { formatFutureTime } from "@/lib/dates"

/**
 * Duration choices in the status picker, mirroring the scheduling presets so
 * the two surfaces feel identical. `null` means "don't auto-clear". A "custom"
 * date/time is handled separately by the picker (it produces an absolute
 * instant directly), so it is not in this list.
 */
export interface StatusDurationOption {
  id: string
  label: string
  duration: StatusDuration | null
}

export const STATUS_DURATION_OPTIONS: StatusDurationOption[] = [
  { id: "30m", label: "30 minutes", duration: { kind: "duration", minutes: 30 } },
  { id: "1h", label: "1 hour", duration: { kind: "duration", minutes: 60 } },
  { id: "4h", label: "4 hours", duration: { kind: "duration", minutes: 240 } },
  { id: "tomorrow", label: "Until tomorrow", duration: { kind: "calendar", calendar: "tomorrow-start" } },
  {
    id: "next-workday",
    label: "Until next workday",
    duration: { kind: "calendar", calendar: "next-working-day-start" },
  },
  { id: "week", label: "This week", duration: { kind: "calendar", calendar: "next-week-start" } },
  { id: "never", label: "Don't clear", duration: null },
]

/**
 * Resolve a preset duration descriptor into an absolute expiry instant (ISO),
 * or `null` for indefinite. Reuses the timezone/work-schedule-aware reminder
 * math so "until tomorrow" lands on the start of the next working day.
 */
export function statusDurationToExpiry(
  duration: StatusDuration | null,
  timezone: string,
  schedule: WorkSchedule,
  now: Date = new Date()
): string | null {
  if (!duration) return null
  return computeRemindAt(duration, now, timezone, schedule).toISOString()
}

/** Stable comparison used to preselect the duration option matching a preset. */
export function durationsEqual(a: StatusDuration | null, b: StatusDuration | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The presets a member sees in the picker: the workspace defaults (which fall
 * back to the system presets) plus the user's own custom presets, appended and
 * de-duplicated by id. Workspace/system presets win an id collision.
 */
export function mergeStatusPresets(
  workspacePresets: StatusPreset[] | undefined,
  userPresets: StatusPreset[] | undefined
): StatusPreset[] {
  const base = workspacePresets && workspacePresets.length > 0 ? workspacePresets : SYSTEM_DEFAULT_STATUSES
  const seen = new Set(base.map((p) => p.id))
  const extras = (userPresets ?? []).filter((p) => !seen.has(p.id))
  return [...base, ...extras]
}

/** Human label for when a status clears, e.g. "Clears tomorrow at 9:00 AM". */
export function formatStatusClearLabel(expiresAt: string | null, now: Date = new Date()): string | null {
  if (!expiresAt) return null
  return `Clears ${formatFutureTime(new Date(expiresAt), now)}`
}
