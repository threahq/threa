import { X } from "lucide-react"
import { dispatchEscapeUnread } from "@/lib/mark-read-events"

interface UnreadDividerProps {
  /** Once dimmed the line settles from red to muted gray but stays in place. */
  isDimmed?: boolean
  /**
   * Owning stream. Present, the line shows a ✕ that marks everything loaded
   * read and tails the live bottom — the touch-reachable counterpart to the
   * desktop Escape shortcut (the only path on mobile).
   */
  streamId?: string
}

export function UnreadDivider({ isDimmed, streamId }: UnreadDividerProps) {
  return (
    <div
      // The line sits in the gap *above* the first-unread item, centered in the
      // extra `pt-6` (24px) that row gets while the divider shows (see
      // TimelineItemContent). `top-3` + `-translate-y-1/2` lands the line's
      // center 12px below the row top — exactly half the reserved padding — so
      // the breathing room above (to the previous row) and below (to the
      // message) is symmetric.
      //
      // Color, not opacity: the line keeps reserving its row as it settles, so
      // nothing shifts when it dims (INV-21).
      className={`absolute left-0 right-0 top-3 -translate-y-1/2 z-10 flex items-center gap-3 pointer-events-none transition-colors duration-500 ${
        isDimmed ? "text-muted-foreground" : "text-destructive"
      }`}
    >
      <div className="flex-1 border-t border-current" />
      <span className="text-xs font-medium bg-background px-2">New</span>
      <div className="flex-1 border-t border-current" />
      {streamId && (
        <button
          type="button"
          onClick={() => dispatchEscapeUnread(streamId)}
          // pointer-events-auto: the line itself is inert so it never eats
          // clicks on the message below; only this control is interactive.
          className="pointer-events-auto shrink-0 rounded-full bg-background p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Mark all read"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
