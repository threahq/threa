import { useState, useEffect, useRef, useMemo, useCallback, type RefObject } from "react"
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
  /**
   * Whether the viewer's read position is known yet. While false (membership /
   * stream row still hydrating) `lastReadEventId` is not authoritative, so we
   * must not treat the first message as unread — doing so would latch a divider
   * that then sticks for the session (the divider persists; there is no
   * clear-on-read to undo a bad guess). Defaults to false: a caller must
   * affirmatively say the read position is resolved before any divider latches.
   */
  readStateResolved?: boolean
}

interface UseUnreadDividerResult {
  /** The calculated first unread event ID (for scroll-to behavior) */
  firstUnreadEventId: string | undefined
  /** The event ID where the divider should be shown, or undefined if hidden */
  dividerEventId: string | undefined
  /**
   * Dismiss the latched divider for the rest of this reading session (Escape
   * "escapes the unread block"). Stays dismissed until the stream changes.
   */
  dismiss: () => void
}

/**
 * Drive the unread divider's red → muted-gray "freshness" fade. The stream opens
 * at the live bottom, so the divider usually starts off-screen; the timer must
 * wait until the row has actually entered the viewport, or it would settle to
 * gray before the viewer ever scrolls up to see it. `readPast` short-circuits the
 * wait: once the read pointer reaches or passes the divider (the viewer read it,
 * or marked it read), it is no longer fresh, so dim immediately. Returns `isDimmed`.
 */
export function useDividerDim(
  scrollContainerRef: RefObject<HTMLElement | null>,
  dividerEventId: string | undefined,
  streamId: string,
  readPast = false
): boolean {
  const [isDimmed, setIsDimmed] = useState(false)
  const [seen, setSeen] = useState(false)

  // Reset when the stream or the latched divider changes.
  useEffect(() => {
    setSeen(false)
    setIsDimmed(false)
  }, [streamId, dividerEventId])

  // Reading past the divider (explicit "Mark as read" or scrolling through it)
  // dims it at once, ahead of the seen → 3s countdown.
  useEffect(() => {
    if (dividerEventId && readPast) setIsDimmed(true)
  }, [dividerEventId, readPast])

  // Latch `seen` the first time the divider row intersects the viewport. Once
  // seen, the effect re-runs and detaches (early return) — it's a one-shot.
  useEffect(() => {
    if (!dividerEventId || seen) return
    const el = scrollContainerRef.current
    let raf = 0
    const check = () => {
      raf = 0
      const scroller = scrollContainerRef.current
      if (!scroller) return
      const row = scroller.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(dividerEventId)}"]`)
      if (!row) return
      const sr = scroller.getBoundingClientRect()
      const rr = row.getBoundingClientRect()
      if (rr.top < sr.bottom && rr.bottom > sr.top) setSeen(true)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check)
    }
    schedule()
    el?.addEventListener("scroll", schedule, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      el?.removeEventListener("scroll", schedule)
    }
  }, [dividerEventId, streamId, seen, scrollContainerRef])

  // Start the red → gray countdown only once the divider has been seen.
  useEffect(() => {
    if (!dividerEventId || !seen) return
    const dimTimer = setTimeout(() => setIsDimmed(true), 3000)
    return () => clearTimeout(dimTimer)
  }, [dividerEventId, seen])

  return isDimmed
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
  readStateResolved = false,
}: UseUnreadDividerOptions): UseUnreadDividerResult {
  const firstUnreadEventId = useMemo(() => {
    if (events.length === 0 || !readStateResolved) return undefined

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
  }, [events, lastReadEventId, currentUserId, readStateResolved])

  // Latch the first unread position for this stream and hold it for the whole
  // reading session. Done in render (not an effect) so it's immune to effect
  // ordering: switching to a stream that already has unread data changes
  // `streamId` and `firstUnreadEventId` in the same commit, and an effect-based
  // latch+reset pair would clear the ref after the latch ran and never re-fire.
  // The ref resets on stream change, then captures the first non-empty
  // `firstUnreadEventId`; auto-mark-as-read later clearing the live unread does
  // not move or drop it.
  const latchRef = useRef<{ streamId: string; eventId: string | undefined }>({ streamId, eventId: undefined })
  if (latchRef.current.streamId !== streamId) {
    latchRef.current = { streamId, eventId: undefined }
  }
  if (firstUnreadEventId && latchRef.current.eventId !== firstUnreadEventId) {
    // Capture the first unread, then hold it for the session — auto-mark-as-read
    // advancing the live unread forward does NOT move it. The one exception is a
    // BACKWARD move (mark-as-unread re-surfaced messages above the divider): the
    // first unread is now earlier, so the divider must follow it up.
    const latchedIdx = latchRef.current.eventId ? events.findIndex((e) => e.id === latchRef.current.eventId) : -1
    const firstIdx = events.findIndex((e) => e.id === firstUnreadEventId)
    if (!latchRef.current.eventId || (firstIdx >= 0 && (latchedIdx < 0 || firstIdx < latchedIdx))) {
      latchRef.current.eventId = firstUnreadEventId
    }
  }

  // Explicit dismissal (Escape / ✕). A latched divider has no clear-on-read, so a
  // separate flag overrides it. Keyed to the dismissed position (not just the
  // stream) so a later mark-as-unread that moves the divider to an EARLIER row
  // re-shows it. Reset on stream change so re-entering a stream with unread shows
  // the divider again.
  const [dismissed, setDismissed] = useState<{ streamId: string; eventId: string | undefined } | undefined>(undefined)
  const dismiss = useCallback(() => setDismissed({ streamId, eventId: latchRef.current.eventId }), [streamId])
  const latched = latchRef.current.eventId
  const isDismissed = dismissed?.streamId === streamId && dismissed?.eventId === latched
  const displayedUnreadId = isDismissed ? undefined : latched

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
    dismiss,
  }
}
