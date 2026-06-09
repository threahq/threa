import { useRef, useState, useCallback, useEffect, useLayoutEffect } from "react"
import type { VirtualizerHandle } from "virtua"

/** Distance (px) from the bottom within which we treat the list as "at bottom". */
const AT_BOTTOM_PX = 32
/** Distance (px) from the bottom past which the "Jump to latest" affordance shows. */
const JUMP_TO_LATEST_PX = 600
/** Window (ms) during which scroll events are treated as our own programmatic
 *  snaps and must not disarm follow (covers the initial measure-and-converge). */
const PROGRAMMATIC_SCROLL_MS = 150

interface UseTimelineScrollOptions {
  /** Total item count of the virtualized list. */
  itemCount: number
  /** Stable key of the item at index 0, or null when empty. Drives prepend detection. */
  getFirstKey: () => string | null
  /** When this key changes, all scroll state resets (e.g. streamId). */
  resetKey?: string
  /**
   * Skip the initial scroll-to-bottom on first load. Used for deep-link /
   * jump-to-message navigation, where the caller drives the scroll imperatively.
   */
  skipInitialScroll?: boolean
  /**
   * True while reading a deep-linked / searched history window. Reaching the
   * live tail in this mode must NOT re-arm auto-follow — the user is anchored
   * on a specific message, not following new output.
   */
  isJumpMode?: boolean
}

interface UseTimelineScrollReturn {
  /** Ref for virtua's `Virtualizer`/`VList` imperative handle. */
  listRef: React.RefObject<VirtualizerHandle | null>
  /** Ref for the scroll container we own (attach to the scrollable `<div>`). */
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** Ref for the inner content wrapper (sized to the full scroll height). */
  contentRef: React.RefObject<HTMLDivElement | null>
  /**
   * virtua `shift` value for the current render. True only when an older page
   * was prepended while reading history, so virtua maintains position from the
   * end and the viewport does not move — including mid-scroll.
   */
  shift: boolean
  /** True when scrolled far enough from the bottom to show "Jump to latest". */
  isScrolledFarFromBottom: boolean
  /** True while parked at the live tail (auto-following new output). */
  isFollowingTailRef: React.MutableRefObject<boolean>
  /** Imperatively scroll to the very bottom (the composer-spacer edge). */
  scrollToBottom: (options?: { force?: boolean; behavior?: ScrollBehavior }) => void
  /** Disable auto-follow (e.g. when a deep-link jump takes over). */
  disableAutoScroll: () => void
  /** Attach to virtua's `onScroll` (and/or call after a native scroll). */
  handleScroll: () => void
  /**
   * Reset the prepend-detection baseline. Call when the event window is
   * replaced wholesale (e.g. after exitJumpMode) so the next render isn't
   * mis-detected as a prepend.
   */
  resetShiftBaseline: () => void
}

/**
 * Scroll engine for the virtualized stream/channel timeline, built on `virtua`.
 *
 * Unlike the previous react-virtuoso integration, the scroll container is owned
 * here (a plain overflow `<div>`), so every scroll decision — at-bottom, follow,
 * jump-to-latest, keyboard resize — reads native `scrollTop/scrollHeight/
 * clientHeight` with no library tug-of-war. The one thing delegated to virtua is
 * the hard part: holding the viewport when an older page is prepended, via its
 * `shift` prop (scroll position maintained from the end). virtua also re-pins on
 * individual item resize, so off-screen media loading above the fold no longer
 * shifts the reading position.
 */
