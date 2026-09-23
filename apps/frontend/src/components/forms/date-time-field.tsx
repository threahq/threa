import { cn } from "@/lib/utils"

export type DateTimeFieldDensity = "compact" | "comfortable"

interface DateTimeFieldProps {
  /** YYYY-MM-DD — produced by `<input type="date">`. Use `toDateInputValue` from `lib/dates`. */
  date: string
  /** HH:mm — produced by `<input type="time">`. Use `toTimeInputValue` from `lib/dates`. */
  time: string
  onDateChange: (next: string) => void
  onTimeChange: (next: string) => void
  /** Optional YYYY-MM-DD lower bound applied to the date input's `min` attribute. */
  minDate?: string
  disabled?: boolean
  autoFocusDate?: boolean
  /**
   * `comfortable` (default) sizes inputs for thumb taps in a bottom sheet —
   * `bg-muted/30` background, `py-4 text-base`. `compact` matches dialog/form
   * density — `bg-background`, `py-2 text-sm`.
   */
  density?: DateTimeFieldDensity
  /** Override the column gap on the parent grid. */
  gridClassName?: string
}

/**
 * Shared date + time field — split native inputs so each opens its own
 * platform picker on tap (Android's `datetime-local` only reacts to the
 * trailing calendar icon, which kept users from editing just the time).
 *
 * Used by `ReminderPickerSheet` (comfortable density) and the scheduled
 * message edit dialog (compact density). Lift state with `parseLocalDateTime`
 * from `lib/dates` to combine the two halves into a single `Date`.
 */
export function DateTimeField({
  date,
  time,
  onDateChange,
  onTimeChange,
  minDate,
  disabled,
  autoFocusDate,
  density = "comfortable",
  gridClassName,
}: DateTimeFieldProps) {
  const inputClass =
    density === "compact"
      ? "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      : "w-full rounded-lg border border-input bg-muted/30 px-3 py-4 text-base focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"

  const labelClass = density === "compact" ? "flex flex-col gap-1.5" : "flex flex-col gap-2"

  return (
    <div className={cn("grid grid-cols-2 gap-3", gridClassName)}>
      <label className={labelClass}>
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Date</span>
        <input
          type="date"
          value={date}
          min={minDate}
          autoFocus={autoFocusDate}
          onChange={(e) => onDateChange(e.target.value)}
          disabled={disabled}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Time</span>
        <input
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          disabled={disabled}
          className={inputClass}
        />
      </label>
    </div>
  )
}
