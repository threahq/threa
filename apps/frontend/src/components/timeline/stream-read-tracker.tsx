import { memo } from "react"
import { ArrowUp, X } from "lucide-react"
import { RollingNumber } from "@/components/rolling-number"
import { Button } from "@/components/ui/button"
import { useAutoMarkAsRead, useLastSeenEvent } from "@/hooks"
import type { UseLastSeenEventOptions } from "@/hooks/use-last-seen-event"
import { useStreamUnreadState } from "@/hooks/use-unread-counts"

interface StreamReadTrackerProps extends UseLastSeenEventOptions {
  workspaceId: string
  /** Search, batch selection and collapsed chrome hide the jump bar. */
  bannerAllowed: boolean
  onJumpToFirstUnread: () => void
  onMarkAllRead: () => void
}

/**
 * Owns the read frontier scan, auto-read and the "N new messages" jump bar.
 * The frontier and the unread count change several times per incoming message;
 * held here, those changes re-render this component instead of the timeline.
 */
export const StreamReadTracker = memo(function StreamReadTracker({
  workspaceId,
  bannerAllowed,
  onJumpToFirstUnread,
  onMarkAllRead,
  ...scan
}: StreamReadTrackerProps) {
  const { lastSeenEventId, atLastRow, tailVisible, unreadAboveViewport } = useLastSeenEvent(scan)
  useAutoMarkAsRead(workspaceId, scan.streamId, lastSeenEventId, {
    enabled: scan.enabled,
    partial: !atLastRow,
    // Raw watermark, not the thread-remapped frontier seed: the heal's anchor
    // must be the id the server already stores so the advance stays a no-op.
    readPointerEventId: scan.lastReadEventId,
    activityHealEnabled: tailVisible,
  })
  const { unreadCount } = useStreamUnreadState(workspaceId, scan.streamId)

  if (!unreadAboveViewport || unreadCount === 0 || !bannerAllowed) return null
  return (
    <div
      // Sits clearly below the floating date pill (top-2, ~30px tall)
      // so the top-center affordances never overlap.
      className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5"
      style={{ top: "3.5rem" }}
    >
      <Button
        variant="secondary"
        size="sm"
        className="pointer-events-auto shadow-lg gap-1.5"
        onClick={onJumpToFirstUnread}
      >
        <ArrowUp className="h-3.5 w-3.5" />
        <span>
          <RollingNumber value={unreadCount} /> new message{unreadCount === 1 ? "" : "s"}
        </span>
      </Button>
      {/* Dismiss without scrolling up: mark all loaded read and tail
          the live bottom — the touchable equivalent of Escape. */}
      <Button
        variant="secondary"
        size="icon"
        className="pointer-events-auto h-9 w-9 shadow-lg"
        onClick={onMarkAllRead}
        aria-label="Mark all read"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
})
