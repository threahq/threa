import { MAX_FOLLOW_UP_HORIZON_DAYS } from "../config"

const HORIZON_MS = MAX_FOLLOW_UP_HORIZON_DAYS * 24 * 60 * 60 * 1000

/**
 * Render an instant in the user's timezone for a tool result, so the model
 * confirms "I'll check back at 6:13 PM" in the user's local time rather than
 * parroting the UTC instant back at them. Includes the zone abbreviation so it's
 * unambiguous; falls back to the ISO string if the timezone is missing/invalid.
 * Shared by every follow-up tool that echoes a scheduled time.
 */
export function formatLocalTime(date: Date, timeZone: string | undefined): string {
  if (!timeZone) return date.toISOString()
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

/**
 * Validate a follow-up target time against the same rules `schedule_follow_up`
 * and `update_follow_up` share: parseable, in the future, and within the
 * horizon. `nowMs` is the turn's grounded current time (falls back to wall-clock
 * at the call site) so evals stay deterministic. Returns a model-facing error
 * string, or `null` when the time is valid.
 */
export function validateScheduledFor(scheduledFor: Date, nowMs: number): string | null {
  if (Number.isNaN(scheduledFor.getTime())) {
    return "Invalid scheduledFor — expected an ISO 8601 timestamp"
  }
  if (scheduledFor.getTime() <= nowMs) {
    return "scheduledFor must be in the future"
  }
  if (scheduledFor.getTime() > nowMs + HORIZON_MS) {
    return `scheduledFor must be within ${MAX_FOLLOW_UP_HORIZON_DAYS} days`
  }
  return null
}
