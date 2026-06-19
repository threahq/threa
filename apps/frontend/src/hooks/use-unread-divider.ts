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
  /** Whether the divider has settled to its muted (gray) resting state */
  isDimmed: boolean
}

/**
 * Hook to manage the "New" unread divider display state.
 *
 * - Calculates the first unread event from another user
 * - Latches the divider at that position and keeps it there for the whole
 *   reading session: it starts red, dims to gray after a few seconds, but
 *   stays physically present until the user switches streams. Auto-mark-as-read
 *   clearing `firstUnreadEventId` does NOT remove it.
 * - Resets when switching streams (re-entering a now-read stream shows nothing)
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
  const firstUnreadEventId = useMemo(() => {
    if (events.length === 0) return undefined

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

  // The divider position is latched once per reading session and persists at
  // that spot until the stream changes. `displayedUnreadId` is the latched
  // position; `isDimmed` flips it from red to gray a few seconds in.
  const [displayedUnreadId, setDisplayedUnreadId] = useState<string | undefined>(undefined)
  const [isDimmed, setIsDimmed] = useState(false)
  const hasShownDivider = useRef(false)
  const previousStreamId = useRef(streamId)

  useEffect(() => {
    if (firstUnreadEventId && !hasShownDivider.current) {
      hasShownDivider.current = true
      setDisplayedUnreadId(firstUnreadEventId)
      setIsDimmed(false)
    }
  }, [firstUnreadEventId])

  // Dim the latched divider red → gray after a few seconds, keeping it mounted.
  // Keyed on `displayedUnreadId`, not `firstUnreadEventId`, so an
  // auto-mark-as-read that clears the live unread mid-countdown can't cancel the
  // timer and strand the line on red — the divider always settles to gray.
  useEffect(() => {
    if (!displayedUnreadId) return
    const dimTimer = setTimeout(() => setIsDimmed(true), 3000)
    return () => clearTimeout(dimTimer)
  }, [displayedUnreadId])

  useEffect(() => {
    if (previousStreamId.current === streamId) return
    previousStreamId.current = streamId
    hasShownDivider.current = false
    setDisplayedUnreadId(undefined)
    setIsDimmed(false)
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

  useScrollToElement({
    enabled: scrollToUnread && !isLoading && !!firstUnreadEventId && !deepLinkedRef.current.seen,
    selector: firstUnreadEventId ? `[data-event-id="${firstUnreadEventId}"]` : undefined,
    resetKey: streamId,
  })

  return {
    firstUnreadEventId,
    dividerEventId: displayedUnreadId,
    isDimmed,
  }
}
