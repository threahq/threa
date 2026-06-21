import { useEffect, useRef } from "react"
import { useUnreadCounts } from "./use-unread-counts"
import { useActivityCounts } from "./use-activity-counts"
import { usePageActivity } from "./use-page-activity"
import { useIsMobile, useIsCoarsePointer } from "./use-mobile"
import { SW_MSG_CLEAR_NOTIFICATIONS } from "../lib/sw-messages"

interface UseAutoMarkAsReadOptions {
  enabled?: boolean
  debounceMs?: number
  /**
   * When true, `lastEventId` is the bottom of what the viewer has seen, not the
   * tail of the loaded window — unread messages remain below the fold. The read
   * pointer advances to `lastEventId`, but the unread badge is NOT optimistically
   * zeroed; the server `stream:read` round-trip sets the true remaining count
   * (Slack-style progressive read). Defaults false: mark fully read as before.
   */
  partial?: boolean
}

/**
 * Hook that automatically marks a stream as read when viewing it.
 * Debounces the mark-as-read call to avoid excessive API calls when rapidly switching streams.
 *
 * Checks unread counts, mention counts, AND activity counts — the mark-as-read API
 * clears all of these, so this must fire when any is elevated (e.g., activity arrives
 * via the outbox handler while viewing the stream).
 *
 * `lastEventId` is the furthest event the viewer has actually scrolled into
 * view (see `useLastSeenEvent`), not the last loaded event — read state never
 * runs ahead of what the user has seen.
 */
export function useAutoMarkAsRead(
  workspaceId: string,
  streamId: string,
  lastEventId: string | undefined,
  options: UseAutoMarkAsReadOptions = {}
) {
  const { enabled = true, debounceMs = 500, partial = false } = options
  const { markAsRead, getUnreadCount } = useUnreadCounts(workspaceId)
  const { getActivityCount } = useActivityCounts(workspaceId)
  const { isVisible, isFocused } = usePageActivity()
  const isMobile = useIsMobile()
  const isCoarsePointer = useIsCoarsePointer()
  // Focus tells you which of several overlapping windows the user is working in —
  // a fine-pointer, multi-window (desktop) signal. On a phone-like device (coarse
  // pointer AND a phone-width viewport) `document.hasFocus()` is an unreliable
  // proxy for attention: mobile browsers and installed PWAs routinely report no
  // focus while the page is the foreground, and the resume `focus` event often
  // never fires — so there a visible page is "active". A coarse-but-wide device
  // (tablet, iPad split view) keeps the focus gate, so working in the adjacent
  // pane does not auto-read this one. This relaxation is deliberately local to
  // auto-read; `usePageActivity().isActive` stays the strict visible-and-focused
  // signal its other consumers (socket, connection status, app-update) rely on.
  const canAutoRead = isVisible && (isFocused || (isMobile && isCoarsePointer))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMarkedRef = useRef<string | null>(null)
  // Track the partial-ness of the last mark so a partial→full transition at the
  // SAME event (viewer scrolled partway, then on to the tail) re-fires to clear
  // the badge optimistically instead of waiting on the server round-trip.
  const lastMarkedPartialRef = useRef<boolean | null>(null)

  // Use refs to avoid stale closure in setTimeout callback
  const streamIdRef = useRef(streamId)
  const lastEventIdRef = useRef(lastEventId)
  const partialRef = useRef(partial)
  streamIdRef.current = streamId
  lastEventIdRef.current = lastEventId
  partialRef.current = partial

  // The consumer (StreamContent) is not keyed by streamId, so this hook persists
  // across stream switches. Clear the dedup refs per stream — otherwise a prior
  // stream's marked event/partial-ness could suppress the first auto-mark in the
  // next stream.
  useEffect(() => {
    lastMarkedRef.current = null
    lastMarkedPartialRef.current = null
  }, [streamId])

  useEffect(() => {
    if (!enabled || !lastEventId || !canAutoRead) return

    const unreadCount = getUnreadCount(streamId)
    const activityCount = getActivityCount(streamId)

    if (unreadCount === 0 && activityCount === 0) return

    // Skip if already marked this event at the same partial-ness AND no pending
    // activities to clear. Activities can arrive via activity:created while we're
    // viewing the stream (the outbox handler is async), so we must re-fire to
    // clear them even if lastEventId hasn't changed; likewise a partial→full
    // transition at the same event must re-fire to clear the badge.
    if (lastMarkedRef.current === lastEventId && lastMarkedPartialRef.current === partial && activityCount === 0) return

    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      // Read current values at execution time, not capture time, so a stream
      // switch during the debounce window marks the stream actually in view.
      const currentStreamId = streamIdRef.current
      const currentLastEventId = lastEventIdRef.current
      if (currentLastEventId) {
        markAsRead(currentStreamId, currentLastEventId, { partial: partialRef.current })
        lastMarkedRef.current = currentLastEventId
        lastMarkedPartialRef.current = partialRef.current
        // Dismiss any push notification for this stream — the user is reading it
        navigator.serviceWorker?.controller?.postMessage({
          type: SW_MSG_CLEAR_NOTIFICATIONS,
          streamId: currentStreamId,
        })
      }
    }, debounceMs)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [enabled, streamId, lastEventId, partial, debounceMs, markAsRead, getUnreadCount, getActivityCount, canAutoRead])
}
