import { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react"
import type { VirtuosoHandle, IndexLocationWithAlign } from "react-virtuoso"

/**
 * Arbitrary high starting index for Virtuoso's firstItemIndex.
 * When older messages are prepended, we decrement this value so
 * Virtuoso can maintain scroll position automatically.
 */
const FIRST_ITEM_INDEX = 1_000_000

/** Items from the bottom before showing "Jump to latest" */
const JUMP_TO_LATEST_ITEM_THRESHOLD = 10

interface UseVirtuosoScrollOptions {
  /** Total item count */
  itemCount: number
  /** Stable key for item at index (used for prepend detection) */
  getItemKey: (index: number) => string
  /** When this key changes, all scroll state resets (e.g. streamId) */
  resetKey?: string
  /**
   * When true, skip the initial scroll-to-bottom on first load.
   * Used for deep-link / jump-to-message navigation.
   */
  skipInitialScroll?: boolean
}

interface UseVirtuosoScrollReturn {
  /** Ref to attach to the Virtuoso component */
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  /** Virtual index of the first item (decreases as items are prepended) */
  firstItemIndex: number
  /** Initial index to scroll to on first render */
  initialTopMostItemIndex: IndexLocationWithAlign | undefined
  /** True when scrolled ~10+ items away from the bottom */
  isScrolledFarFromBottom: boolean
  /** Whether auto-scroll (followOutput) should be active */
  shouldFollowOutput: boolean
  /** Imperatively scroll to the bottom */
  scrollToBottom: (options?: { behavior?: "auto" | "smooth"; force?: boolean }) => void
  /** Disable auto-scroll (e.g. when navigating to a specific message via jump mode) */
  disableAutoScroll: () => void
  /** Called by Virtuoso's atBottomStateChange */
  handleAtBottomChange: (atBottom: boolean) => void
  /** Called by Virtuoso's rangeChanged to track distance from bottom */
  handleRangeChanged: (range: { startIndex: number; endIndex: number }) => void
  /** Attach to Virtuoso's scrollerRef to enable resize handling */
  handleScrollerRef: (ref: HTMLElement | Window | null) => void
  /**
   * Reset the prepend-detection baseline. Call this when the event window is
   * replaced wholesale (e.g. after exitJumpMode) so the next render isn't
   * mis-detected as a prepend.
   */
  resetPrependState: () => void
}

export function useVirtuosoScroll({
  itemCount,
  getItemKey,
  resetKey,
  skipInitialScroll = false,
}: UseVirtuosoScrollOptions): UseVirtuosoScrollReturn {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [isScrolledFarFromBottom, setIsScrolledFarFromBottom] = useState(false)

  // True once Virtuoso has reported an initial atBottomStateChange for the
  // current stream — before that, `rangeChanged` fires with transitional
  // ranges (e.g. during the scroll to `initialTopMostItemIndex`) that would
  // briefly flash the "Jump to latest" button on long streams.
  const hasSettledRef = useRef(false)

  // Auto-scroll state: when true, new messages cause scroll to bottom
  const isAtBottomRef = useRef(!skipInitialScroll)
  const [shouldFollowOutput, setShouldFollowOutput] = useState(!skipInitialScroll)

  // Prepend detection — tracked via ref so firstItemIndex updates in the
  // SAME render as data changes (not one render late via useLayoutEffect).
  // This prevents the visual jump that occurred when Virtuoso saw new data
  // with the old firstItemIndex for one frame.
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX)
  const prevItemCountRef = useRef(0)
  // Map of item key -> index from the previous render. Comparing the index of
  // a surviving (anchor) row across renders is what lets us compensate
  // firstItemIndex for any window shift — prepend, leading removal, or a window
  // that slides forward (drops leading rows AND appends, count ~unchanged).
  const prevKeyIndexMapRef = useRef<Map<string, number>>(new Map())
  const lastResetKeyRef = useRef(resetKey)

  // Scroller element stored in state (not a ref) so the ResizeObserver effect
  // re-runs when Virtuoso mounts its scroller asynchronously (e.g. after an
  // isLoading skeleton is replaced).
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null)

  // Reset the ref-backed virtual-index state synchronously when the stream
  // changes, BEFORE the re-anchor block below runs. This must not live in a
  // layout effect: that runs after the render that already recorded the new
  // stream's baseline, so it would clobber that baseline (skipping the first
  // window-slide compensation) and hand the freshly-keyed Virtuoso the previous
  // stream's index base for one frame before correcting it — a visible jump.
  // resetKey is unchanged on the initial mount (the ref is seeded with it), so
  // this only fires on actual stream switches.
  const resetKeyChanged = lastResetKeyRef.current !== resetKey
  if (resetKeyChanged) {
    lastResetKeyRef.current = resetKey
    firstItemIndexRef.current = FIRST_ITEM_INDEX
    prevItemCountRef.current = 0
    prevKeyIndexMapRef.current = new Map()
    hasSettledRef.current = false
    isAtBottomRef.current = !skipInitialScroll
  }

  // Reset React-visible state when the stream changes. The ref-backed state
  // resets synchronously above so Virtuoso already gets the right
  // firstItemIndex on the first render for the new stream; this effect only
  // catches up the state that drives re-renders. Honor skipInitialScroll so
  // deep-link navigation to a cached stream does not briefly scroll to bottom
  // before the scrollToMessage retry loop kicks in.
  useLayoutEffect(() => {
    setIsScrolledFarFromBottom(false)
    isAtBottomRef.current = !skipInitialScroll
    setShouldFollowOutput(!skipInitialScroll)
  }, [resetKey, skipInitialScroll])

  // Re-anchor firstItemIndex synchronously during render. This runs in the
  // same render pass where data changes, so Virtuoso receives the updated
  // firstItemIndex and data array together — no one-frame-late jump.
  //
  // We can't infer the shift from count alone: on a cold first visit the
  // window mounts off stale IDB data, then the bootstrap response slides the
  // window forward — leading rows drop while newer ones append, so the count
  // barely moves even though every row shifted index. A count-growth heuristic
  // misses that and leaves firstItemIndex stale, jumping the viewport.
  //
  // Instead, find the first row that survived from the previous render (the
  // anchor) and compare its old vs new index. Virtuoso keeps a row visually
  // fixed when `firstItemIndex + index` is constant, so to preserve position
  // across a shift of `currentIndex - previousIndex` we move firstItemIndex by
  // the negation of that delta. This handles prepend, leading removal, and a
  // sliding window uniformly.
  if (itemCount > 0) {
    const currentKeyIndexMap = new Map<string, number>()
    let preservedAnchor: { previousIndex: number; currentIndex: number } | null = null
    for (let index = 0; index < itemCount; index++) {
      const key = getItemKey(index)
      currentKeyIndexMap.set(key, index)
      if (preservedAnchor === null) {
        const previousIndex = prevKeyIndexMapRef.current.get(key)
        if (previousIndex !== undefined) {
          preservedAnchor = { previousIndex, currentIndex: index }
        }
      }
    }
    // When the list goes from empty to populated (e.g. mid stream-switch
    // where the previous stream's empty result was stamped as settled),
    // Virtuoso needs to run its initial scroll again. Re-arm hasSettledRef
    // so transitional rangeChanged events during that scroll can't flash
    // the "Jump to latest" button.
    if (prevItemCountRef.current === 0) {
      hasSettledRef.current = false
    }
    if (prevItemCountRef.current > 0 && preservedAnchor !== null) {
      const indexDelta = preservedAnchor.currentIndex - preservedAnchor.previousIndex
      if (indexDelta !== 0) {
        firstItemIndexRef.current -= indexDelta
      }
    }
    prevItemCountRef.current = itemCount
    prevKeyIndexMapRef.current = currentKeyIndexMap
  } else if (prevItemCountRef.current !== 0) {
    // List emptied (e.g. mid stream-switch). Drop the stale baseline so the
    // next populated render is treated as a fresh start and re-arms the
    // settle gate rather than matching keys against the old window.
    prevItemCountRef.current = 0
    prevKeyIndexMapRef.current = new Map()
    hasSettledRef.current = false
  }

  const scrollToBottom = useCallback(
    (options?: { behavior?: "auto" | "smooth"; force?: boolean }) => {
      if (!options?.force && !isAtBottomRef.current) return
      if (itemCount === 0) return

      isAtBottomRef.current = true
      setShouldFollowOutput(true)
      setIsScrolledFarFromBottom(false)

      virtuosoRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior: options?.behavior ?? "auto",
      })
    },
    [itemCount]
  )

  const disableAutoScroll = useCallback(() => {
    isAtBottomRef.current = false
    setShouldFollowOutput(false)
  }, [])

  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      // Ignore atBottomStateChange while the list is empty — Virtuoso reports
      // "at bottom" for an empty list, which would prematurely settle the ref
      // and let transitional rangeChanged events flash the Jump button once
      // real items arrive.
      if (itemCount === 0) return
      hasSettledRef.current = true
      isAtBottomRef.current = atBottom
      setShouldFollowOutput(atBottom)
      if (atBottom) {
        setIsScrolledFarFromBottom(false)
      }
    },
    [itemCount]
  )

  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      if (itemCount === 0) return
      // Ignore range updates until Virtuoso reports its initial bottom state.
      // The transient ranges that fire during the initial scroll to LAST would
      // otherwise flash the "Jump to latest" button on long streams.
      if (!hasSettledRef.current) return
      const lastVirtualIndex = firstItemIndexRef.current + itemCount - 1
      const distFromEnd = lastVirtualIndex - range.endIndex
      setIsScrolledFarFromBottom(distFromEnd > JUMP_TO_LATEST_ITEM_THRESHOLD)
    },
    [itemCount]
  )

  // Re-anchor scroll position when the scroll container resizes (e.g. mobile
  // keyboard opens/closes). Two cases:
  //  - User at bottom: scroll to LAST so the latest message stays glued
  //    above the composer. Debounced because Chrome with
  //    `interactive-widget=resizes-content` fires resize on every animation
  //    frame, and scrollToIndex during the animation can fight Virtuoso's
  //    own intra-resize reflow.
  //  - User scrolled away from bottom: shift the scroller's scrollTop by
  //    the height delta so the previously-visible bottom row stays anchored
  //    at the new visible-area bottom. Browsers preserve scrollTop across
  //    container shrink, so the bottom of the view otherwise drifts upward
  //    relative to content and the message the user was reading slides
  //    behind the keyboard. Applied synchronously across animation frames so
  //    the anchor tracks continuously, not in a single jump at the end.
  const resizeTimerRef = useRef<number | undefined>(undefined)

  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    const el = ref as HTMLElement | null
    setScrollerEl(el)
    // Apply scroll-related CSS to Virtuoso's actual scroller element (not the outer wrapper)
    if (el) {
      el.style.overflowX = "hidden"
      el.style.overscrollBehaviorY = "contain"
      el.style.overflowAnchor = "none"
    }
  }, [])

  useEffect(() => {
    if (!scrollerEl) return

    let prevHeight = scrollerEl.clientHeight
    let isInitialFire = true

    const observer = new ResizeObserver(() => {
      const newHeight = scrollerEl.clientHeight
      const delta = prevHeight - newHeight
      prevHeight = newHeight
      const wasInitialFire = isInitialFire
      isInitialFire = false

      if (!isAtBottomRef.current) {
        if (delta !== 0) scrollerEl.scrollTop += delta
        return
      }

      // The LAST safety-net snap fires on two specific events: the initial
      // observe() callback (cold-boot inside CoordinatedLoadingGate, where
      // no resize delta occurs but the scroller needs to land at the bottom)
      // and real height changes (mobile keyboard opens/closes). Intermediate,
      // delta=0 fires from Virtuoso's own item-measurement passes must NOT
      // re-arm the snap — when a deep-link jump is centering a target message,
      // those measurement fires would otherwise repeatedly snap to LAST and
      // fight scrollToMessage, ending the user on the latest message instead
      // of the linked one.
      if (!wasInitialFire && delta === 0) return

      window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "end",
          behavior: "auto",
        })
      }, 100)
    })

    observer.observe(scrollerEl)
    return () => {
      observer.disconnect()
      window.clearTimeout(resizeTimerRef.current)
    }
  }, [scrollerEl])

  const resetPrependState = useCallback(() => {
    prevItemCountRef.current = 0
    prevKeyIndexMapRef.current = new Map()
  }, [])

  const initialTopMostItemIndex =
    skipInitialScroll || itemCount === 0 ? undefined : ({ index: "LAST", align: "end" } as const)

  return {
    virtuosoRef,
    firstItemIndex: firstItemIndexRef.current,
    initialTopMostItemIndex,
    // On the stream-switch render the state resets above are still queued in
    // the layout effect, so surface the fresh values directly for that frame
    // to avoid carrying the previous stream's scroll affordances over.
    isScrolledFarFromBottom: resetKeyChanged ? false : isScrolledFarFromBottom,
    shouldFollowOutput: resetKeyChanged ? !skipInitialScroll : shouldFollowOutput,
    scrollToBottom,
    disableAutoScroll,
    handleAtBottomChange,
    handleRangeChanged,
    handleScrollerRef,
    resetPrependState,
  }
}
