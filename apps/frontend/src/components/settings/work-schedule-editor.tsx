import { useId } from "react"
import { Plus } from "lucide-react"
import {
  type ShiftInterval,
  type TimeFormat,
  type Weekday,
  type WorkSchedule,
  WEEKDAYS_MONDAY_FIRST,
  getDayShifts,
  minutesToHHMM,
  parseHHMM,
  typicalStartMinutes,
} from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { usePreferencesOptional } from "@/contexts"
import { formatTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import {
  DisabledReason,
  INACTIVE_CONTROL_CLASS,
  SETTING_CONTROL_HEIGHT,
  SettingRemoveButton,
} from "./setting-primitives"
import { FOCUS_FALLBACK, FOCUS_ITEM, FOCUS_SCOPE, useFocusAfterRemoval } from "./use-focus-after-removal"

const DAY_END = 23 * 60 + 59
const MAX_SHIFTS_PER_DAY = 6
const STEP_MINUTES = 15

/** Every quarter hour, plus 23:59 so a shift can run to the end of the day. */
const TIME_SLOTS: number[] = [
  ...Array.from({ length: (24 * 60) / STEP_MINUTES }, (_, index) => index * STEP_MINUTES),
  DAY_END,
]

/**
 * Build a valid shift seeded at `startMin`. Start is capped so there's always
 * room for an 8h (or shorter) shift that ends before midnight, guaranteeing
 * end > start — which the backend requires.
 */
/** Why a day takes no further shift, or null while it can; another shift starts where the last one ends. */
function addShiftBlockedReason(shifts: ShiftInterval[], lastShiftEnd: number | null): string | null {
  if (shifts.length >= MAX_SHIFTS_PER_DAY) {
    return `A day holds up to ${MAX_SHIFTS_PER_DAY} shifts. Remove one to add another.`
  }
  if (lastShiftEnd !== null && lastShiftEnd >= DAY_END) {
    return "The last shift runs to the end of the day. End it earlier to add another."
  }
  return null
}

function makeShift(startMin: number): ShiftInterval {
  const start = Math.min(Math.max(startMin, 0), DAY_END - 1)
  const end = Math.min(start + 8 * 60, DAY_END)
  return { start: minutesToHHMM(start), end: minutesToHHMM(end) }
}

const WEEKDAY_LABELS: Record<Weekday, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
}

const WEEKDAY_SHORT: Record<Weekday, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" }

/** The viewer's 12/24-hour choice; the workspace defaults page renders this editor too. */
function useTimeFormat(): TimeFormat {
  return usePreferencesOptional()?.preferences?.timeFormat ?? "24h"
}

function formatClock(minutes: number, timeFormat: TimeFormat): string {
  return formatTime(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60), { timeFormat })
}

function formatShift(shift: ShiftInterval, timeFormat: TimeFormat): string {
  const start = parseHHMM(shift.start)
  const end = parseHHMM(shift.end)
  if (start === null || end === null) return `${shift.start}–${shift.end}`
  return `${formatClock(start, timeFormat)}–${formatClock(end, timeFormat)}`
}

interface WorkScheduleEditorProps {
  value: WorkSchedule
  onChange: (next: WorkSchedule) => void
  disabled?: boolean
}

/**
 * Per-weekday working-hours editor shared by user settings (personal override)
 * and workspace settings (workspace default). A weekday with no shifts is a day
 * off. Times are picked from a list, so every edit is a valid shift: end
 * options start after the shift's start, and moving start past the end carries
 * the end along.
 */
