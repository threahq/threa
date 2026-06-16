import { useState } from "react"
import { CalendarDays, ChevronDown, ChevronLeft } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { formatDayDivider, getPastDatePresets } from "@/lib/dates"
import { cn } from "@/lib/utils"

interface StreamDateHeaderProps {
  /** Local start-of-day (ms) of the topmost visible row, or null when unknown. */
  dayStartMs: number | null
  /** Whether the pill is shown (faded out while parked near the top/tail). */
  visible: boolean
  /** Jump the timeline to the first message on or after the chosen date. */
  onJumpToDate: (date: Date) => void
}

/**
 * Slack-style floating date pill: shows the day of the topmost visible row and,
 * on click, opens a jump menu (quick presets + a calendar). Positioned over the
 * scroll area (absolute, pointer-events only on the control) so it never shifts
 * timeline layout (INV-21). Labels render in the device's local time (INV-42).
 */
export function StreamDateHeader({ dayStartMs, visible, onJumpToDate }: StreamDateHeaderProps) {
  const [open, setOpen] = useState(false)
  const [showCalendar, setShowCalendar] = useState(false)

  if (dayStartMs == null) return null
  const label = formatDayDivider(new Date(dayStartMs))

  const jump = (date: Date) => {
    onJumpToDate(date)
    setOpen(false)
    setShowCalendar(false)
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setShowCalendar(false)
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Jump to date — showing ${label}`}
            className={cn(
              "pointer-events-auto inline-flex items-center gap-1 rounded-full border bg-background/95 px-3 py-1",
              "text-xs font-medium text-muted-foreground shadow-sm backdrop-blur",
              "transition-colors hover:bg-accent hover:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            )}
          >
            <span>{label}</span>
            <ChevronDown className="h-3 w-3 -mr-0.5 opacity-60" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-56 p-0">
          {showCalendar ? (
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
                defaultMonth={new Date(dayStartMs)}
                onSelect={(date) => date && jump(date)}
                disabled={{ after: new Date() }}
                className="p-2"
              />
            </div>
          ) : (
            <div className="flex flex-col py-1">
              {getPastDatePresets().map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => jump(preset.date)}
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
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
