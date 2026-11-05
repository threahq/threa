import { useEffect, useState } from "react"
import { CircleAlert } from "lucide-react"
import {
  WEEKDAYS_MONDAY_FIRST,
  getDayShifts,
  isWithinWorkingHours,
  parseHHMM,
  type TimeFormat,
  type Weekday,
  type WorkSchedule,
} from "@threahq/types"
import { usePreferences } from "@/contexts"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"
import { formatFutureTime, formatTime } from "@/lib/dates"
import { SwitchSetting } from "./setting-primitives"
import { settingDef } from "./settings-registry"
import { WorkScheduleLine } from "./work-schedule-editor"

const DAYS_AHEAD = 8

/**
 * Whether it's quiet now on this device's clock, and when that next flips: the
 * first shift start or end ahead of `now` where being inside working hours
 * changes. `changesAt` is null when it never does (no working hours, or every
 * minute is one).
 */
export function quietHoursState(
  schedule: WorkSchedule,
  now: Date,
  timeZone: string
): { quiet: boolean; changesAt: Date | null } {
  const quiet = !isWithinWorkingHours(schedule, now, timeZone)
  const boundaries: Date[] = []
  for (let offset = 0; offset < DAYS_AHEAD; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    for (const shift of getDayShifts(schedule, day.getDay() as Weekday)) {
      for (const minutes of [parseHHMM(shift.start), parseHHMM(shift.end)]) {
        if (minutes === null) continue
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60)
        if (at > now) boundaries.push(at)
      }
    }
  }
  boundaries.sort((a, b) => a.getTime() - b.getTime())
  const changesAt = boundaries.find((at) => !isWithinWorkingHours(schedule, at, timeZone) !== quiet) ?? null
  return { quiet, changesAt }
}

function formatChange(at: Date, now: Date, timeFormat: TimeFormat): string {
  // Within the hour formatFutureTime counts minutes; a clock time reads better beside "resumes".
  if (at.getTime() - now.getTime() < 60 * 60_000) return formatTime(at, { timeFormat })
  return formatFutureTime(at, now, { timeFormat })
}

/** Re-reads the clock each minute, so "Quiet now" turns over while the page is open. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * Push reads quiet hours in the zone of your most recently active device,
 * falling back to your Time zone setting; this device is the one open now.
 */
function QuietHoursNow({ schedule, timeFormat }: { schedule: WorkSchedule; timeFormat: TimeFormat }) {
  const now = useMinuteClock()
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const { quiet, changesAt } = quietHoursState(schedule, now, deviceZone)
  let state: string
  if (quiet) state = changesAt ? `Quiet now · resumes ${formatChange(changesAt, now, timeFormat)}` : "Quiet now"
  else state = changesAt ? `Next quiet ${formatChange(changesAt, now, timeFormat)}` : "Not quiet"
  return (
    <span data-slot="quiet-hours-now" className="mt-0.5 block">
      {state}
      {` · ${deviceZone.replace(/_/g, " ")} time, from this device`}
    </span>
  )
}

/** Shows the hours it follows and whose they are, beside the link to edit them. */
export function QuietHoursSetting({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference } = usePreferences()
  const schedule = useEffectiveWorkSchedule(workspaceId)
  const enabled = preferences?.quietOutsideWorkingHours ?? false
  const ownHours = preferences?.workSchedule != null
  const noWorkingDays = WEEKDAYS_MONDAY_FIRST.every((day) => getDayShifts(schedule, day).length === 0)

  return (
    <SwitchSetting
      setting="quiet-hours"
      checked={enabled}
      onCheckedChange={(checked) => void updatePreference("quietOutsideWorkingHours", checked)}
      description={
        <>
          {settingDef("quiet-hours").description}
          <span data-slot="quiet-hours-schedule" className="mt-0.5 block">
            <WorkScheduleLine schedule={schedule} />
            {" · "}
            {ownHours ? "your hours" : "workspace default"}
          </span>
          {enabled && <QuietHoursNow schedule={schedule} timeFormat={preferences?.timeFormat ?? "24h"} />}
        </>
      }
      notice={enabled && noWorkingDays && "You have no working hours, so push notifications stay off all week."}
      noticeIcon={CircleAlert}
    />
  )
}
