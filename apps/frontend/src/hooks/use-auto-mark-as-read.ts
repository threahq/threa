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
  /**
   * The viewer's current persisted read pointer. Used only as a heal target:
   * when nothing new has been seen (`lastEventId` undefined) but the viewer is
   * caught up to the last row with activity still elevated, re-marking up to
   * this pointer clears the stranded activity rows (and emits the `stream:read`
   * that zeroes the badge) without moving the read position. Null/undefined
   * when nothing is read yet — no heal target, so the heal is skipped.
   */
  readPointerEventId?: string | null
  /**
   * Whether the read frontier has reached the last rendered row (a full read).
   * Gates the heal above: clearing activity is whole-stream, not ordinal-scoped,
   * so it must never fire while unread messages sit below the fold.
   */
  atLastRow?: boolean
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
  const { enabled = true, debounceMs = 500, partial = false, readPointerEventId, atLastRow = false } = options
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
  const readPointerEventIdRef = useRef(readPointerEventId)
  const atLastRowRef = useRef(atLastRow)
  streamIdRef.current = streamId
  lastEventIdRef.current = lastEventId
  partialRef.current = partial
  readPointerEventIdRef.current = readPointerEventId
  atLastRowRef.current = atLastRow

  // The consumer (StreamContent) is not keyed by streamId, so this hook persists
  // across stream switches. Clear the dedup refs per stream — otherwise a prior
  // stream's marked event/partial-ness could suppress the first auto-mark in the
  // next stream.
  useEffect(() => {
    lastMarkedRef.current = null
    lastMarkedPartialRef.current = null
  }, [streamId])

  useEffect(() => {
    if (!enabled || !canAutoRead) return

    const unreadCount = getUnreadCount(streamId)
    const activityCount = getActivityCount(streamId)

    if (unreadCount === 0 && activityCount === 0) return

    const target = resolveAutoReadTarget({ lastEventId, atLastRow, readPointerEventId, partial, activityCount })
    if (!target) return

    // Skip if already marked this exact target at the same partial-ness AND no
    // pending activity to clear. Activity can arrive via activity:created while
    // we're viewing (the outbox handler is async), and a no-counter-event
    // backend clear can strand the badge, so re-fire to clear it even when the
    // target is unchanged; a partial→full transition likewise re-fires.
    if (
      lastMarkedRef.current === target.eventId &&
      lastMarkedPartialRef.current === target.partial &&
      activityCount === 0
    )
      return

    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      // Resolve from refs at execution time, not capture time, so a stream
      // switch during the debounce window marks the stream actually in view.
      const currentStreamId = streamIdRef.current
      const resolved = resolveAutoReadTarget({
        lastEventId: lastEventIdRef.current,
        atLastRow: atLastRowRef.current,
        readPointerEventId: readPointerEventIdRef.current,
        partial: partialRef.current,
        activityCount: getActivityCount(currentStreamId),
      })
      if (resolved) {
        markAsRead(currentStreamId, resolved.eventId, { partial: resolved.partial })
        lastMarkedRef.current = resolved.eventId
        lastMarkedPartialRef.current = resolved.partial
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
  }, [
    enabled,
    streamId,
    lastEventId,
    partial,
    debounceMs,
    markAsRead,
    getUnreadCount,
    getActivityCount,
    canAutoRead,
    atLastRow,
    readPointerEventId,
  ])
}

/**
 * The event to mark read up to, and whether it's a partial mark. Normally the
 * furthest SEEN event. When nothing new has been seen (`lastEventId` undefined)
 * but the viewer is caught up to the last row with activity still elevated, the
 * target is the existing read pointer — a heal that clears the stranded activity
 * rows (and emits the `stream:read` that zeroes the badge) without moving the
 * read position. The heal is a FULL mark so the badge clears optimistically; it
 * is gated on `atLastRow` because clearing activity is whole-stream, never
 * ordinal-scoped, so it must not fire while unread sits below the fold. Returns
 * null when there's nothing to mark.
 */
function resolveAutoReadTarget(opts: {
  lastEventId: string | undefined
  atLastRow: boolean
  readPointerEventId: string | null | undefined
  partial: boolean
  activityCount: number
}): { eventId: string; partial: boolean } | null {
  if (opts.lastEventId) return { eventId: opts.lastEventId, partial: opts.partial }
  if (opts.atLastRow && opts.activityCount > 0 && opts.readPointerEventId) {
    return { eventId: opts.readPointerEventId, partial: false }
  }
  return null
}
