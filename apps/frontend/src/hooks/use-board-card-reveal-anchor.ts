import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"
import type { VirtualizerHandle } from "virtua"

/** No-resize quiet gap after which the reveal window closes on its own. Long
 *  enough to span the sync expand and its async server backfill; short enough that
 *  a live reply landing after it pushes the view normally again. */
const REVEAL_SETTLE_MS = 400
/** Hard cap so a stalled backfill can't leave the window armed forever. */
const REVEAL_MAX_MS = 2500

interface Options {
  cardRef: RefObject<HTMLDivElement | null>
  /** The board's owned scroll viewport. Absent off the board page (tests, jsdom). */
  scrollerRef?: RefObject<HTMLDivElement | null>
  /** virtua's imperative handle for the board feed. Absent off the board page. */
  listRef?: RefObject<VirtualizerHandle | null>
}

/**
 * Holds a board card's bottom edge at a fixed viewport position while OLDER
 * content fills in above it — the "N more messages" middle-gap expand and its
 * async server backfill. Without this the fill shoves the trailing (newest)
 * replies the reader is looking at down the page: a card is a single virtua item,
 * and virtua anchors per-ITEM, so it cannot hold a position INSIDE one growing
 * item; the board scroller also runs `overflow-anchor: none`, so the browser won't
 * compensate either. The timeline gets this for free — each message is its own
 * item, so an older page is a list-level prepend its `shift` maintains from the
 * end. The board analog: measure how far the card bottom moved on each resize
 * during the reveal and undo it through virtua's own `scrollBy`, so the newest
 * replies stay put and the older middle appears above them (INV-61, the board's
 * "don't move shit on me").
 *
 * Scoped to a reveal WINDOW opened by the returned `beginReveal()` — a live reply
 * appended BELOW the trailing must still push the view, so compensation runs only
 * from the expand gesture until growth settles, and a user scroll closes it at
 * once rather than fighting a deliberate gesture. `scrollBy` goes through virtua's
 * own machinery (a raw `scrollTop` write is re-asserted away by virtua's per-item
 * resize handling — the library tug-of-war the owned-scroller design avoids).
 */
export function useBoardCardRevealAnchor({ cardRef, scrollerRef, listRef }: Options): () => void {
  // Target viewport-Y of the card's bottom edge while the window is armed; null
  // when disarmed (the RO correction and gesture-close both key off this).
  const anchorRef = useRef<number | null>(null)
  const settleTimerRef = useRef(0)
  const maxTimerRef = useRef(0)
  const detachGestureRef = useRef<(() => void) | null>(null)

  const measure = useCallback(() => {
    const card = cardRef.current
    const scroller = scrollerRef?.current
    if (!card || !scroller) return null
    return card.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top
  }, [cardRef, scrollerRef])

  const close = useCallback(() => {
    anchorRef.current = null
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = 0
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = 0
    }
    detachGestureRef.current?.()
    detachGestureRef.current = null
  }, [])

  const beginReveal = useCallback(() => {
    const scroller = scrollerRef?.current
    if (!scroller || !listRef?.current) return
    const anchor = measure()
    if (anchor === null) return
    anchorRef.current = anchor
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    maxTimerRef.current = window.setTimeout(close, REVEAL_MAX_MS)
    // A deliberate scroll means the reader took over — stop holding immediately.
    detachGestureRef.current?.()
    const onGesture = () => close()
    scroller.addEventListener("wheel", onGesture, { passive: true })
    scroller.addEventListener("touchmove", onGesture, { passive: true })
    scroller.addEventListener("keydown", onGesture)
    detachGestureRef.current = () => {
      scroller.removeEventListener("wheel", onGesture)
      scroller.removeEventListener("touchmove", onGesture)
      scroller.removeEventListener("keydown", onGesture)
    }
  }, [measure, scrollerRef, listRef, close])

  // Correct on every card resize while armed, re-arming the settle timer so the
  // window spans the expand + its backfill, then closes once growth stops.
  useEffect(() => {
    const card = cardRef.current
    if (!card || typeof ResizeObserver === "undefined") return
    let raf = 0
    const observer = new ResizeObserver(() => {
      if (anchorRef.current === null) return
      cancelAnimationFrame(raf)
      // Correct after virtua's own resize re-measure lands (next frame) so the two
      // adjustments don't stack into a double shift.
      raf = requestAnimationFrame(() => {
        const target = anchorRef.current
        if (target === null) return
        const after = measure()
        if (after === null) return
        const delta = after - target
        if (Math.abs(delta) > 0.5) listRef?.current?.scrollBy(delta)
      })
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(close, REVEAL_SETTLE_MS)
    })
    observer.observe(card)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [cardRef, measure, listRef, close])

  useEffect(() => () => close(), [close])

  return beginReveal
}
