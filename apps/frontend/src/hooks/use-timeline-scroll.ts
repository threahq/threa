import { useRef, useState, useCallback, useEffect, useLayoutEffect } from "react"
import type { VirtualizerHandle } from "virtua"
import { scrollDebug } from "@/lib/scroll-debug"

/** Distance (px) from the bottom within which we treat the list as "at bottom". */
const AT_BOTTOM_PX = 32
/** Distance (px) from the bottom past which the "Jump to latest" affordance shows. */
const JUMP_TO_LATEST_PX = 600
/** A scroll-away-from-bottom only disarms follow if a real user gesture landed
 *  within this window; otherwise it's content growth and the tail re-pins. */
const USER_SCROLL_GRACE_MS = 300
/** Consecutive frames of unchanged scrollHeight that mark the cold-load settle
 *  as converged, so the content can be revealed without a visible bounce. */
const SETTLE_STABLE_FRAMES = 3

/**
 * Height (px) of the floating composer, published as `--composer-height` on the
 * editor zone and reserved by the timeline's footer spacer. The last message
 * sitting just above that spacer IS visually "at the bottom", so at-bottom math
 * must treat the spacer as dead space — otherwise the list reads ~a composer
 * height short of the bottom and wrongly disarms follow.
 */
function readComposerHeight(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue("--composer-height")
  const px = Number.parseFloat(raw)
  return Number.isFinite(px) ? px : 0
}

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
  /**
   * Timestamp of the last genuine user scroll gesture (wheel/touch/pointer/key)
   * on the scroller. A scroll away from the bottom disarms auto-follow when it
   * was user-driven; content growth (new message, link preview, virtua
   * measuring real heights) moves us off the bottom with no gesture and must NOT
   * disarm follow — otherwise the tail won't re-pin and new messages stop
   * pushing the view up. The scrollTop-delta check below is the primary signal
   * (it catches the desktop scrollbar, which fires no gesture event); this stamp
   * is the secondary signal for touch/wheel that hasn't yet moved scrollTop.
   */
  userInteractedAtRef?: React.MutableRefObject<number>
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
  /** True during a cold-load settle — the caller masks the content (skeleton
   *  overlay) until it flips false so the measurement bounce stays off-screen. */
  isInitialSettling: boolean
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
 * The scroll container is owned here (a plain overflow `<div>`), so every scroll
 * decision reads native `scrollTop/scrollHeight/clientHeight` with no library
 * tug-of-war. The design rests on two ideas:
 *
 *  1. **One idempotent pin.** Staying glued to the tail means exactly one thing:
 *     `scrollTop = scrollHeight`. Every event that can change geometry while
 *     following — content growth (new message, media decode, virtua measuring),
 *     the footer spacer resizing as the composer expands/collapses, the viewport
 *     shrinking as the keyboard opens — funnels through `pinToBottom`, observed
 *     by a single `ResizeObserver`. They cannot fight because they all target
 *     the same place; re-pinning is a no-op once already pinned.
 *
 *  2. **Our own pins are invisible to the scroll-up detector.** `pinToBottom`
 *     updates the scroll-up baseline (`prevScrollTop`) synchronously with the
 *     write, so the `scroll` event it triggers reads `top === prevTop` and never
 *     disarms follow. That is what removes the need for programmatic
 *     time-windows arbitrating "was this scroll mine or the user's": the user is
 *     detected purely by `scrollTop` moving toward the top (device-independent —
 *     scrollbar drag, wheel, touch, PageUp), guarded against content shrink.
 *
 * The one thing delegated to virtua is the hard part it does well: holding the
 * viewport when an older page is prepended, via its `shift` prop.
 */
