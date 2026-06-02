import { Plus, X } from "lucide-react"
import {
  type WorkSchedule,
  type Weekday,
  type ShiftInterval,
  WEEKDAYS_MONDAY_FIRST,
  getDayShifts,
  typicalStartMinutes,
  minutesToHHMM,
  parseHHMM,
} from "@threa/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

const DAY_END = 23 * 60 + 59

/**
 * Build a valid shift seeded at `startMin`. Start is capped so there's always
 * room for an 8h (or shorter) shift that ends before midnight, guaranteeing
 * end > start — which the backend requires.
 */
function makeShift(startMin: number): ShiftInterval {
  // Cap start at the last minute before midnight so a new shift never lands
  // before the one it follows; end is clamped to midnight, so start < end holds.
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

interface WorkScheduleEditorProps {
  value: WorkSchedule
  onChange: (next: WorkSchedule) => void
  disabled?: boolean
}

/**
 * Per-weekday working-hours editor shared by user settings (personal override)
 * and workspace settings (workspace default). A weekday with no shifts is a day
 * off; the switch toggles a day on with a sensible default shift and off by
 * clearing its shifts. Multiple shifts per day cover split shifts / siesta.
 */
export function WorkScheduleEditor({ value, onChange, disabled }: WorkScheduleEditorProps) {
  const setDay = (day: Weekday, shifts: ShiftInterval[]) => {
    onChange({ days: { ...value.days, [day]: shifts } })
  }

  const toggleDay = (day: Weekday, on: boolean) => {
    if (!on) {
      setDay(day, [])
      return
    }
    // Seed a new working day with one shift starting at the schedule's typical
    // start so a freshly enabled day isn't empty (which would read as "off").
    setDay(day, [makeShift(typicalStartMinutes(value))])
  }

  return (
    <div className="space-y-2">
      {WEEKDAYS_MONDAY_FIRST.map((day) => {
        const shifts = getDayShifts(value, day)
        const working = shifts.length > 0
        // Can only append another shift when the last one has a parseable end
        // before midnight — otherwise there's no room (or the row is invalid),
        // and appending would seed an overlapping/reordered interval.
        const lastShiftEnd = parseHHMM(shifts[shifts.length - 1]?.end ?? "")
        const canAppendShift = lastShiftEnd !== null && lastShiftEnd < DAY_END
        return (
          <div key={day} className="rounded-md border px-3 py-2.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-3 cursor-pointer">
                <Switch checked={working} onCheckedChange={(on) => toggleDay(day, on)} disabled={disabled} />
                <span className={cn("text-sm font-medium", !working && "text-muted-foreground")}>
                  {WEEKDAY_LABELS[day]}
                </span>
              </label>
              {!working && <span className="text-xs text-muted-foreground">Day off</span>}
            </div>

            {working && (
              <div className="mt-2 space-y-2 pl-[3.25rem]">
                {shifts.map((shift, index) => (
                  <ShiftRow
                    key={index}
                    shift={shift}
                    disabled={disabled}
                    onChange={(next) =>
                      setDay(
                        day,
                        shifts.map((s, i) => (i === index ? next : s))
                      )
                    }
                    onRemove={() =>
                      setDay(
                        day,
                        shifts.filter((_, i) => i !== index)
                      )
                    }
                  />
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={disabled || shifts.length >= 6 || !canAppendShift}
                  onClick={() => {
                    // Start the next shift where the last one ended (e.g. an
                    // afternoon block after a morning shift).
                    if (!canAppendShift) return
                    setDay(day, [...shifts, makeShift(lastShiftEnd)])
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add shift
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ShiftRowProps {
  shift: ShiftInterval
  disabled?: boolean
  onChange: (next: ShiftInterval) => void
  onRemove: () => void
}

function ShiftRow({ shift, disabled, onChange, onRemove }: ShiftRowProps) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="time"
        value={shift.start}
        disabled={disabled}
        onChange={(e) => onChange({ ...shift, start: e.target.value })}
        className="h-8 w-28"
        aria-label="Shift start"
      />
      <span className="text-xs text-muted-foreground">to</span>
      <Input
        type="time"
        value={shift.end}
        disabled={disabled}
        onChange={(e) => onChange({ ...shift, end: e.target.value })}
        className="h-8 w-28"
        aria-label="Shift end"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground"
        disabled={disabled}
        onClick={onRemove}
        aria-label="Remove shift"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