export function WorkScheduleEditor({ value, onChange, disabled }: WorkScheduleEditorProps) {
  const timeFormat = useTimeFormat()
  const baseId = useId()
  const focusAfterRemoval = useFocusAfterRemoval()

  const setDay = (day: Weekday, shifts: ShiftInterval[]) => {
    onChange({ days: { ...value.days, [day]: shifts } })
  }

  return (
    <div className="divide-y divide-border">
      {WEEKDAYS_MONDAY_FIRST.map((day) => {
        const shifts = getDayShifts(value, day)
        const working = shifts.length > 0
        const daySwitchId = `${baseId}-day-${day}`
        const dayName = WEEKDAY_LABELS[day]
        const lastShiftEnd = parseHHMM(shifts[shifts.length - 1]?.end ?? "")
        const addBlocked = addShiftBlockedReason(shifts, lastShiftEnd)
        const addReasonId = `${baseId}-add-${day}-reason`
        return (
          <div
            key={day}
            {...FOCUS_SCOPE}
            className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4"
          >
            <div className="flex min-h-11 items-center gap-3 sm:min-h-9 sm:w-36 sm:shrink-0 [@media(pointer:coarse)]:min-h-11">
              <Switch
                {...FOCUS_FALLBACK}
                id={daySwitchId}
                checked={working}
                onCheckedChange={(on) => setDay(day, on ? [makeShift(typicalStartMinutes(value))] : [])}
                disabled={disabled}
              />
              <Label
                htmlFor={daySwitchId}
                className={cn(
                  "flex min-h-11 flex-1 items-center text-sm font-medium sm:min-h-9 [@media(pointer:coarse)]:min-h-11",
                  !working && "text-muted-foreground"
                )}
              >
                {dayName}
              </Label>
            </div>

            {working ? (
              <div className="min-w-0 flex-1 space-y-2">
                {shifts.map((shift, index) => (
                  <ShiftRow
                    key={index}
                    shift={shift}
                    name={shifts.length > 1 ? `${dayName} shift ${index + 1}` : `${dayName} shift`}
                    timeFormat={timeFormat}
                    disabled={disabled}
                    onChange={(next) =>
                      setDay(
                        day,
                        shifts.map((s, i) => (i === index ? next : s))
                      )
                    }
                    onRemove={(button) => {
                      focusAfterRemoval(button)
                      setDay(
                        day,
                        shifts.filter((_, i) => i !== index)
                      )
                    }}
                  />
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn("gap-1 px-2", SETTING_CONTROL_HEIGHT, INACTIVE_CONTROL_CLASS)}
                  disabled={disabled || lastShiftEnd === null}
                  aria-disabled={addBlocked ? true : undefined}
                  aria-describedby={addBlocked ? addReasonId : undefined}
                  aria-label={`Add a shift on ${dayName}`}
                  onClick={() => {
                    if (!addBlocked && lastShiftEnd !== null) setDay(day, [...shifts, makeShift(lastShiftEnd)])
                  }}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add shift
                </Button>
                {addBlocked && <DisabledReason id={addReasonId}>{addBlocked}</DisabledReason>}
              </div>
            ) : (
              <p className="flex items-center text-sm text-muted-foreground sm:min-h-9">Day off</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ShiftRowProps {
  shift: ShiftInterval
  /** "Monday shift", or "Monday shift 2" when the day has several. */
  name: string
  timeFormat: TimeFormat
  disabled?: boolean
  onChange: (next: ShiftInterval) => void
  onRemove: (button: HTMLElement) => void
}

function ShiftRow({ shift, name, timeFormat, disabled, onChange, onRemove }: ShiftRowProps) {
  const start = parseHHMM(shift.start)
  const end = parseHHMM(shift.end)

  const changeStart = (nextStart: number) => {
    if (end !== null && nextStart < end) {
      onChange({ ...shift, start: minutesToHHMM(nextStart) })
      return
    }
    const length = start !== null && end !== null && end > start ? end - start : 8 * 60
    onChange({ start: minutesToHHMM(nextStart), end: minutesToHHMM(Math.min(nextStart + length, DAY_END)) })
  }

  return (
    <div className="flex items-center gap-2">
      <TimeSelect
        value={start}
        slots={TIME_SLOTS.filter((slot) => slot < DAY_END)}
        timeFormat={timeFormat}
        disabled={disabled}
        label={`${name} start`}
        onChange={changeStart}
      />
      <span className="text-sm text-muted-foreground" aria-hidden>
        to
      </span>
      <TimeSelect
        value={end}
        slots={TIME_SLOTS.filter((slot) => start === null || slot > start)}
        timeFormat={timeFormat}
        disabled={disabled}
        label={`${name} end`}
        onChange={(nextEnd) => onChange({ ...shift, end: minutesToHHMM(nextEnd) })}
      />
      <SettingRemoveButton
        label={`Remove ${name}`}
        disabled={disabled}
        onClick={(event) => onRemove(event.currentTarget)}
        {...FOCUS_ITEM}
      />
    </div>
  )
}

function TimeSelect({
  value,
  slots,
  timeFormat,
  disabled,
  label,
  onChange,
}: {
  value: number | null
  slots: number[]
  timeFormat: TimeFormat
  disabled?: boolean
  label: string
  onChange: (minutes: number) => void
}) {
  // A time saved off the quarter-hour grid (typed into the old minute-precise
  // field, or set by an agent) stays selectable rather than being snapped.
  const options = value === null || slots.includes(value) ? slots : [...slots, value].sort((a, b) => a - b)
  return (
    <Select
      value={value === null ? undefined : String(value)}
      onValueChange={(next) => onChange(Number(next))}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className={cn("min-w-0 flex-1 sm:w-32 sm:flex-none", SETTING_CONTROL_HEIGHT)}>
        <SelectValue placeholder="Pick a time" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((minutes) => (
          <SelectItem key={minutes} value={String(minutes)}>
            {formatClock(minutes, timeFormat)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The working week on one line, consecutive days with the same hours folded
 * together and days off left out: "Mon–Fri 9:00–17:00 · Sat 10:00–14:00".
 */
export function formatWorkScheduleLine(schedule: WorkSchedule, timeFormat: TimeFormat): string {
  const runs: { first: Weekday; last: Weekday; hours: string | null }[] = []
  for (const day of WEEKDAYS_MONDAY_FIRST) {
    const shifts = getDayShifts(schedule, day)
    const hours = shifts.length === 0 ? null : shifts.map((shift) => formatShift(shift, timeFormat)).join(", ")
    const previous = runs[runs.length - 1]
    if (previous && previous.hours === hours) previous.last = day
    else runs.push({ first: day, last: day, hours })
  }
  const working = runs.filter((run) => run.hours !== null)
  if (working.length === 0) return "No working days"
  return working
    .map((run) => {
      const days =
        run.first === run.last ? WEEKDAY_SHORT[run.first] : `${WEEKDAY_SHORT[run.first]}–${WEEKDAY_SHORT[run.last]}`
      return `${days} ${run.hours}`
    })
    .join(" · ")
}

/** {@link formatWorkScheduleLine} in the viewer's clock format. */
export function WorkScheduleLine({ schedule }: { schedule: WorkSchedule }) {
  return <>{formatWorkScheduleLine(schedule, useTimeFormat())}</>
}