export function useTimelineScroll({
  itemCount,
  getFirstKey,
  resetKey,
  skipInitialScroll = false,
  isJumpMode = false,
  userInteractedAtRef,
}: UseTimelineScrollOptions): UseTimelineScrollReturn {
  const listRef = useRef<VirtualizerHandle>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [isScrolledFarFromBottom, setIsScrolledFarFromBottom] = useState(false)

  // Mask the content during the cold-load settle. On the first load of a stream
  // virtua measures item heights frame-by-frame, so scrollHeight oscillates and
  // our re-pin chases it. Keep the content hidden (the component renders a
  // skeleton overlay) until the height stabilises, so convergence happens
  // off-screen. Revisits are already measured, so this reveals immediately.
  // Deep-link mounts drive their own jump, so they are never masked.
  const [isInitialSettling, setIsInitialSettling] = useState(!skipInitialScroll)

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

  // Last scrollTop / scrollHeight observed by handleScroll (and written by every
  // programmatic pin, so our own writes never read as a user scroll). A
  // scrollTop decrease here is the user scrolling up (device-independent:
  // scrollbar drag, wheel, touch, keyboard PageUp), which disarms follow — BUT
  // only when scrollHeight didn't shrink. When content shrinks (composer
  // collapsing to its minimal view on send/blur, a row removed) the browser
  // clamps scrollTop down on its own; that is not a user scroll, and treating it
  // as one wrongly disarmed follow so a freshly-sent message stayed hidden
  // behind the composer. Content growth raises scrollHeight rather than lowering
  // scrollTop, so it never reads as a scroll-up either.
  const prevScrollTopRef = useRef(0)
  const prevScrollHeightRef = useRef(0)
  const initialSettleRafRef = useRef(0)
  const initialSettleCleanupRef = useRef<(() => void) | null>(null)

  // Reset all scroll state synchronously when the stream changes, before the
  // shift computation below runs for the new stream's first render. A layout
  // effect would run a render too late and mis-detect the first window as a
  // prepend. resetKey is seeded with the initial value, so this only fires on
  // real stream switches, not the initial mount.
  if (lastResetKeyRef.current !== resetKey) {
    lastResetKeyRef.current = resetKey
    prevFirstKeyRef.current = null
    prevCountRef.current = 0
    prevScrollTopRef.current = 0
    prevScrollHeightRef.current = 0
    didInitialScrollRef.current = false
    isFollowingTailRef.current = !skipInitialScroll
    // Re-mask for the new stream's cold-load settle (a no-op when it converges
    // instantly, e.g. revisiting an already-measured stream).
    setIsInitialSettling(!skipInitialScroll)
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

  // The single pin. Go to the absolute bottom: scrollTop = scrollHeight is
  // browser-clamped to the true maximum, which includes the composer footer
  // spacer below virtua's items — so the last message lands *above* the
  // composer, not behind it. (Deliberately NOT virtua's scrollToIndex: it aligns
  // to the item and can't see the trailing footer spacer, so it parks the last
  // message at the very bottom edge, under the composer.)
  //
  // Updating the scroll-up baseline in the same statement is load-bearing: the
  // `scroll` event this write triggers then reads `top === prevTop`, so
  // handleScroll sees no user movement and follow stays armed. That is what lets
  // the ResizeObserver, the keyboard backstop, and the cold-load settle all pin
  // freely without a programmatic time-window to tell them apart.
  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    prevScrollTopRef.current = el.scrollTop
    prevScrollHeightRef.current = el.scrollHeight
  }, [])

  const scrollToBottom = useCallback(
    (options?: { force?: boolean; behavior?: ScrollBehavior }) => {
      if (!options?.force && !isFollowingTailRef.current) {
        scrollDebug("scrollToBottom skipped (not following, no force)", { force: options?.force })
        return
      }
      scrollDebug("scrollToBottom", { force: options?.force, wasFollowing: isFollowingTailRef.current })
      isFollowingTailRef.current = true
      setIsScrolledFarFromBottom(false)
      const el = scrollerRef.current
      if (!el) return
      if (options?.behavior === "smooth") {
        // Animated: let the browser drive scrollTop over several frames.
        // handleScroll re-arms at the bottom and tracks prevScrollTop as it goes.
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
      } else {
        pinToBottom()
      }
    },
    [pinToBottom]
  )

  const disableAutoScroll = useCallback(() => {
    isFollowingTailRef.current = false
  }, [])

  const resetShiftBaseline = useCallback(() => {
    prevFirstKeyRef.current = null
    prevCountRef.current = 0
  }, [])

  // Hidden cold-load settle: pin to the bottom every frame while virtua measures
  // real item heights, and reveal (drop the skeleton mask) once scrollHeight has
  // held steady for a few frames — convergence is done — or a hard cap elapses.
  // The bounce happens behind the mask; what the user sees is a stable bottom.
  // A real user gesture aborts immediately (reveal + stop) so we never trap a
  // user who wants to scroll during a slow settle. Pinning here is the same
  // idempotent pinToBottom the ResizeObserver uses, so the two never disagree.
  const settleToBottom = useCallback(
    (maxMs: number) => {
      initialSettleCleanupRef.current?.()
      const el = scrollerRef.current
      if (!el) {
        setIsInitialSettling(false)
        return
      }
      const start = performance.now()
      let aborted = false
      let revealed = false
      let lastHeight = -1
      let stableFrames = 0
      const reveal = () => {
        if (!revealed) {
          revealed = true
          setIsInitialSettling(false)
        }
      }
      const cleanup = () => {
        aborted = true
        reveal()
        if (initialSettleRafRef.current) cancelAnimationFrame(initialSettleRafRef.current)
        initialSettleRafRef.current = 0
        el.removeEventListener("wheel", cleanup)
        el.removeEventListener("touchmove", cleanup)
        el.removeEventListener("pointerdown", cleanup)
        el.removeEventListener("keydown", cleanup)
        initialSettleCleanupRef.current = null
      }
      initialSettleCleanupRef.current = cleanup
      el.addEventListener("wheel", cleanup, { passive: true })
      el.addEventListener("touchmove", cleanup, { passive: true })
      el.addEventListener("pointerdown", cleanup, { passive: true })
      el.addEventListener("keydown", cleanup)

      const tick = () => {
        if (aborted) return
        pinToBottom()
        const height = el.scrollHeight
        if (height === lastHeight) stableFrames += 1
        else {
          stableFrames = 0
          lastHeight = height
        }
        // Converged (height steady) or capped → reveal and hand off to the
        // ResizeObserver, which keeps the tail pinned for any later growth.
        if (stableFrames >= SETTLE_STABLE_FRAMES || performance.now() - start >= maxMs) {
          cleanup()
          return
        }
        initialSettleRafRef.current = requestAnimationFrame(tick)
      }
      initialSettleRafRef.current = requestAnimationFrame(tick)
    },
    [pinToBottom]
  )

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const prevTop = prevScrollTopRef.current
    const prevHeight = prevScrollHeightRef.current
    prevScrollTopRef.current = el.scrollTop
    prevScrollHeightRef.current = el.scrollHeight
    // A user scroll-up is the scrollTop moving toward the top, measured directly
    // so it's device-independent — scrollbar drag, wheel, touch, and keyboard
    // PageUp all qualify, where a gesture-event stamp alone missed the desktop
    // scrollbar. A scrollHeight SHRINK (composer collapsing on send/blur, a row
    // removed) clamps scrollTop down on its own; that is not a user scroll, so
    // exclude it — otherwise a sent message disarmed follow and hid behind the
    // composer. Our own programmatic pins update prevTop in the same statement
    // as the write, so they read as no movement here and never disarm.
    const scrolledUp = el.scrollTop < prevTop - 1 && el.scrollHeight >= prevHeight - 1
    // Secondary signal for a touch/wheel gesture that hasn't moved scrollTop yet.
    const now = performance.now()
    const userGestured = now - (userInteractedAtRef?.current ?? 0) < USER_SCROLL_GRACE_MS
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // The composer footer spacer is dead space at the very bottom; the last
    // message resting just above it counts as "at the bottom". Without this
    // allowance the list lands ~a composer height short on first load and
    // disarms follow, which also kills keyboard-follow (gated on follow armed).
    const composerH = readComposerHeight(el)
    const atBottom = distanceFromBottom <= AT_BOTTOM_PX + composerH
    const wasFollowing = isFollowingTailRef.current
    if (atBottom) {
      // Reaching the tail re-arms follow — except in jump mode, where the user
      // is anchored on a deep-linked message and a transient atBottom from
      // reflow must never yank them to the live tail. Checked before the
      // scroll-away branch so sub-threshold jitter at the bottom never detaches.
      isFollowingTailRef.current = !isJumpMode
    } else if (scrolledUp || userGestured) {
      // The user scrolled away from the bottom. Content growth (new message,
      // link preview, virtua measuring real heights) does NOT lower scrollTop,
      // so it doesn't land here — the tail keeps following and the
      // ResizeObserver re-pins it.
      isFollowingTailRef.current = false
    }
    // While following we're effectively at the tail (the observer re-pins), so
    // never surface jump-to-latest; only when the user has actually scrolled up.
    setIsScrolledFarFromBottom(!isFollowingTailRef.current && distanceFromBottom > JUMP_TO_LATEST_PX)
    if (wasFollowing !== isFollowingTailRef.current) {
      scrollDebug(`follow ${isFollowingTailRef.current ? "ARMED" : "DISARMED"} (handleScroll)`, {
        dist: Math.round(distanceFromBottom),
        atBottom,
        scrolledUp,
        userGestured,
        composerH: Math.round(composerH),
        prevTop: Math.round(prevTop),
        st: el.scrollTop,
        sh: el.scrollHeight,
        ch: el.clientHeight,
      })
    }
  }, [isJumpMode, userInteractedAtRef])

  // Initial scroll-to-bottom once the first window is populated. Runs in a
  // layout effect (pre-paint) against the owned scroller so there is no visible
  // jump from the top.
  //
  // On a cold load virtua has only measured the top window; the rest are size
  // estimates, so scrollTop = scrollHeight alone undershoots (the "lands a
  // couple pages up" bug). scrollToIndex(last) makes virtua render + measure the
  // bottom region. Passing offset = the composer footer-spacer height lands it
  // at the footer-INCLUSIVE bottom, so the last message sits above the composer.
  // virtua re-applies that target as items measure, and the cold-load settle
  // (settleToBottom) re-pins each frame behind the skeleton mask until the
  // height — composer spacer included — converges.
  useLayoutEffect(() => {
    if (skipInitialScroll || didInitialScrollRef.current || itemCount === 0) return
    const el = scrollerRef.current
    if (!el) return
    isFollowingTailRef.current = true
    didInitialScrollRef.current = true
    try {
      listRef.current?.scrollToIndex(itemCount - 1, { align: "end", offset: readComposerHeight(el) })
    } catch {
      // Not-yet-measured list can throw; the pin + settle still converge.
    }
    pinToBottom()
    settleToBottom(2000)
  }, [itemCount, skipInitialScroll, resetKey, pinToBottom, settleToBottom])

  // The one observer that keeps the tail glued. Two observed targets:
  //  - content (contentRef): grows on a live append, on media decoding, as
  //    virtua measures real heights, and as the footer spacer resizes when the
  //    composer expands/collapses. While following → pin.
  //  - viewport (scrollerRef): shrinks/grows as the mobile keyboard opens/closes
  //    (AppShell is sized to --viewport-height; see useVisualViewport). While
  //    following → pin; while reading → shift scrollTop by the height delta so
  //    the row under the user's eyes stays put as the visible area changes.
  //
  // Every geometry change a user could care about routes through here, so there
  // is no separate media-load listener, composer-resize handler, or per-frame
  // keyboard pump — they were all re-implementations of "content/viewport
  // resized while following → pin".
  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    let prevClientHeight = scroller.clientHeight
    const observer = new ResizeObserver((entries) => {
      const el = scrollerRef.current
      if (!el) return
      const hasViewportEntry = entries.some((entry) => entry.target === el)
      if (isFollowingTailRef.current) {
        scrollDebug("RO pin (following)", {
          viewportEntry: hasViewportEntry,
          ch: el.clientHeight,
          prevCh: prevClientHeight,
          sh: el.scrollHeight,
          st: el.scrollTop,
        })
        pinToBottom()
        prevClientHeight = el.clientHeight
        return
      }
      // Only a viewport (scroller) resize should move a read position; content
      // entries leave clientHeight unchanged, so their delta is 0 (no-op).
      if (!hasViewportEntry) return
      const clientHeight = el.clientHeight
      const delta = prevClientHeight - clientHeight
      prevClientHeight = clientHeight
      if (delta !== 0) {
        scrollDebug("RO viewport-delta (not following)", { delta, ch: clientHeight, st: el.scrollTop })
        el.scrollTop += delta
        prevScrollTopRef.current = el.scrollTop
        prevScrollHeightRef.current = el.scrollHeight
      }
    })

    observer.observe(scroller)
    observer.observe(content)

    // Keyboard backstop. AppShell is sized to --viewport-height (pinned to the
    // visible viewport by useVisualViewport under interactive-widget=resizes-
    // content), so opening the keyboard shrinks the scroller and the
    // ResizeObserver above already re-pins. But some browsers change the visual
    // viewport without resizing the layout viewport (the scroller), in which
    // case no RO entry fires; pin on the visualViewport's own resize/scroll too.
    // pinToBottom is a no-op when not following and idempotent when it is, so
    // this can never fight the observer.
    const vv = window.visualViewport
    const pinIfFollowing = () => {
      if (isFollowingTailRef.current) pinToBottom()
    }
    vv?.addEventListener("resize", pinIfFollowing)
    vv?.addEventListener("scroll", pinIfFollowing)

    return () => {
      observer.disconnect()
      vv?.removeEventListener("resize", pinIfFollowing)
      vv?.removeEventListener("scroll", pinIfFollowing)
      initialSettleCleanupRef.current?.()
    }
  }, [resetKey, pinToBottom])

  return {
    listRef,
    scrollerRef,
    contentRef,
    shift,
    isScrolledFarFromBottom,
    isInitialSettling,
    isFollowingTailRef,
    scrollToBottom,
    disableAutoScroll,
    handleScroll,
    resetShiftBaseline,
  }
}
