import { useRef, useState, useCallback, useEffect, useLayoutEffect } from "react"
import type { VirtualizerHandle } from "virtua"

/** Distance (px) from the bottom within which we treat the list as "at bottom". */
const AT_BOTTOM_PX = 32
/** Distance (px) from the bottom past which the "Jump to latest" affordance shows. */
const JUMP_TO_LATEST_PX = 600
/** A scroll-away-from-bottom only disarms follow if a real user gesture landed
 *  within this window; otherwise it's content growth and the tail re-pins. */
const USER_SCROLL_GRACE_MS = 300
/** Scroll-event silence that marks a user scroll (incl. momentum) as settled,
 *  after which a downward release inside the composer dead band docks to the
 *  true bottom. Longer than any inter-event gap of an active scroll; short
 *  enough that the dock reads as part of the gesture. */
const DEAD_BAND_DOCK_SETTLE_MS = 200
/** Consecutive frames of unchanged scrollHeight that mark the cold-load settle
 *  as converged, so the content can be revealed without a visible bounce. */
const SETTLE_STABLE_FRAMES = 3
/** How long a converged-but-deferred settle reveal may wait on the landing
 *  decision before dropping the mask anyway — a resolver stuck at "wait"
 *  (read state that never hydrates) must not skeleton the stream forever. */
const SETTLE_DEFER_FAILSAFE_MS = 1500
/** Finger travel (px) from the last recorded anchor before a touchmove records
 *  a gesture direction. The final touchmove before lift-off commonly reverses
 *  2–3px as the finger peels off the glass; recording that flipped a long
 *  downward drag to "up", suppressing the dead-band dock and detaching follow.
 *  Sub-threshold moves keep the anchor, so a slow consistent drag accumulates
 *  past it while jitter oscillates around it and never flips. */
const TOUCH_DIRECTION_HYSTERESIS_PX = 8
/** Cap on the dead-band dock's trigger band, as a fraction of the viewport. */
const DOCK_BAND_MAX_VIEWPORT_FRACTION = 0.25

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

/**
 * The dead-band dock's trigger band. The composer hides exactly
 * `--composer-height` px of scroll range, but on mobile (keyboard open) the
 * composer can dwarf the visible strip — treating ALL of it as "undershot the
 * bottom" docked deliberate reading positions. A downward release more than a
 * quarter of the viewport above the tail is a chosen position, not an
 * undershoot; desktop composers are far under the cap, so nothing changes
 * there.
 */
function dockBandPx(el: HTMLElement): number {
  return Math.min(readComposerHeight(el), el.clientHeight * DOCK_BAND_MAX_VIEWPORT_FRACTION)
}

interface UseTimelineScrollOptions {
  /** Total item count of the virtualized list. */
  itemCount: number
  /** Stable key of the item at index 0, or null when empty. Drives prepend detection. */
  getFirstKey: () => string | null
  /** Stable key of the last item, or null when empty. Drives tail-replace detection. */
  getLastKey: () => string | null
  /** When this key changes, all scroll state resets (e.g. streamId). */
  resetKey?: string
  /**
   * Skip the initial scroll-to-bottom on first load. Used for deep-link /
   * jump-to-message navigation, where the caller drives the scroll imperatively.
   */
  skipInitialScroll?: boolean
  /**
   * While true, a converged cold-load settle parks its reveal instead of
   * dropping the mask: the atomic landing decision (INV-70) may still be
   * waiting on async inputs (read-state hydration), and revealing the tail
   * first would put the landing jump in full view. The landing effect flips
   * the ref false when it decides and calls `releaseDeferredReveal` (tail) or
   * `revealSettle` (positional). A user gesture or the failsafe cap reveals
   * regardless.
   */
  landingPendingRef?: React.RefObject<boolean>
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
  /**
   * Stamped (performance.now()) on every programmatic scroll write this hook
   * makes — the tail pin, scrollToBottom, and the smooth-to-bottom animation's
   * per-event frames. The read-frontier sweep (`useLastSeenEvent`) refuses to
   * link scans across a stamp, so a programmatic jump stays a read gap while a
   * user fling sweeps.
   */
  programmaticScrollAtRef?: React.MutableRefObject<number>
}

