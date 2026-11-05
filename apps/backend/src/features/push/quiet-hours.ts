import { isWithinWorkingHours, type WorkSchedule } from "@threahq/types"
import { isValidIanaTimezone } from "../../lib/temporal"

/**
 * Whether `now` is outside the user's effective working hours: their own
 * schedule, else the workspace default, read in the device's zone (kept fresh
 * by socket heartbeats), else the home timezone preference. Null when neither
 * zone is valid.
 */
export function isOutsideWorkingHours(params: {
  userSchedule: WorkSchedule | null
  workspaceSchedule: WorkSchedule
  deviceTimezone: string | null
  preferenceTimezone: string
  now: Date
}): boolean | null {
  const timezone = [params.deviceTimezone, params.preferenceTimezone].find(
    (zone): zone is string => !!zone && isValidIanaTimezone(zone)
  )
  if (!timezone) return null
  return !isWithinWorkingHours(params.userSchedule ?? params.workspaceSchedule, params.now, timezone)
}