export function useTimelineScroll({
  itemCount,
  getFirstKey,
  resetKey,
  skipInitialScroll = false,
  isJumpMode = false,
}: UseTimelineScrollOptions): UseTimelineScrollReturn {
  const listRef = useRef<VirtualizerHandle>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [isScrolledFarFromBottom, setIsScrolledFarFromBottom] = useState(false)

  // Auto-follow the live tail. Seeded false for deep-link mounts so we don't
  // snap to bottom before the jump positions on its target.
  const isFollowingTailRef = useRef(!skipInitialScroll)

  // Prepend detection. Comparing the first row's key across renders tells us an
  // older page landed (or the window trimmed from the start); virtua's `shift`
  // then holds the viewport from the end.
  const prevFirstKeyRef = useRef<string | null>(null)
  const prevCountRef = useRef(0)
  const lastResetKeyRef = useRef(resetKey)
  const didInitialScrollRef = useRef(false)

  // Timestamp until which scroll events are treated as our own programmatic
  // snaps (initial scroll, follow re-pin). During that window handleScroll must
  // not disarm follow: mid-convergence the content is still growing underneath,
  // so we read as "not at bottom" even though we're chasing it.
  const programmaticUntilRef = useRef(0)
  // Current item count, read inside the long-lived ResizeObserver closure.
  const itemCountRef = useRef(itemCount)
  itemCountRef.current = itemCount

  // Reset all scroll state synchronously when the stream changes, before the
  // shift computation below runs for the new stream's first render. A layout
  // effect would run a render too late and mis-detect the first window as a
  // prepend. resetKey is seeded with the initial value, so this only fires on
  // real stream switches, not the initial mount.
  if (lastResetKeyRef.current !== resetKey) {
    lastResetKeyRef.current = resetKey
    prevFirstKeyRef.current = null
    prevCountRef.current = 0
    didInitialScrollRef.current = false
    isFollowingTailRef.current = !skipInitialScroll
  }

  // Compute `shift` for this render. Only while reading history (not following
  // the tail): if the first row's identity changed since last render, content
  // was added/removed at the start, so maintain from the end. Appends at the
  // bottom (live messages, newer pagination) leave the first key untouched ->
  // shift stays false, which is what virtua wants for end-side growth.
  const firstKey = itemCount > 0 ? getFirstKey() : null
  let shift = false
  if (itemCount > 0 && prevCountRef.current > 0 && !isFollowingTailRef.current) {
    if (prevFirstKeyRef.current !== null && firstKey !== prevFirstKeyRef.current) {
      shift = true
    }
  }
  prevFirstKeyRef.current = firstKey
  prevCountRef.current = itemCount

  // Go to the absolute bottom of a *virtualized* list. Native scrollTop =
  // scrollHeight alone undershoots, because only the top window is measured at
  // mount and the rest are size estimates — so the list lands well short of the
  // bottom. First ask virtua to land on the last item (it converges past the
  // estimates by rendering + measuring the bottom region), then snap to the
  // absolute bottom so the composer footer spacer is included.
  const snapToBottom = useCallback(
    (behavior?: ScrollBehavior) => {
      const el = scrollerRef.current
      if (!el) return
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS
      if (itemCountRef.current > 0) {
        try {
          listRef.current?.scrollToIndex(itemCountRef.current - 1, { align: "end" })
        } catch {
          // Not-yet-measured list can throw; the ResizeObserver snap converges.
        }
      }
      if (behavior === "smooth") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
      } else {
        el.scrollTop = el.scrollHeight
      }
    },
    [listRef]
  )

  const scrollToBottom = useCallback(
    (options?: { force?: boolean; behavior?: ScrollBehavior }) => {
      if (!options?.force && !isFollowingTailRef.current) return
      isFollowingTailRef.current = true
      setIsScrolledFarFromBottom(false)
      snapToBottom(options?.behavior)
    },
    [snapToBottom]
  )

  const disableAutoScroll = useCallback(() => {
    isFollowingTailRef.current = false
  }, [])

  const resetShiftBaseline = useCallback(() => {
    prevFirstKeyRef.current = null
    prevCountRef.current = 0
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // Skip our own programmatic snaps: mid-convergence the content is still
    // growing underneath, so disarming follow here is what stranded the list
    // ~2 screens up on load.
    if (performance.now() < programmaticUntilRef.current) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= AT_BOTTOM_PX
    // Reaching the tail re-arms follow — except in jump mode, where the user is
    // anchored on a deep-linked message and transient atBottom from reflow must
    // never yank them to the live tail.
    isFollowingTailRef.current = atBottom && !isJumpMode
    setIsScrolledFarFromBottom(distanceFromBottom > JUMP_TO_LATEST_PX)
  }, [isJumpMode])

  // Initial scroll-to-bottom once the first window is populated. Runs in a
  // layout effect (pre-paint) against the owned scroller so there is no visible
  // jump from the top. The content ResizeObserver below keeps it pinned as
  // virtua measures real item heights.
  useLayoutEffect(() => {
    if (skipInitialScroll || didInitialScrollRef.current || itemCount === 0) return
    if (!scrollerRef.current) return
    isFollowingTailRef.current = true
    didInitialScrollRef.current = true
    snapToBottom()
  }, [itemCount, skipInitialScroll, resetKey, snapToBottom])

  // Keep the tail pinned while following, and absorb keyboard viewport changes
  // while reading. Two observed targets, one observer:
  //  - content height grows (live append, virtua measuring real heights): if
  //    following, snap back to the bottom so the latest message stays glued
  //    above the composer.
  //  - viewport height changes (mobile keyboard): following -> snap to bottom;
  //    reading -> shift scrollTop by the delta so the row under the user's eyes
  //    stays put as the visible area shrinks/grows. virtua already handles
  //    item-content resize while reading, so we only compensate the viewport.
  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    let prevClientHeight = scroller.clientHeight
    const observer = new ResizeObserver((entries) => {
      const el = scrollerRef.current
      if (!el) return
      if (isFollowingTailRef.current) {
        // Keep landing on the last item as virtua measures real heights during
        // the initial convergence, then pin to the absolute bottom. Marked
        // programmatic so the resulting scroll event doesn't disarm follow.
        programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS
        if (itemCountRef.current > 0) {
          try {
            listRef.current?.scrollToIndex(itemCountRef.current - 1, { align: "end" })
          } catch {
            // Not-yet-measured list can throw; the scrollTop snap still converges.
          }
        }
        el.scrollTop = el.scrollHeight
        prevClientHeight = el.clientHeight
        return
      }
      // Only a viewport (scroller) resize should move a read position; content
      // entries leave clientHeight unchanged, so their delta is 0 (no-op).
      const hasViewportEntry = entries.some((entry) => entry.target === el)
      if (!hasViewportEntry) return
      const clientHeight = el.clientHeight
      const delta = prevClientHeight - clientHeight
      prevClientHeight = clientHeight
      if (delta !== 0) el.scrollTop += delta
    })

    observer.observe(scroller)
    observer.observe(content)
    return () => observer.disconnect()
  }, [resetKey])

  return {
    listRef,
    scrollerRef,
    contentRef,
    shift,
    isScrolledFarFromBottom,
    isFollowingTailRef,
    scrollToBottom,
    disableAutoScroll,
    handleScroll,
    resetShiftBaseline,
  }
}
