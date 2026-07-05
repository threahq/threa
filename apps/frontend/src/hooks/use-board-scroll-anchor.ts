import { useEffect, useLayoutEffect, useRef } from "react"

/** Below this scrollTop the anchor is disabled, so prepended cards flow in at the
 *  top (the pill-click reveal) instead of being held off-screen above the fold. */
const ANCHOR_DISABLE_PX = 4
/** Sub-pixel layout jitter shouldn't trigger a scroll correction. */
const MIN_COMPENSATION_PX = 0.5
/** While a touch scroll is active — and for this long after the finger lifts,
 *  covering the kinetic-momentum phase — a `scrollTop` write fights iOS Safari's
 *  native momentum engine and judders. Defer the correction and re-pin once the
 *  scroll settles instead. */
const MOMENTUM_SETTLE_MS = 450

/** Attribute carrying a card's conversation id, read to re-find the anchor card. */
export const BOARD_CARD_ATTR = "data-board-card"

interface Anchor {
  id: string
  /** The card's top offset within the viewport at the moment it was measured. */
  offset: number
}

/** The topmost card still touching the viewport, and its offset within it. */
function measureAnchor(viewport: HTMLElement): Anchor | null {
  const cards = viewport.querySelectorAll<HTMLElement>(`[${BOARD_CARD_ATTR}]`)
  const viewportTop = viewport.getBoundingClientRect().top
  for (const card of cards) {
    const top = card.getBoundingClientRect().top - viewportTop
    if (top + card.offsetHeight > 0) {
      const id = card.getAttribute(BOARD_CARD_ATTR)
      return id ? { id, offset: top } : null
    }
  }
  return null
}

/**
 * Formalize INV-61 for the top-anchored board feed: the topmost visible card
 * keeps its exact screen offset across any mutation. The hard case is async
 * reflow — avatars, link previews and images *above* the viewport loading after
 * the initial layout and growing the region — which would push the card the
 * viewer is reading downward. A `ResizeObserver` on the content catches every
 * such growth (the timeline gets the same guarantee from `virtua`'s `shift`; a
 * non-virtualized board hand-rolls it) and re-pins the anchor card by adding the
 * above-anchor height delta to `scrollTop`.
 *
 * Disabled near the top so a pill-click reveal (scroll to top, then commit) lets
 * the new cards flow in rather than holding the old first card in place.
 *
 * `resetKey` identifies the current view (the board's lens + scope): when it changes the
 * feed is replaced with a different subset, so drop the previous view's anchor
 * and jump to the top. Done in a layout effect — before paint — so the reset
 * lands ahead of the `ResizeObserver` firing on the swap's layout change, which
 * would otherwise `compensate()` against the stale anchor and jump to a bogus
 * offset (a visible double-scroll). After scrollTop is 0 the compensation is a
 * no-op (`<= ANCHOR_DISABLE_PX`) and the anchor is null, so the swap starts clean.
 */
export function useBoardScrollAnchor(viewport: HTMLElement | null, resetKey?: string): void {
  const anchorRef = useRef<Anchor | null>(null)

  useLayoutEffect(() => {
    anchorRef.current = null
    if (viewport) viewport.scrollTop = 0
  }, [resetKey, viewport])

  useEffect(() => {
    if (!viewport) return

    // A touch scroll holds off compensation until its momentum settles, so we
    // never write scrollTop mid-flick. Desktop (no touch events) keeps the
    // immediate path — a programmatic scrollTop write there is invisible.
    let touching = false
    let momentumUntil = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    // Re-measure the anchor on every user scroll; our own corrections write
    // scrollTop and re-measure to the same offset, so they don't drift it.
    const onScroll = () => {
      anchorRef.current = measureAnchor(viewport)
    }
    onScroll()

    const compensate = () => {
      if (viewport.scrollTop <= ANCHOR_DISABLE_PX) return
      const anchor = anchorRef.current
      if (!anchor) return
      const card = viewport.querySelector<HTMLElement>(`[${BOARD_CARD_ATTR}="${CSS.escape(anchor.id)}"]`)
      if (!card) return
      const top = card.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const delta = top - anchor.offset
      if (Math.abs(delta) > MIN_COMPENSATION_PX) viewport.scrollTop += delta
    }

    // After the active scroll/momentum window passes, re-pin once so above-fold
    // reflow that landed mid-scroll is corrected without having fought momentum.
    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer)
      const wait = Math.max(0, momentumUntil - performance.now()) || MOMENTUM_SETTLE_MS
      settleTimer = setTimeout(() => {
        settleTimer = null
        if (!touching && performance.now() >= momentumUntil) compensate()
      }, wait)
    }

    const onResize = () => {
      if (touching || performance.now() < momentumUntil) {
        scheduleSettle()
        return
      }
      compensate()
    }

    const onTouchStart = () => {
      touching = true
    }
    const onTouchEnd = () => {
      touching = false
      momentumUntil = performance.now() + MOMENTUM_SETTLE_MS
      scheduleSettle()
    }

    viewport.addEventListener("scroll", onScroll, { passive: true })
    viewport.addEventListener("touchstart", onTouchStart, { passive: true })
    viewport.addEventListener("touchend", onTouchEnd, { passive: true })
    viewport.addEventListener("touchcancel", onTouchEnd, { passive: true })

    const content = viewport.firstElementChild
    const observer = new ResizeObserver(onResize)
    if (content) observer.observe(content)

    return () => {
      viewport.removeEventListener("scroll", onScroll)
      viewport.removeEventListener("touchstart", onTouchStart)
      viewport.removeEventListener("touchend", onTouchEnd)
      viewport.removeEventListener("touchcancel", onTouchEnd)
      observer.disconnect()
      if (settleTimer) clearTimeout(settleTimer)
    }
  }, [viewport])
}
