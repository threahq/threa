import { memo } from "react"
import { Link } from "react-router-dom"
import { ArrowUp, Settings2, X } from "lucide-react"
import { RollingNumber } from "@/components/rolling-number"
import { Button } from "@/components/ui/button"
import { useAutoMarkAsRead, useLastSeenEvent } from "@/hooks"
import type { UseLastSeenEventOptions } from "@/hooks/use-last-seen-event"
import { useStreamUnreadState } from "@/hooks/use-unread-counts"
import { useSettingHref } from "@/hooks/use-setting-href"

interface StreamReadTrackerProps extends UseLastSeenEventOptions {
  workspaceId: string
  /** The pane went behind another: a pending read mark flushes instead of being dropped. */
  covered: boolean
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
  covered,
  bannerAllowed,
  onJumpToFirstUnread,
  onMarkAllRead,
  ...scan
}: StreamReadTrackerProps) {
  const { lastSeenEventId, atLastRow, tailVisible, unreadAboveViewport } = useLastSeenEvent(scan)
  useAutoMarkAsRead(workspaceId, scan.streamId, lastSeenEventId, {
    enabled: scan.enabled,
    covered,
    partial: !atLastRow,
    // Raw watermark, not the thread-remapped frontier seed: the heal's anchor
    // must be the id the server already stores so the advance stays a no-op.
    readPointerEventId: scan.lastReadEventId,
    activityHealEnabled: tailVisible,
  })
  const { unreadCount } = useStreamUnreadState(workspaceId, scan.streamId)

  if (!unreadAboveViewport || unreadCount === 0 || !bannerAllowed) return null
  return <UnreadJumpBar unreadCount={unreadCount} onJump={onJumpToFirstUnread} onMarkAllRead={onMarkAllRead} />
})

interface UnreadJumpBarProps {
  unreadCount: number
  onJump: () => void
  onMarkAllRead: () => void
}

const COARSE_ICON_BUTTON =
  "pointer-events-auto h-9 w-9 shadow-lg [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"

/** The "N new messages" bar. Mounted only while shown, so the tracker never subscribes to the settings url. */
export function UnreadJumpBar({ unreadCount, onJump, onMarkAllRead }: UnreadJumpBarProps) {
  const settingsHref = useSettingHref("unread-landing")
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
        className="pointer-events-auto gap-1.5 shadow-lg [@media(pointer:coarse)]:h-11"
        onClick={onJump}
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
        className={COARSE_ICON_BUTTON}
        onClick={onMarkAllRead}
        aria-label="Mark all read"
      >
        <X className="h-4 w-4" />
      </Button>
      {settingsHref && (
        <Button asChild variant="secondary" size="icon" className={COARSE_ICON_BUTTON} title="Unread settings">
          <Link to={settingsHref} aria-label="Unread settings">
            <Settings2 className="h-4 w-4" />
          </Link>
        </Button>
      )}
    </div>
  )
}
