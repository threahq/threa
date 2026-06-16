import { useRef, useState, useEffect, useLayoutEffect, useCallback, type RefObject } from "react"
import { EVENT_PAGE_SIZE, SCROLL_FETCH_RATIO } from "@/lib/constants"

/** Number of items from the bottom before showing "Jump to latest" */
const JUMP_TO_LATEST_ITEM_THRESHOLD = 10

interface UseScrollBehaviorOptions {
  /** Whether data is currently loading (delays initial scroll) */
  isLoading: boolean
  /** Number of items in the list (triggers scroll when changes) */
  itemCount: number
  /** Called when user scrolls near the top (for loading older messages) */
  onScrollNearTop?: () => boolean
  /** Called when user scrolls near the bottom (for loading newer messages in jump-to mode) */
  onScrollNearBottom?: () => boolean
  /** Whether infinite scroll is currently fetching older events */
  isFetchingOlder?: boolean
  /** Whether infinite scroll is currently fetching newer events */
  isFetchingNewer?: boolean
  /** Threshold in pixels from bottom to consider "near bottom" for auto-scroll (default: 100) */
  bottomThreshold?: number
  /**
   * Number of items from the edge that triggers a fetch.
   * Default: EVENT_PAGE_SIZE * SCROLL_FETCH_RATIO (25)
   */
  triggerItemCount?: number
  /** When this key changes, all scroll state resets (e.g. streamId). */
  resetKey?: string
}

interface UseScrollBehaviorReturn {
  /** Ref to attach to the scrollable container */
  scrollContainerRef: RefObject<HTMLDivElement | null>
  /** Scroll handler to attach to the container's onScroll */
  handleScroll: () => void
  /** True when scrolled ~10+ items away from the bottom */
  isScrolledFarFromBottom: boolean
  /** Imperatively scroll to the bottom and clear the jump-to-latest state */
  scrollToBottom: (options?: { behavior?: ScrollBehavior; force?: boolean }) => void
  /** Disable auto-scroll (e.g. when navigating to a specific message via jump mode) */
  disableAutoScroll: () => void
}

/**
 * Hook for managing scroll behavior in chat-like interfaces.
 *
 * Features:
 * - Auto-scrolls to bottom on initial load and new messages
 * - Tracks if user has scrolled away (pauses auto-scroll)
 * - Resumes auto-scroll when user scrolls back to bottom
 * - Triggers fetch callbacks based on scroll position relative to item count
 * - Preserves scroll position when older content is prepended
 */
