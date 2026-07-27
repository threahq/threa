import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatDayDivider } from "@/lib/dates"
import { DateJumpMenu } from "./date-jump-menu"
import { useForwardScroll } from "@/hooks/use-forward-scroll"
import { cn } from "@/lib/utils"

interface StreamDateHeaderProps {
  /** Local start-of-day (ms) of the topmost visible row, or null when unknown. */
  dayStartMs: number | null
  /** Whether the pill is shown (faded out while parked near the top/tail). */
  visible: boolean
  /** Jump the timeline to the first message on or after the chosen date. */
  onJumpToDate: (date: Date) => void
  /**
   * The timeline scroller. The pill is an overlay sibling of the scroller (not a
   * descendant), so a wheel landing on its `pointer-events-auto` button would
   * otherwise scroll the wrong ancestor and leave the timeline stuck. Forward
   * the wheel to the scroller so wheeling over the pill scrolls the messages.
   */
  scrollerRef?: React.RefObject<HTMLElement | null>
}

/**
 * Slack-style floating date pill: shows the day of the topmost visible row and,
 * on click, opens a jump menu (quick presets + a calendar). Positioned over the
 * scroll area (absolute, pointer-events only on the control) so it never shifts
 * timeline layout (INV-21). Labels render in the device's local time (INV-42).
 */
export function StreamDateHeader({ dayStartMs, visible, onJumpToDate, scrollerRef }: StreamDateHeaderProps) {
  const [open, setOpen] = useState(false)
  // Forward a wheel/touch scroll begun on the pill to the timeline scroller —
  // gated off while the jump popover is open so it scrolls its own list.
  const forwardScroll = useForwardScroll(scrollerRef, !open)

  if (dayStartMs == null) return null
  const label = formatDayDivider(new Date(dayStartMs))

  const jump = (date: Date) => {
    onJumpToDate(date)
    setOpen(false)
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Jump to date — showing ${label}`}
            // Drop out of the tab order while faded out — otherwise keyboard
            // focus lands on an invisible control with a focus ring.
            tabIndex={visible ? undefined : -1}
            // Forward wheel/touch to the scroller (see scrollerRef doc): without
            // this, a gesture over the pill leaves the timeline stuck. Gated off
            // while the jump menu is open so the popover handles its own scroll.
            {...forwardScroll}
            className={cn(
              // A faded-out pill must not capture clicks or wheel — drop pointer
              // events so they reach the scroller beneath it.
              visible ? "pointer-events-auto" : "pointer-events-none",
              "inline-flex items-center gap-1 rounded-full border bg-background/95 px-3 py-1.5",
              "text-xs font-medium text-muted-foreground shadow-sm backdrop-blur",
              "transition-colors hover:bg-accent hover:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            )}
          >
            <span>{label}</span>
            <ChevronDown className="h-3 w-3 -mr-0.5 opacity-60" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-64 p-0">
          <DateJumpMenu defaultMonth={new Date(dayStartMs)} onPick={jump} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
