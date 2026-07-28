import { useState } from "react"
import { CalendarDays, ChevronLeft } from "lucide-react"
import { Calendar } from "@/components/ui/calendar"
import { getPastDatePresets } from "@/lib/dates"

/**
 * The body of a jump-to-date popover: quick presets, then a calendar behind a
 * "specific date" step. Shared by the timeline's floating date pill and the
 * "In this stream" panel's day markers so the two jumps offer the same choices
 * and read the same way — the panel's jump moves its own list, the timeline's
 * moves the messages, but the menu is one implementation (INV-35).
 *
 * Owns only its preset/calendar step state; the caller owns the popover and
 * closes it from `onPick`.
 */
export function DateJumpMenu({ defaultMonth, onPick }: { defaultMonth: Date; onPick: (date: Date) => void }) {
  const [showCalendar, setShowCalendar] = useState(false)

  if (showCalendar) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setShowCalendar(false)}
          className="flex w-full items-center gap-1.5 border-b px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Back
        </button>
        <Calendar
          mode="single"
          defaultMonth={defaultMonth}
          onSelect={(date) => date && onPick(date)}
          disabled={{ after: new Date() }}
          className="p-2"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col py-1">
      {getPastDatePresets().map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onPick(preset.date)}
          className="px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
        >
          {preset.label}
        </button>
      ))}
      <div className="my-1 border-t" />
      <button
        type="button"
        onClick={() => setShowCalendar(true)}
        className="flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
      >
        <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden />
        Jump to a specific date…
      </button>
    </div>
  )
}