interface UseTimelineScrollReturn {
  /** Ref for virtua's `Virtualizer`/`VList` imperative handle. */
  listRef: React.RefObject<VirtualizerHandle | null>
  /** Ref for the scroll container we own. Stays live for readers; attach the
   *  element with `registerScroller` (not this) so the observer effect re-runs. */
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** Ref callback for the scrollable `<div>` — use as its `ref`. Keeps
   *  `scrollerRef` current and re-arms the ResizeObserver once it mounts. */
  registerScroller: (node: HTMLDivElement | null) => void
  /** The mounted scroller element as reactive state (null until virtua mounts
   *  it). Consumers whose effects must re-run when the scroller late-mounts
   *  (e.g. the read-frontier scan in `useLastSeenEvent`) depend on this, not the
   *  ref — a ref change does not re-run an effect. */
  scrollerEl: HTMLDivElement | null
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
  /**
   * Hand the cold-load settle over to an anchor restore: cancel the in-flight
   * settle-to-bottom loop WITHOUT dropping the skeleton mask, so the caller can
   * position the viewport off-screen and reveal at the restored spot via
   * `revealSettle`. Without this the settle reveals at the tail first and the
   * restore's scroll lands a frame later — a visible tail-flash-then-jump on
   * every reload of a stream with a saved reading position. No-op when no
   * settle is in flight.
   */
  holdSettleForRestore: () => void
  /** Drop the cold-load settle mask. Idempotent; pairs with holdSettleForRestore. */
  revealSettle: () => void
  /** Reveal a settle that converged while the landing decision was pending
   *  (see `landingPendingRef`). No-op when nothing is parked. */
  releaseDeferredReveal: () => void
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
  getLastKey,
  resetKey,
  skipInitialScroll = false,
  isJumpMode = false,
  userInteractedAtRef,
  landingPendingRef,
  programmaticScrollAtRef,
}: UseTimelineScrollOptions): UseTimelineScrollReturn {
  const listRef = useRef<VirtualizerHandle>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // The scroller and content elements are rendered by a child that shows a
  // loading skeleton first, so they are still null on this hook's first commit
  // and only attach once messages arrive. `registerScroller` is the scroller's
  // ref callback: it keeps `scrollerRef` live for readers (handleScroll, virtua's
  // scrollRef, deep-link/search) AND records the element in state, so the
  // ResizeObserver effect below re-runs the moment the scroller exists — and
  // again on the keyed per-stream remount. Without this the observer (and the
  // keyboard backstop) were wired once at mount against a null ref and never
  // re-attached, so the tail silently stopped re-pinning on composer-resize and
  // keyboard-open. The content node mounts inside (and so attaches before) the
  // scroller, so reading `contentRef.current` when the scroller attaches is
  // safe — only the scroller needs to drive the effect.
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null)
  const registerScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node
    setScrollerEl(node)
  }, [])

  const [isScrolledFarFromBottom, setIsScrolledFarFromBottom] = useState(false)

  // Mask the content during the cold-load settle. On the first load of a stream
  // virtua measures item heights frame-by-frame, so scrollHeight oscillates and
  // our re-pin chases it. Keep the content hidden (the component renders a
  // skeleton overlay) until the height stabilises, so convergence happens
  // off-screen. Revisits are already measured, so this reveals immediately.
  // Deep-link mounts drive their own jump, so they are never masked.
  const [isInitialSettling, setIsInitialSettling] = useState(!skipInitialScroll)
  const isInitialSettlingRef = useRef(isInitialSettling)
  isInitialSettlingRef.current = isInitialSettling

  // Auto-follow the live tail. Seeded false for deep-link mounts so we don't
  // snap to bottom before the jump positions on its target.
  const isFollowingTailRef = useRef(!skipInitialScroll)

  // Prepend detection. Comparing the first row's key across renders tells us an
  // older page landed (or the window trimmed from the start); virtua's `shift`
  // then holds the viewport from the end.
  const prevFirstKeyRef = useRef<string | null>(null)
  const prevLastKeyRef = useRef<string | null>(null)
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
  const initialSettleCleanupRef = useRef<((reveal?: boolean, forceReveal?: boolean) => void) | null>(null)
  // A settle that converged while the landing decision was still pending
  // parked its reveal here (mask stays up). Cleared by releaseDeferredReveal /
  // revealSettle / the failsafe / a user gesture / a stream switch.
  const deferredRevealRef = useRef(false)
  const deferFailsafeTimerRef = useRef(0)
  const deferGestureCleanupRef = useRef<(() => void) | null>(null)

  // Direction of the last GESTURE-DRIVEN scroll movement (null until one
  // happens). Two writers, both immune to programmatic positioning (divider/
  // deep-link scrolls, our pins, browser clamps):
  //  - The input events themselves (wheel deltaY sign, touch finger delta, in
  //    the gesture-stamp effect below). Unambiguous regardless of content
  //    reflow — on mobile the content height is rarely stable mid-drag (virtua
  //    measuring rows, the composer growing per keystroke), so scrollTop-delta
  //    recording alone skipped those frames and a stale "down" made the
  //    dead-band dock complete an upward gesture the user never made. A fresh
  //    touchstart clears it: a tap must not inherit the previous gesture's
  //    direction.
  //  - Gesture-fresh, height-stable scrollTop deltas in handleScroll — the
  //    only signal a desktop scrollbar drag emits.
  // Momentum events after a flick carry no fresh gesture stamp but only ever
  // continue the drag's direction, so the drag-phase value stays correct
  // through them. The dead-band dock consults this so it only ever completes a
  // gesture that was heading TOWARD the bottom; an upward nudge (peeking at
  // context while typing) is a position the user chose, and docking it would
  // undo what they just revealed at the top of the viewport. handleScroll also
  // reads it to disarm follow on an upward drag whose scrollTop movement is
  // masked by reflow.
  const lastGestureScrollDirRef = useRef<"up" | "down" | null>(null)

  // Reset all scroll state synchronously when the stream changes, before the
  // shift computation below runs for the new stream's first render. A layout
  // effect would run a render too late and mis-detect the first window as a
  // prepend. resetKey is seeded with the initial value, so this only fires on
  // real stream switches, not the initial mount.
  if (lastResetKeyRef.current !== resetKey) {
    lastResetKeyRef.current = resetKey
    prevFirstKeyRef.current = null
    prevLastKeyRef.current = null
    prevCountRef.current = 0
    prevScrollTopRef.current = 0
    prevScrollHeightRef.current = 0
    didInitialScrollRef.current = false
    lastGestureScrollDirRef.current = null
    isFollowingTailRef.current = !skipInitialScroll
    deferredRevealRef.current = false
    if (deferFailsafeTimerRef.current) {
      window.clearTimeout(deferFailsafeTimerRef.current)
      deferFailsafeTimerRef.current = 0
    }
    deferGestureCleanupRef.current?.()
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
  // While following the tail, a new last row that is not a single live append
  // (a sweep landing a gap, a window replaced under the reader) is a tail
  // replace: virtua has only estimated the rows below the old tail.
  const lastKey = itemCount > 0 ? getLastKey() : null
  const tailReplaced =
    isFollowingTailRef.current &&
    prevCountRef.current > 0 &&
    prevLastKeyRef.current !== null &&
    lastKey !== prevLastKeyRef.current &&
    !(itemCount === prevCountRef.current + 1 && firstKey === prevFirstKeyRef.current)
  // Record the baseline once per commit, in a layout effect — not during
  // render. React may render this component twice before committing (StrictMode
  // in dev, a concurrent re-render in prod); a during-render write would let a
  // later pass read an earlier pass's value, so `shift` would compare against a
  // baseline from the same uncommitted render instead of the prior committed
  // one. A layout effect writes exactly once per commit, so every render's
  // `shift` is measured against the last COMMITTED first key. The stream-switch
  // reset above stays in render — it must zero the baseline before this render's
  // shift check — and is idempotent across the double render.
  useLayoutEffect(() => {
    prevFirstKeyRef.current = firstKey
    prevLastKeyRef.current = lastKey
    prevCountRef.current = itemCount
  })

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
  // Deliberately NOT stamped for the read-frontier sweep: the pin either
  // holds an already-at-bottom position or reveals new content at the bottom
  // edge of a watched tail — it never skips rows past the viewport, so it must
  // not break a user fling's sweep chain (jump-to-latest stamps in
  // scrollToBottom instead, where the actual jump decision lives).
  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    prevScrollTopRef.current = el.scrollTop
    prevScrollHeightRef.current = el.scrollHeight
  }, [])

  // A smooth scrollToBottom animates over many frames the browser owns, so a
  // single stamp at kickoff would expire mid-flight and the frontier sweep
  // would link the animation's later frames as a user scroll. handleScroll
  // re-stamps every frame while this is set; cleared on arrival, on a user
  // gesture, or by the time cap (a smooth-to-bottom never runs longer).
  const smoothToBottomStartedAtRef = useRef(0)

  const scrollToBottom = useCallback(
    (options?: { force?: boolean; behavior?: ScrollBehavior }) => {
      if (!options?.force && !isFollowingTailRef.current) return
      isFollowingTailRef.current = true
      setIsScrolledFarFromBottom(false)
      const el = scrollerRef.current
      if (!el) return
      if (programmaticScrollAtRef) programmaticScrollAtRef.current = performance.now()
      if (options?.behavior === "smooth") {
        // Animated: let the browser drive scrollTop over several frames.
        // handleScroll re-arms at the bottom and tracks prevScrollTop as it goes.
        smoothToBottomStartedAtRef.current = performance.now()
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
      } else {
        pinToBottom()
      }
    },
    [pinToBottom, programmaticScrollAtRef]
  )

  const disableAutoScroll = useCallback(() => {
    isFollowingTailRef.current = false
  }, [])

  const resetShiftBaseline = useCallback(() => {
    prevFirstKeyRef.current = null
    prevCountRef.current = 0
  }, [])

  const holdSettleForRestore = useCallback(() => {
    initialSettleCleanupRef.current?.(false)
  }, [])

  const clearDeferredReveal = useCallback(() => {
    deferredRevealRef.current = false
    if (deferFailsafeTimerRef.current) {
      window.clearTimeout(deferFailsafeTimerRef.current)
      deferFailsafeTimerRef.current = 0
    }
    deferGestureCleanupRef.current?.()
  }, [])

  const revealSettle = useCallback(() => {
    clearDeferredReveal()
    setIsInitialSettling(false)
  }, [clearDeferredReveal])

  /** Reveal a converged-but-parked settle (the landing decided "tail" — the
   *  settle's own bottom position IS the landing). No-op when the settle is
   *  still converging: its own convergence reveals, now that the landing
   *  decision has been consumed. */
  const releaseDeferredReveal = useCallback(() => {
    if (!deferredRevealRef.current) return
    revealSettle()
  }, [revealSettle])

  // Hidden cold-load settle: pin to the bottom every frame while virtua measures
  // real item heights, and reveal (drop the skeleton mask) once scrollHeight has
  // held steady for a few frames — convergence is done — or a hard cap elapses.
  // The bounce happens behind the mask; what the user sees is a stable bottom.
  // A real user gesture aborts immediately (reveal + stop) so we never trap a
  // user who wants to scroll during a slow settle. Pinning here is the same
  // idempotent pinToBottom the ResizeObserver uses, so the two never disagree.
  const settleToBottom = useCallback(
    (maxMs: number) => {
      // Supersede a settle still in flight from a stream navigated away from
      // before it converged (resetKey changed while its RAF loop was still
      // ticking) — cancel it without revealing through its closure. Reveal
      // would strip the mask this call is about to raise again, exposing
      // whatever unsettled position the new stream is still mid-measurement
      // at: the exact bounce the mask exists to hide.
      initialSettleCleanupRef.current?.(false)
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
      const reveal = (force = false) => {
        if (revealed) return
        revealed = true
        if (!force && landingPendingRef?.current) {
          // The landing decision (INV-70) hasn't been made yet — dropping the
          // mask now would paint the tail and let a positional landing jump in
          // full view (the read-state hydration race). Park the reveal: the
          // landing effect releases it, a user gesture force-reveals, and the
          // failsafe drops the mask if the decision never resolves.
          deferredRevealRef.current = true
          if (deferFailsafeTimerRef.current) window.clearTimeout(deferFailsafeTimerRef.current)
          deferFailsafeTimerRef.current = window.setTimeout(() => {
            deferredRevealRef.current = false
            deferGestureCleanupRef.current?.()
            setIsInitialSettling(false)
          }, SETTLE_DEFER_FAILSAFE_MS)
          // The settle's own gesture listeners die with cleanup() below, so
          // arm fresh ones for the deferred window: a user scrolling under a
          // parked mask must not stay masked.
          const onDeferGesture = () => {
            deferGestureCleanupRef.current?.()
            deferredRevealRef.current = false
            if (deferFailsafeTimerRef.current) {
              window.clearTimeout(deferFailsafeTimerRef.current)
              deferFailsafeTimerRef.current = 0
            }
            setIsInitialSettling(false)
          }
          el.addEventListener("wheel", onDeferGesture, { passive: true })
          el.addEventListener("touchmove", onDeferGesture, { passive: true })
          el.addEventListener("pointerdown", onDeferGesture, { passive: true })
          el.addEventListener("keydown", onDeferGesture)
          deferGestureCleanupRef.current = () => {
            el.removeEventListener("wheel", onDeferGesture)
            el.removeEventListener("touchmove", onDeferGesture)
            el.removeEventListener("pointerdown", onDeferGesture)
            el.removeEventListener("keydown", onDeferGesture)
            deferGestureCleanupRef.current = null
          }
          return
        }
        setIsInitialSettling(false)
      }
      const cleanup = (shouldReveal = true, forceReveal = false) => {
        aborted = true
        if (shouldReveal) reveal(forceReveal)
        if (initialSettleRafRef.current) cancelAnimationFrame(initialSettleRafRef.current)
        initialSettleRafRef.current = 0
        el.removeEventListener("wheel", onGesture)
        el.removeEventListener("touchmove", onGesture)
        el.removeEventListener("pointerdown", onGesture)
        el.removeEventListener("keydown", onGesture)
        initialSettleCleanupRef.current = null
      }
      const onGesture = () => cleanup(true, true)
      initialSettleCleanupRef.current = cleanup
      el.addEventListener("wheel", onGesture, { passive: true })
      el.addEventListener("touchmove", onGesture, { passive: true })
      el.addEventListener("pointerdown", onGesture, { passive: true })
      el.addEventListener("keydown", onGesture)

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
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // A user scroll-up is the scrollTop moving toward the top, measured directly
    // so it's device-independent — scrollbar drag, wheel, touch, and keyboard
    // PageUp all qualify, where a gesture-event stamp alone missed the desktop
    // scrollbar. Two browser-driven clamps also lower scrollTop and must NOT
    // count: a scrollHeight SHRINK (composer collapsing on send/blur, a row
    // removed) — otherwise a sent message disarmed follow and hid behind the
    // composer — and a viewport GROWTH (keyboard closing: a taller scroller
    // lowers the scrollTop maximum). The growth clamp lands exactly AT the new
    // bottom, where a genuine scroll-up always ends ABOVE it, so requiring
    // distance > 1 tells them apart; without it, the tap that dismissed the
    // keyboard (a fresh scroller gesture) made the clamp read as a deliberate
    // scroll-up, follow disarmed, and the close parked the list a
    // keyboard-height above the tail. Our own programmatic pins update prevTop
    // in the same statement as the write, so they read as no movement here.
    // A device-independent user scroll-up is a scrollTop drop while the content
    // height is UNCHANGED — the user moved the viewport over stable content
    // (scrollbar drag fires no gesture event, so this is its only signal). When
    // scrollHeight ALSO moved, the drop was content reflow, not the user: a
    // prepend, a display-floor change, or virtua re-anchoring as the cold-load
    // tail lands all lower scrollTop with no gesture. Treating that as a
    // scroll-up wrongly disarmed follow mid-cold-load — handleScroll ran before
    // the ResizeObserver could re-pin — stranding the view pages above the tail
    // ("settles 2 pages up"). Both browser clamps stay excluded: a shrink
    // (composer collapse) and a growth (content reflow) are both `!heightStable`.
    const heightStable = Math.abs(el.scrollHeight - prevHeight) <= 1
    const scrolledUp = el.scrollTop < prevTop - 1 && heightStable && distanceFromBottom > 1
    // Secondary signal for a touch/wheel gesture that hasn't moved scrollTop yet.
    const now = performance.now()
    const userGestured = now - (userInteractedAtRef?.current ?? 0) < USER_SCROLL_GRACE_MS
    // Keep the programmatic stamp fresh through a smooth-to-bottom animation:
    // its frames are browser-driven scroll events indistinguishable from a
    // fling, and the frontier sweep must not read the jumped range as read.
    if (smoothToBottomStartedAtRef.current) {
      const arrived = distanceFromBottom <= AT_BOTTOM_PX
      if (userGestured || arrived || now - smoothToBottomStartedAtRef.current > 2000) {
        smoothToBottomStartedAtRef.current = 0
        if (arrived && programmaticScrollAtRef) programmaticScrollAtRef.current = now
      } else if (programmaticScrollAtRef) {
        programmaticScrollAtRef.current = now
      }
    }
    if (heightStable && userGestured) {
      if (el.scrollTop > prevTop + 1) lastGestureScrollDirRef.current = "down"
      else if (el.scrollTop < prevTop - 1) lastGestureScrollDirRef.current = "up"
    }
    // The gesture's own direction (wheel deltaY / touch finger delta, recorded
    // by the gesture-stamp effect) says the user is heading up while we sit
    // above the true bottom. This is the signal that stays reliable on mobile:
    // mid-drag the content height is rarely stable (virtua measuring rows, the
    // composer growing per keystroke), so `scrolledUp` misses the movement and
    // the re-pin used to win over the user's finger.
    const gestureIntentUp = lastGestureScrollDirRef.current === "up" && userGestured && distanceFromBottom > 1
    // The composer footer spacer is dead space at the very bottom. During the
    // initial cold-load settle we keep the generous composer-height band so a
    // slightly-undershoot landing doesn't disarm follow before convergence; once
    // settled, only a genuinely flush position (within AT_BOTTOM_PX) counts as
    // "at the bottom". This prevents a small scroll-up — e.g. to read context
    // while typing — from being treated as still following, which then snaps
    // back when the composer grows.
    const composerH = readComposerHeight(el)
    const atBottom = distanceFromBottom <= AT_BOTTOM_PX + (isInitialSettlingRef.current ? composerH : 0)
    // A deliberate user scroll-up — the scrollTop actually moved toward the top
    // AND a real gesture (wheel/trackpad/touch/key) is in play — must detach
    // even when we are still inside the at-bottom band, or a light nudge gets
    // snapped straight back to the tail by the re-pin ("can't scroll up a
    // little"). Gesture-gated on purpose: keyboard-driven scroll changes carry
    // no scroller gesture, so they never count as a user scroll-up and follow
    // stays armed through a keyboard open. Content growth never lowers scrollTop,
    // and our own pins sync prevTop, so neither reads as scrolledUp.
    const userScrolledUp = (scrolledUp && userGestured) || gestureIntentUp
    if (atBottom && !userScrolledUp) {
      // Reaching the tail re-arms follow — except in jump mode, where the user
      // is anchored on a deep-linked message and a transient atBottom from
      // reflow must never yank them to the live tail. Sub-threshold jitter (no
      // gesture) re-arms here too, so it never detaches.
      isFollowingTailRef.current = !isJumpMode
    } else if (scrolledUp || userGestured) {
      // The user scrolled away from the bottom (past the band, or a deliberate
      // nudge inside it). Content growth (new message, link preview, virtua
      // measuring real heights) does NOT register as a scroll-up — it changes
      // scrollHeight, so `scrolledUp` (height-stable only) stays false and the
      // tail keeps following while the ResizeObserver re-pins it.
      isFollowingTailRef.current = false
    }
    // While following we're effectively at the tail (the observer re-pins), so
    // never surface jump-to-latest; only when the user has actually scrolled up.
    setIsScrolledFarFromBottom(!isFollowingTailRef.current && distanceFromBottom > JUMP_TO_LATEST_PX)
  }, [isJumpMode, userInteractedAtRef, programmaticScrollAtRef])

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

  // A tail replace pinned by the ResizeObserver alone converges over several
  // frames: each pin scrolls into estimated space, virtua renders and measures
  // the rows there, the height changes, the observer pins again, and every
  // frame paints a different newest row. scrollToIndex(last) before paint
  // renders the tail region in this commit and keeps virtua's own loop on the
  // last row until its rows are measured, so the tail settles in one refine
  // instead of walking down row by row.
  useLayoutEffect(() => {
    if (!tailReplaced || !didInitialScrollRef.current) return
    const el = scrollerRef.current
    if (!el) return
    try {
      listRef.current?.scrollToIndex(itemCount - 1, { align: "end", offset: readComposerHeight(el) })
    } catch {
      // Not-yet-measured list can throw; the pin still lands.
    }
    pinToBottom()
  }, [tailReplaced, itemCount, pinToBottom])

  // The one observer that keeps the tail glued. Two observed targets:
  //  - content (contentRef): grows on a live append, on media decoding, as
  //    virtua measures real heights, and as the footer spacer resizes when the
  //    composer expands/collapses. While following → pin.
  //  - viewport (scrollerRef): shrinks/grows as the mobile keyboard opens/closes
  //    (AppShell is sized to --viewport-height; see useVisualViewport). While
  //    following → pin; while reading → hands-off. The scroller resizes at its
  //    BOTTOM edge, so an untouched scrollTop keeps whatever the user
  //    positioned at the top of the viewport exactly where it is; shifting by
  //    the height delta instead anchored the bottom edge, which pushed the
  //    message a replier had parked at the top up out of the viewport on every
  //    composer/keyboard open.
  //
  // Every geometry change a user could care about routes through here, so there
  // is no separate media-load listener, composer-resize handler, or per-frame
  // keyboard pump — they were all re-implementations of "content/viewport
  // resized while following → pin".
  useEffect(() => {
    const scroller = scrollerEl
    const content = contentRef.current
    if (!scroller || !content) return

    let pendingRecheck = 0
    const clearPendingRecheck = () => {
      if (pendingRecheck) {
        window.clearTimeout(pendingRecheck)
        pendingRecheck = 0
      }
    }
    const observer = new ResizeObserver((entries) => {
      const el = scrollerRef.current
      if (!el) return
      const hasViewportEntry = entries.some((entry) => entry.target === el)
      if (isFollowingTailRef.current) {
        // A CONTENT resize fired by an active user scroll (virtua re-measuring
        // item heights as rows scroll into view) must NOT re-pin — that snaps a
        // slow scroll-up back to the bottom before handleScroll can disarm
        // follow. A VIEWPORT resize (keyboard open/close) always pins: it is not
        // user-scroll-driven (the composer tap lands on the floating composer,
        // not the scroller, so the gesture stamp stays stale), so keyboard-follow
        // is unaffected.
        const elapsedSinceGesture = performance.now() - (userInteractedAtRef?.current ?? 0)
        const userScrolling = elapsedSinceGesture < USER_SCROLL_GRACE_MS
        if (!hasViewportEntry && userScrolling) {
          // The resize itself is real — a message, session card, or the composer
          // genuinely changed size — we're only holding off because a scroller
          // gesture landed a moment ago. If that's the only resize this content
          // change ever fires, skipping it here would miss it forever, so
          // re-check once the grace window actually elapses and catch up if
          // we're still following.
          clearPendingRecheck()
          pendingRecheck = window.setTimeout(
            () => {
              pendingRecheck = 0
              if (isFollowingTailRef.current) pinToBottom()
            },
            Math.max(0, USER_SCROLL_GRACE_MS - elapsedSinceGesture)
          )
          return
        }
        clearPendingRecheck()
        pinToBottom()
        return
      }
      // Detached (reading): hands-off, for BOTH entry kinds. Content resizes
      // leave clientHeight unchanged anyway; a viewport resize (keyboard or
      // composer chrome opening/closing) shrinks or grows the scroller at its
      // BOTTOM edge, so an untouched scrollTop keeps whatever the user
      // positioned at the top of the viewport exactly where it is. Shifting
      // scrollTop by the height delta instead anchored the bottom edge — the
      // message a replier had parked at the top was pushed out of the viewport
      // on every composer open. When the viewport grows past the content end
      // the browser clamps scrollTop on its own; handleScroll never reads that
      // clamp as a user scroll (it lands exactly at the new bottom).
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
    // this can never fight the observer. Synchronous (not rAF-deferred): on
    // Chrome Android a deferred pin lands a frame after the viewport step and
    // fights the browser's own scroll adjustment — that was the Chrome bounce.
    const vv = window.visualViewport
    const pinIfFollowing = () => {
      if (isFollowingTailRef.current) pinToBottom()
    }
    vv?.addEventListener("resize", pinIfFollowing)
    vv?.addEventListener("scroll", pinIfFollowing)

    return () => {
      observer.disconnect()
      clearPendingRecheck()
      vv?.removeEventListener("resize", pinIfFollowing)
      vv?.removeEventListener("scroll", pinIfFollowing)
    }
  }, [resetKey, pinToBottom, scrollerEl])

  // Genuine-input stamp + gesture direction on the owned scroller.
  // wheel/touch/pointer/keydown are real user gestures; `scroll` is
  // deliberately NOT listened to (our own programmatic pins fire it).
  // handleScroll and the observer above read the stamp to tell a deliberate
  // scroll-up from content growth.
  //
  // Direction comes from the input events themselves — wheel deltaY sign,
  // touch finger delta — because they stay unambiguous when content reflow
  // makes scrollTop deltas unreadable (see lastGestureScrollDirRef). A finger
  // moving DOWN drags the content down, which scrolls the viewport UP. A fresh
  // touchstart clears the direction so a tap never inherits the previous
  // gesture's; `touches` is read defensively because a browser tap may deliver
  // no touch points by the time the handler runs (and unit tests dispatch bare
  // Events).
  //
  // Gated on the mounted scroller element for the same reason as the observer:
  // the scroller renders behind the loading skeleton, so an effect reading
  // scrollerRef.current on first commit attaches to null, and with no dep that
  // changes when the scroller mounts it never re-runs — the stamp was silently
  // never attached on any cold load. With the stamp dead, `userGestured` is
  // always false, so a scroll-up inside the at-bottom band can't disarm follow
  // and the observer re-pins the user back to the tail on the next content
  // reflow ("scroll up a little and get snapped back", on reflowing streams).
  useEffect(() => {
    const el = scrollerEl
    if (!el || !userInteractedAtRef) return
    const mark = () => {
      userInteractedAtRef.current = performance.now()
    }
    let lastTouchY: number | null = null
    const onWheel = (e: WheelEvent) => {
      mark()
      if (e.deltaY > 0) lastGestureScrollDirRef.current = "down"
      else if (e.deltaY < 0) lastGestureScrollDirRef.current = "up"
    }
    const onTouchStart = (e: TouchEvent) => {
      mark()
      lastTouchY = e.touches?.[0]?.clientY ?? null
      lastGestureScrollDirRef.current = null
    }
    const onTouchMove = (e: TouchEvent) => {
      mark()
      const y = e.touches?.[0]?.clientY
      if (y === undefined) return
      if (lastTouchY === null) {
        lastTouchY = y
        return
      }
      // Hysteresis: only a move past the threshold records a direction and
      // advances the anchor, so the tiny reversal of a finger peeling off the
      // glass can't flip a long drag's direction at the last instant.
      if (Math.abs(y - lastTouchY) > TOUCH_DIRECTION_HYSTERESIS_PX) {
        lastGestureScrollDirRef.current = y > lastTouchY ? "up" : "down"
        lastTouchY = y
      }
    }
    el.addEventListener("wheel", onWheel, { passive: true })
    el.addEventListener("touchstart", onTouchStart, { passive: true })
    el.addEventListener("touchmove", onTouchMove, { passive: true })
    el.addEventListener("pointerdown", mark, { passive: true })
    el.addEventListener("keydown", mark)
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("pointerdown", mark)
      el.removeEventListener("keydown", mark)
    }
  }, [scrollerEl, userInteractedAtRef])

  // Dead-band dock. The bottom `--composer-height` px of scroll range sit
  // behind the floating composer, so any scroll position resting in that band
  // shows the tail clipped by the pill — and nothing ever corrects it: the
  // gesture disarmed follow, the at-bottom re-arm band (AT_BOTTOM_PX) is
  // narrower than the dead band, and jump-to-latest needs 600px. A mouse wheel
  // overshoots and clamps at the true max (which re-arms follow), which is why
  // this parked state is a touch-drag/trackpad problem: a finger releases
  // wherever it stops. So once user scrolling settles (scroll events quiet,
  // no finger/button held) with the last gesture heading DOWN — the user was
  // returning to the bottom and undershot — ease the rest of the way and let
  // the pin re-arm follow. Upward releases in the band are left alone: that is
  // the deliberate "nudge up to read context" position, and the direction ref
  // never records programmatic positioning (deep-link/divider scrolls), so a
  // jump target near the tail is never yanked from under the user either.
  useEffect(() => {
    const el = scrollerEl
    if (!el) return
    let settleTimer = 0
    // A held press must not dock mid-gesture (a still finger emits no scroll
    // events, so the quiet window alone would elapse under it). Tracked via
    // touch events, not pointer events — browsers fire pointercancel when a
    // touch scroll takes over, which would read as "released" while the finger
    // is still dragging. Mouse-side, a held selection drag is the same hazard.
    let touchHeld = false
    let mouseHeld = false
    const clearSettle = () => {
      if (settleTimer) {
        window.clearTimeout(settleTimer)
        settleTimer = 0
      }
    }
    const evaluate = () => {
      settleTimer = 0
      if (touchHeld || mouseHeld) return
      if (isJumpMode || isInitialSettlingRef.current) return
      if (lastGestureScrollDirRef.current !== "down") return
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distanceFromBottom <= 1) return
      if (distanceFromBottom > dockBandPx(el) + AT_BOTTOM_PX) return
      scrollToBottom({ force: true, behavior: "smooth" })
    }
    const schedule = () => {
      clearSettle()
      settleTimer = window.setTimeout(evaluate, DEAD_BAND_DOCK_SETTLE_MS)
    }
    const onScroll = () => schedule()
    const onTouchStart = () => {
      touchHeld = true
      clearSettle()
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return
      touchHeld = false
      schedule()
    }
    const onMouseDown = () => {
      mouseHeld = true
      clearSettle()
    }
    const onMouseUp = () => {
      if (!mouseHeld) return
      mouseHeld = false
      schedule()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    el.addEventListener("touchstart", onTouchStart, { passive: true })
    el.addEventListener("touchend", onTouchEnd, { passive: true })
    el.addEventListener("touchcancel", onTouchEnd, { passive: true })
    el.addEventListener("mousedown", onMouseDown, { passive: true })
    // window, not el: a drag can end with the cursor outside the scroller.
    window.addEventListener("mouseup", onMouseUp, { passive: true })
    return () => {
      clearSettle()
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("touchcancel", onTouchEnd)
      el.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, [scrollerEl, isJumpMode, scrollToBottom])

  // Abort an in-flight cold-load settle when the hook unmounts. Kept separate
  // from the ResizeObserver effect above so that effect can re-run when the
  // scroller attaches or remounts without tearing down a settle that the
  // initial-scroll layout effect just started.
  useEffect(() => () => initialSettleCleanupRef.current?.(), [])

  return {
    listRef,
    scrollerRef,
    registerScroller,
    scrollerEl,
    contentRef,
    shift,
    isScrolledFarFromBottom,
    isInitialSettling,
    isFollowingTailRef,
    scrollToBottom,
    disableAutoScroll,
    handleScroll,
    resetShiftBaseline,
    holdSettleForRestore,
    revealSettle,
    releaseDeferredReveal,
  }
}
