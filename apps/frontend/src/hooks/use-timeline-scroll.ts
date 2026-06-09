import { useRef, useState, useCallback, useEffect, useLayoutEffect } from "react"
import type { VirtualizerHandle } from "virtua"

/** Distance (px) from the bottom within which we treat the list as "at bottom". */
const AT_BOTTOM_PX = 32
/** Distance (px) from the bottom past which the "Jump to latest" affordance shows. */
const JUMP_TO_LATEST_PX = 600
/** Window (ms) during which scroll events are treated as our own programmatic
 *  snaps and must not disarm follow (covers the initial measure-and-converge). */
const PROGRAMMATIC_SCROLL_MS = 150
/** How long the mobile keyboard open/close animates `--viewport-height` (matches
 *  useVisualViewport's poll). We re-pin to the bottom every frame across this
 *  window so the tail tracks the shrinking viewport instead of snapping once
 *  before it settles. */
const VIEWPORT_SETTLE_MS = 600
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
   * on the scroller. A scroll away from the bottom only disarms auto-follow when
   * it was user-driven; content growth (new message, link preview, virtua
   * measuring real heights) moves us off the bottom with no gesture and must NOT
   * disarm follow — otherwise the tail won't re-pin and new messages stop
   * pushing the view up.
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
  /** Extra bottom space (px) the caller should reserve below the last message
   *  while the on-screen keyboard overlays the scroller (0 when the layout
   *  already shrinks the scroller above the keyboard). */
  keyboardInsetPx: number
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
  userInteractedAtRef,
}: UseTimelineScrollOptions): UseTimelineScrollReturn {
  const listRef = useRef<VirtualizerHandle>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [isScrolledFarFromBottom, setIsScrolledFarFromBottom] = useState(false)

  // Mask the content during the cold-load settle. On the first load of a stream
  // virtua measures item heights frame-by-frame, so scrollHeight oscillates and
  // our re-pin chases it — the visible "bounce on initial load". Keep the
  // content hidden (the component renders a skeleton overlay) until the height
  // stabilises, so that convergence happens off-screen. Revisits are already
  // measured, so this reveals immediately. Deep-link mounts drive their own
  // jump, so they are never masked.
  const [isInitialSettling, setIsInitialSettling] = useState(!skipInitialScroll)

  // Extra bottom space (px) the caller reserves below the last message while the
  // on-screen keyboard overlays the scroller. Some mobile layouts shrink the app
  // to `--viewport-height` (so the scroller already sits above the keyboard and
  // this stays 0); others let the keyboard *overlay* the scroller without
  // resizing it, so re-pinning has nowhere to move and the last message stays
  // hidden. We measure how much of the scroller the keyboard actually covers and
  // reserve exactly that, so pinning lifts the tail above the keyboard either way.
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0)
  const lastInsetRef = useRef(0)

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
  // snaps (initial scroll, follow re-pin, keyboard transition). During that
  // window handleScroll must not disarm follow: mid-convergence the content is
  // still growing underneath, so we read as "not at bottom" even though we're
  // chasing it.
  const programmaticUntilRef = useRef(0)
  // Drives the keyboard settle re-pin loop (see the ResizeObserver effect).
  const viewportSettleUntilRef = useRef(0)
  const viewportRafRef = useRef(0)
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

  // Go to the absolute bottom. scrollTop = scrollHeight is browser-clamped to
  // the true maximum, which includes the composer footer spacer below virtua's
  // items — so the last message lands *above* the composer, not behind it.
  // (Deliberately NOT virtua's scrollToIndex: it aligns to the item and can't
  // see the trailing footer spacer, so it parks the last message at the very
  // bottom edge, under the composer.) In a virtualized list scrollHeight is
  // estimate-based at first, so this can undershoot on the first frame — the
  // content ResizeObserver below re-pins it as virtua measures real heights,
  // protected from disarming follow by the programmatic-scroll window.
  const snapToBottom = useCallback((behavior?: ScrollBehavior) => {
    const el = scrollerRef.current
    if (!el) return
    programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

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

  // Hidden cold-load settle: pin to the bottom every frame while virtua measures
  // real item heights, and reveal (drop the skeleton mask) once scrollHeight has
  // held steady for a few frames — convergence is done — or a hard cap elapses.
  // The bounce happens behind the mask; what the user sees is a stable bottom.
  // A real user gesture aborts immediately (reveal + stop) so we never trap a
  // user who wants to scroll during a slow settle.
  const settleToBottom = useCallback((maxMs: number) => {
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
      const now = performance.now()
      programmaticUntilRef.current = now + PROGRAMMATIC_SCROLL_MS
      el.scrollTop = el.scrollHeight
      const height = el.scrollHeight
      if (height === lastHeight) stableFrames += 1
      else {
        stableFrames = 0
        lastHeight = height
      }
      // Converged (height steady) or capped → reveal and hand off to the content
      // ResizeObserver, which keeps the tail pinned for any later growth.
      if (stableFrames >= SETTLE_STABLE_FRAMES || now - start >= maxMs) {
        cleanup()
        return
      }
      initialSettleRafRef.current = requestAnimationFrame(tick)
    }
    initialSettleRafRef.current = requestAnimationFrame(tick)
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const now = performance.now()
    // A genuine user gesture is honored even mid-programmatic-window. Our own
    // snaps (initial convergence, follow re-pin, keyboard settle) carry no
    // recent gesture, so we skip them — disarming on them is what stranded the
    // list ~2 screens up on load. But a real scroll-away DURING the keyboard
    // settle must still disarm: otherwise follow stays wrongly armed and the
    // next composer resize (a keystroke/newline) yanks the user back to the
    // tail — the "scrolled away but it snaps back on composer resize" report.
    const userGestured = now - (userInteractedAtRef?.current ?? 0) < USER_SCROLL_GRACE_MS
    if (now < programmaticUntilRef.current && !userGestured) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // The composer footer spacer is dead space at the very bottom; the last
    // message resting just above it counts as "at the bottom". Without this
    // allowance the list lands ~a composer height short on first load and
    // disarms follow, which also kills keyboard-follow (gated on follow armed).
    const atBottom = distanceFromBottom <= AT_BOTTOM_PX + readComposerHeight(el)
    if (atBottom) {
      // Reaching the tail re-arms follow — except in jump mode, where the user
      // is anchored on a deep-linked message and a transient atBottom from
      // reflow must never yank them to the live tail.
      isFollowingTailRef.current = !isJumpMode
    } else if (userGestured) {
      // Only a genuine user scroll away from the bottom stops follow. Content
      // growth (a new message, a link preview loading, virtua measuring real
      // heights) moves us off the bottom with NO gesture; disarming there
      // strands the tail instead of letting the ResizeObserver re-pin — the
      // "new messages don't push the view up" and "preview lands under the
      // composer" reports.
      isFollowingTailRef.current = false
    }
    // While following we're effectively at the tail (the observer re-pins), so
    // never surface jump-to-latest; only when the user has actually scrolled up.
    setIsScrolledFarFromBottom(!isFollowingTailRef.current && distanceFromBottom > JUMP_TO_LATEST_PX)
  }, [isJumpMode, userInteractedAtRef])

  // Initial scroll-to-bottom once the first window is populated. Runs in a
  // layout effect (pre-paint) against the owned scroller so there is no visible
  // jump from the top.
  //
  // On a cold load virtua has only measured the top window; the rest are size
  // estimates, so scrollTop = scrollHeight alone undershoots (the "lands a
  // couple pages up" bug). scrollToIndex(last) makes virtua render + measure the
  // bottom region. Passing offset = the composer footer-spacer height lands it
  // at the footer-INCLUSIVE bottom (virtua sets scrollTop = offset + lastItem
  // bottom - viewport and lets the browser clamp; it does not clamp to its own
  // content), so the last message sits above the composer — not at the viewport
  // edge behind it. virtua re-applies that same target as items measure, so it
  // converges WITH the pin instead of fighting it. The content ResizeObserver
  // re-pins again once the composer publishes its real --composer-height.
  // scrollToIndex is used ONLY here; once measured, plain scrollTop suffices.
  useLayoutEffect(() => {
    if (skipInitialScroll || didInitialScrollRef.current || itemCount === 0) return
    const el = scrollerRef.current
    if (!el) return
    isFollowingTailRef.current = true
    didInitialScrollRef.current = true
    try {
      listRef.current?.scrollToIndex(itemCount - 1, { align: "end", offset: readComposerHeight(el) })
    } catch {
      // Not-yet-measured list can throw; the snap + ResizeObserver still converge.
    }
    snapToBottom()
    settleToBottom(2000)
  }, [itemCount, skipInitialScroll, resetKey, snapToBottom, settleToBottom])

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
        // Re-pin to the absolute bottom as virtua measures real heights (initial
        // convergence) and on content/viewport growth (live append, keyboard
        // open). Marked programmatic so the resulting scroll event doesn't
        // disarm follow.
        programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS
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

    // On-screen keyboard handling. Two layouts exist in the wild: some shrink
    // the app to `--viewport-height` (the scroller ends up above the keyboard,
    // so `coveredPx` is 0 and nothing extra is reserved); others let the keyboard
    // OVERLAY the scroller without resizing it — there `scrollTop = scrollHeight`
    // has nowhere to move and the last message stays hidden behind the keyboard.
    // Measure how much of the scroller the keyboard actually covers and reserve
    // exactly that as extra bottom space (`keyboardInsetPx`), so pinning lifts the
    // tail above the keyboard either way. The keyboard animates over ~600ms, so
    // re-measure + re-pin every frame across the settle window while following.
    const vv = window.visualViewport
    const measureCovered = (): number => {
      const el = scrollerRef.current
      if (!el || !vv) return 0
      const covered = el.getBoundingClientRect().bottom - (vv.offsetTop + vv.height)
      return covered > 1 ? Math.round(covered) : 0
    }
    const applyInset = () => {
      const next = measureCovered()
      if (next !== lastInsetRef.current) {
        lastInsetRef.current = next
        setKeyboardInsetPx(next)
      }
    }
    // The on-screen keyboard does NOT reliably emit a `visualViewport` resize
    // (nor does it always resize the scroller, so its ResizeObserver may stay
    // quiet) — on some platforms the only signal is that an editable gained
    // focus. useVisualViewport copes by POLLING across focus transitions; mirror
    // that here. Pump an rAF loop for the settle window that re-measures the
    // covered area (`keyboardInsetPx`) and re-pins the tail every frame, so the
    // last message rides above the keyboard whether the layout shrinks the
    // scroller or the keyboard overlays it. Driven by focusin/focusout (the
    // reliable trigger) plus visualViewport resize/scroll where those fire.
    const pumpKeyboard = () => {
      viewportSettleUntilRef.current = performance.now() + VIEWPORT_SETTLE_MS
      if (viewportRafRef.current) return
      const tick = () => {
        applyInset()
        // Re-pin every frame across the keyboard animation, but ONLY while
        // following, and mark just that snap programmatic (a short window) so it
        // doesn't disarm follow. We deliberately do NOT blanket the whole settle
        // as programmatic: that swallowed the user's own scroll-away for 600ms
        // and let a later composer resize yank them back to the tail.
        if (isFollowingTailRef.current) {
          programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS
          snapToBottom()
        }
        if (performance.now() >= viewportSettleUntilRef.current) {
          viewportRafRef.current = 0
          return
        }
        viewportRafRef.current = requestAnimationFrame(tick)
      }
      viewportRafRef.current = requestAnimationFrame(tick)
    }
    const onFocusChange = (event: FocusEvent) => {
      const t = event.target
      if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        pumpKeyboard()
      }
    }
    vv?.addEventListener("resize", pumpKeyboard)
    vv?.addEventListener("scroll", pumpKeyboard)
    document.addEventListener("focusin", onFocusChange)
    document.addEventListener("focusout", onFocusChange)

    // Media inside a row — a link preview's og:image, GitHub avatars, a GIF —
    // finishes decoding a frame or two after the row first lays out and grows
    // it. While parked at the tail that late growth can slip past the
    // ResizeObserver's timing and leave the list pinned a hair short: the "small
    // jump as a link preview loads in", and a few px of scrollable slack below
    // the last message (masked by the at-bottom allowance, so follow stays armed
    // but we're not actually at the true bottom). `load` doesn't bubble, so
    // listen in the capture phase and re-pin to the exact bottom when following.
    const onMediaLoad = (event: Event) => {
      if (!isFollowingTailRef.current || !(event.target instanceof HTMLImageElement)) return
      const el = scrollerRef.current
      if (!el) return
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS
      el.scrollTop = el.scrollHeight
    }
    scroller.addEventListener("load", onMediaLoad, true)

    return () => {
      observer.disconnect()
      vv?.removeEventListener("resize", pumpKeyboard)
      vv?.removeEventListener("scroll", pumpKeyboard)
      document.removeEventListener("focusin", onFocusChange)
      document.removeEventListener("focusout", onFocusChange)
      scroller.removeEventListener("load", onMediaLoad, true)
      if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current)
      viewportRafRef.current = 0
      initialSettleCleanupRef.current?.()
      lastInsetRef.current = 0
      setKeyboardInsetPx(0)
    }
  }, [resetKey, snapToBottom])

  return {
    listRef,
    scrollerRef,
    contentRef,
    shift,
    isScrolledFarFromBottom,
    isInitialSettling,
    keyboardInsetPx,
    isFollowingTailRef,
    scrollToBottom,
    disableAutoScroll,
    handleScroll,
    resetShiftBaseline,
  }
}