export function useScrollBehavior({
  isLoading,
  itemCount,
  onScrollNearTop,
  onScrollNearBottom,
  isFetchingOlder = false,
  isFetchingNewer = false,
  bottomThreshold = 100,
  triggerItemCount = Math.floor(EVENT_PAGE_SIZE * SCROLL_FETCH_RATIO),
  resetKey,
}: UseScrollBehaviorOptions): UseScrollBehaviorReturn {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)
  const [isScrolledFarFromBottom, setIsScrolledFarFromBottom] = useState(false)
  const prevItemCount = useRef(0)
  const prevScrollHeight = useRef(0)
  // Track previous-render fetching values so effects can detect true→false transitions.
  const prevIsFetchingOlder = useRef(false)
  const prevIsFetchingNewer = useRef(false)
  // One-shot guards: prevent onScrollNearTop/Bottom from firing repeatedly
  // between React re-renders while the user scrolls within the trigger zone.
  const olderFetchScheduled = useRef(false)
  const newerFetchScheduled = useRef(false)
  // When a force-scroll (e.g. Jump to latest) is in progress, intermediate
  // handleScroll events during smooth animation should not re-show the button.
  const isForceScrolling = useRef(false)
  // Timestamp of the last programmatic scrollToBottom call. Prevents handleScroll
  // from falsely clearing shouldAutoScroll when content grows rapidly (the native
  // scroll event fires before the new scrollTop settles).
  const lastProgrammaticScrollAt = useRef(0)

  // Reset all scroll state when the content source changes (e.g. stream switch).
  // Must be useLayoutEffect (not useEffect) so the reset runs synchronously
  // BEFORE the scroll-adjustment useLayoutEffect below — otherwise the scroll
  // logic reads stale prevItemCount from the old stream.
  useLayoutEffect(() => {
    shouldAutoScroll.current = true
    prevItemCount.current = 0
    prevScrollHeight.current = 0
    prevIsFetchingOlder.current = false
    prevIsFetchingNewer.current = false
    olderFetchScheduled.current = false
    newerFetchScheduled.current = false
    lastProgrammaticScrollAt.current = 0
    setIsScrolledFarFromBottom(false)
  }, [resetKey])

  const scrollToBottom = useCallback((options?: { behavior?: ScrollBehavior; force?: boolean }) => {
    const el = scrollContainerRef.current
    if (!el) return

    if (!options?.force && !shouldAutoScroll.current) {
      return
    }

    shouldAutoScroll.current = true
    lastProgrammaticScrollAt.current = performance.now()
    // For forced scrolls (Jump to latest), suppress handleScroll from re-showing
    // the button during smooth scroll animation. Cleared when scroll reaches bottom.
    if (options?.force) {
      isForceScrolling.current = true
      setIsScrolledFarFromBottom(false)
    }

    if (options?.behavior) {
      el.scrollTo({ top: el.scrollHeight, behavior: options.behavior })
      return
    }

    el.scrollTop = el.scrollHeight
  }, [])

  // Scroll position preservation and initial scroll.
  // useLayoutEffect runs synchronously after DOM mutation but before paint,
  // preventing a visible one-frame scroll jump when older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el || isLoading) return

    const oldCount = prevItemCount.current
    prevItemCount.current = itemCount

    if (oldCount === 0 && itemCount > 0) {
      scrollToBottom()
      return
    }

    // Only preserve scroll when older content was just prepended at the top
    // (isFetchingOlder transitioned true→false). Bottom-appended content
    // (WebSocket messages, newer pagination) needs no scrollTop adjustment.
    const olderContentJustArrived = prevIsFetchingOlder.current && !isFetchingOlder
    if (itemCount > oldCount && !shouldAutoScroll.current && olderContentJustArrived) {
      const heightDelta = el.scrollHeight - prevScrollHeight.current
      if (heightDelta > 0) {
        el.scrollTop += heightDelta
      }
    } else if (shouldAutoScroll.current) {
      scrollToBottom()
    } else if (itemCount > oldCount && !olderContentJustArrived && prevScrollHeight.current > 0) {
      // New content appended at bottom, but shouldAutoScroll was cleared by a
      // rapid scroll event during content growth (scrollHeight grew faster than
      // scrollTop could keep up). Check if the user was near the bottom before
      // this batch arrived — if so, re-arm auto-scroll.
      const wasNearBottom = prevScrollHeight.current - el.scrollTop - el.clientHeight < bottomThreshold
      if (wasNearBottom) {
        shouldAutoScroll.current = true
        scrollToBottom()
      }
    }
  }, [isLoading, itemCount, scrollToBottom, isFetchingOlder])

  // Capture previous-render values AFTER the adjustment effect has read them.
  // No dep array → runs every render, defined after adjustment so it runs second.
  // Must also be useLayoutEffect to maintain ordering with the adjustment above.
  useLayoutEffect(() => {
    // Reset one-shot guards when fetching completes (true→false transition)
    if (prevIsFetchingOlder.current && !isFetchingOlder) olderFetchScheduled.current = false
    if (prevIsFetchingNewer.current && !isFetchingNewer) newerFetchScheduled.current = false
    prevIsFetchingOlder.current = isFetchingOlder
    prevIsFetchingNewer.current = isFetchingNewer
    const el = scrollContainerRef.current
    if (el) {
      prevScrollHeight.current = el.scrollHeight
    }
  })

  // Re-anchor scroll position when the container resizes (e.g. mobile keyboard
  // opens/closes). Goal: the bottom-most visible row stays glued to the bottom
  // of the new viewport, so the message the user was reading doesn't drift
  // behind the keyboard. When the container shrinks the browser preserves
  // scrollTop, so the visible-area bottom moves UP relative to content by
  // exactly the height delta — compensate by shifting scrollTop by that delta.
  // Mirrors on grow so behavior is symmetric when the keyboard closes.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    let prevHeight = el.clientHeight

    const observer = new ResizeObserver(() => {
      const newHeight = el.clientHeight
      if (newHeight === prevHeight) return
      const delta = prevHeight - newHeight
      prevHeight = newHeight

      if (shouldAutoScroll.current) {
        el.scrollTop = el.scrollHeight
      } else if (delta !== 0) {
        el.scrollTop += delta
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return

    const el = scrollContainerRef.current
    const { scrollTop, scrollHeight, clientHeight } = el
    const isNearBottom = scrollHeight - scrollTop - clientHeight < bottomThreshold
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight

    if (itemCount === 0) return

    const avgItemHeight = scrollHeight / itemCount
    const triggerPixels = triggerItemCount * avgItemHeight
    const jumpThresholdPixels = JUMP_TO_LATEST_ITEM_THRESHOLD * avgItemHeight

    // Resume auto-scroll if user scrolls back to bottom.
    // Grace period: don't clear shouldAutoScroll within 150ms of a programmatic scroll.
    // When content grows rapidly (many socket messages), native scroll events fire
    // between React renders where scrollHeight has grown but scrollTop hasn't caught up,
    // making the user falsely appear to not be at the bottom.
    const isInGracePeriod = performance.now() - lastProgrammaticScrollAt.current < 150
    if (isInGracePeriod) {
      if (isNearBottom) shouldAutoScroll.current = true
    } else {
      shouldAutoScroll.current = isNearBottom
    }

    // Clear force-scroll guard once we've reached the bottom
    if (isNearBottom) {
      isForceScrolling.current = false
    }

    // Track whether user is scrolled far enough from bottom to show "Jump to latest".
    // During a force scroll (smooth animation), suppress updates to avoid the button
    // flickering back during intermediate scroll events.
    if (!isForceScrolling.current) {
      setIsScrolledFarFromBottom(distanceFromBottom > jumpThresholdPixels)
    }

    // Load older content when near top (one-shot until fetch completes)
    if (onScrollNearTop && scrollTop < triggerPixels && !isFetchingOlder && !olderFetchScheduled.current) {
      const started = onScrollNearTop()
      if (started !== false) {
        olderFetchScheduled.current = true
      }
    }

    // Load newer content when near bottom (jump-to mode, one-shot)
    if (onScrollNearBottom && !isFetchingNewer && !newerFetchScheduled.current) {
      if (distanceFromBottom < triggerPixels) {
        const started = onScrollNearBottom()
        if (started !== false) {
          newerFetchScheduled.current = true
        }
      }
    }
  }, [
    onScrollNearTop,
    onScrollNearBottom,
    isFetchingOlder,
    isFetchingNewer,
    bottomThreshold,
    itemCount,
    triggerItemCount,
  ])

  const disableAutoScroll = useCallback(() => {
    shouldAutoScroll.current = false
  }, [])

  return {
    scrollContainerRef,
    handleScroll,
    isScrolledFarFromBottom,
    scrollToBottom,
    disableAutoScroll,
  }
}
