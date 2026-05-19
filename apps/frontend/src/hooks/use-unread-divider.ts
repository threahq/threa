import { useState, useEffect, useRef, useMemo } from "react"
import type { StreamEvent } from "@threa/types"
import { useScrollToElement } from "./use-scroll-to-element"

/**
 * Event types that don't render as visible timeline items.
 * Reactions update existing messages in place and return null from EventItem,
 * so they should not trigger the unread divider.
 */
const INVISIBLE_EVENT_TYPES = new Set(["reaction_added", "reaction_removed"])

interface UseUnreadDividerOptions {
  events: StreamEvent[]
  lastReadEventId: string | null | undefined
  currentUserId: string | undefined
  streamId: string
  /** Whether to scroll to first unread on initial load */
  scrollToUnread?: boolean
  /** Skip scrolling if a message is being highlighted (e.g., from search) */
  highlightMessageId?: string | null
  /** Whether content is still loading */
  isLoading?: boolean
}

interface UseUnreadDividerResult {
  /** The calculated first unread event ID (for scroll-to behavior) */
  firstUnreadEventId: string | undefined
  /** The event ID where the divider should be shown, or undefined if hidden */
  dividerEventId: string | undefined
  /** Whether the divider is currently fading out */
  isFading: boolean
}

/**
 * Hook to manage the "New" unread divider display state.
 *
 * - Calculates the first unread event from another user
 * - Shows the divider for 3 seconds, then fades out over 500ms
 * - Resets when switching streams
 */
export function useUnreadDivider({
  events,
  lastReadEventId,
  currentUserId,
  streamId,
  scrollToUnread = true,
  highlightMessageId,
  isLoading = false,
}: UseUnreadDividerOptions): UseUnreadDividerResult {
  // Calculate first unread event from another user
  const firstUnreadEventId = useMemo(() => {
    if (events.length === 0) return undefined

    // Find events after lastReadEventId that are from other users
    const startIndex = lastReadEventId ? events.findIndex((e) => e.id === lastReadEventId) + 1 : 0

    if (startIndex <= 0 && lastReadEventId) {
      // lastReadEventId not found in events - can't determine first unread
      return undefined
    }

    // Find first visible event from another user after the last read position.
    // Skip event types that don't render as timeline items (e.g. reactions).
    for (let i = startIndex; i < events.length; i++) {
      if (events[i].actorId !== currentUserId && !INVISIBLE_EVENT_TYPES.has(events[i].eventType)) {
        return events[i].id
      }
    }

    return undefined
  }, [events, lastReadEventId, currentUserId])

  // Track displayed divider separately - shows for 3 seconds then fades out
  const [displayedUnreadId, setDisplayedUnreadId] = useState<string | undefined>(undefined)
  const [isFading, setIsFading] = useState(false)
  const hasShownDivider = useRef(false)
  const previousStreamId = useRef(streamId)

  useEffect(() => {
    // Show divider when we have a firstUnreadEventId and haven't shown one yet
    if (firstUnreadEventId && !hasShownDivider.current) {
      setDisplayedUnreadId(firstUnreadEventId)
      setIsFading(false)
      hasShownDivider.current = true

      // Start fade after 3 seconds
      const fadeTimer = setTimeout(() => {
        setIsFading(true)
      }, 3000)

      // Remove after fade completes (500ms transition)
      const removeTimer = setTimeout(() => {
        setDisplayedUnreadId(undefined)
        setIsFading(false)
      }, 3500)

      return () => {
        clearTimeout(fadeTimer)
        clearTimeout(removeTimer)
      }
    }
  }, [firstUnreadEventId])

  useEffect(() => {
    if (firstUnreadEventId) return

    // If the stream is now considered read, remove any divider immediately.
    // Otherwise a lastReadEventId update can cancel the pending fade/remove
    // timers from the previous effect and leave a stale divider rendered
    // until remount.
    setDisplayedUnreadId(undefined)
    setIsFading(false)
    hasShownDivider.current = false
  }, [firstUnreadEventId])

  // Reset when stream changes
  useEffect(() => {
    if (previousStreamId.current === streamId) return
    previousStreamId.current = streamId
    hasShownDivider.current = false
    setDisplayedUnreadId(undefined)
    setIsFading(false)
  }, [streamId])

  // Latch deep-link mode per stream. The `?m=` param is auto-cleared from the
  // URL ~3s after a deep-link lands, flipping highlightMessageId to null.
  // Without this latch the scroll-to-first-unread gate below would re-arm at
  // that moment and yank the user off the deep-linked message down to the
  // first unread (≈ the live tail) — the "lands right, then jumps, then snaps
  // to the bottom" deep-link bug. A stream the user deep-linked into should
  // never auto-scroll to unread for that view. Resets only on stream change.
  const deepLinkedRef = useRef<{ streamId: string; seen: boolean }>({ streamId, seen: false })
  if (deepLinkedRef.current.streamId !== streamId) {
    deepLinkedRef.current = { streamId, seen: false }
  }
  if (highlightMessageId) {
    deepLinkedRef.current.seen = true
  }

  // Scroll to first unread on initial load
  useScrollToElement({
    enabled: scrollToUnread && !isLoading && !!firstUnreadEventId && !deepLinkedRef.current.seen,
    selector: firstUnreadEventId ? `[data-event-id="${firstUnreadEventId}"]` : undefined,
    resetKey: streamId,
  })

  return {
    firstUnreadEventId,
    dividerEventId: displayedUnreadId,
    isFading,
  }
}
