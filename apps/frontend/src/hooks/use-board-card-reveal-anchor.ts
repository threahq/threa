import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"
import type { VirtualizerHandle } from "virtua"
import { attachScrollGestureDirection } from "./scroll-gesture-direction"

/** No-resize quiet gap after which the reveal window closes on its own. Long
 *  enough to span the sync expand and its async server backfill; short enough that
 *  a live reply landing after it pushes the view normally again. */
const REVEAL_SETTLE_MS = 400
/** Hard cap so a stalled backfill can't leave the window armed forever. */
const REVEAL_MAX_MS = 2500

/** A keydown counts as "the reader scrolled" only when it can move the scroller —
 *  not when it's typing. The board composer renders inside the SAME scroller, so
 *  its keystrokes bubble to the keydown listener; without this gate a space typed
 *  into the composer mid-backfill would close the window and drop the correction. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

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
export interface BeginRevealOptions {
  /** `"tap"` (default): any scroll gesture hands control back to the reader.
   *  `"scroll"`: the reveal WAS an upward scroll, so the gesture that triggered it
   *  — and the ones continuing it — must not disarm the hold, or the inserted page
   *  lands uncompensated and the viewport leaps. Downward scroll still closes. */
  mode?: "tap" | "scroll"
}

export function useBoardCardRevealAnchor({
  cardRef,
  scrollerRef,
  listRef,
}: Options): (opts?: BeginRevealOptions) => void {
  // Target viewport-Y of the card's bottom edge while the window is armed; null
  // when disarmed (the RO correction and gesture-close both key off this).
  const anchorRef = useRef<number | null>(null)
  // The scroller's own offset when the window armed, and the total scroll we have
  // injected since — together they separate the card's growth from the reader's
  // own scrolling, so the correction only ever undoes the former.
  const scrollTopAtArmRef = useRef(0)
  const injectedRef = useRef(0)
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
    scrollTopAtArmRef.current = 0
    injectedRef.current = 0
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

  const beginReveal = useCallback(
    (opts?: BeginRevealOptions) => {
      const scroller = scrollerRef?.current
      if (!scroller || !listRef?.current) return
      const scrollMode = opts?.mode === "scroll"
      // Re-arming mid-window (the next page, one gesture later) must NOT re-baseline:
      // a correction for the previous page can still be pending (RO → rAF), so a
      // fresh measurement would adopt growth nobody has compensated yet and the
      // trailing replies would leap by a page. Keep the arm-time baseline; only the
      // deadline and the listeners (the mode may differ) are refreshed.
      if (anchorRef.current === null) {
        const anchor = measure()
        if (anchor === null) return
        anchorRef.current = anchor
        scrollTopAtArmRef.current = scroller.scrollTop
        injectedRef.current = 0
      }
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      maxTimerRef.current = window.setTimeout(close, REVEAL_MAX_MS)
      // A deliberate scroll means the reader took over — stop holding immediately.
      // keydown is gated to non-editable targets so typing in the in-scroller
      // composer (whose keystrokes bubble here) doesn't disarm the hold.
      detachGestureRef.current?.()
      const detachDirection = attachScrollGestureDirection(scroller, {
        onUp: () => {
          if (!scrollMode) close()
        },
        onDown: close,
      })
      const onKeyGesture = (e: KeyboardEvent) => {
        if (!isEditableTarget(e.target)) close()
      }
      scroller.addEventListener("keydown", onKeyGesture)
      detachGestureRef.current = () => {
        detachDirection()
        scroller.removeEventListener("keydown", onKeyGesture)
      }
    },
    [measure, scrollerRef, listRef, close]
  )

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
        const scroller = scrollerRef?.current
        if (target === null || !scroller) return
        const after = measure()
        if (after === null) return
        // A bottom edge's viewport-Y is its document-Y minus the scroll offset, so
        // the card's GROWTH since arming is what's left once the reader's own
        // scrolling (and our own injections, which move scrollTop the same way) is
        // added back in. Driving total injected scroll to total growth holds the
        // trailing replies still while letting a continuous flick scroll through.
        const growth = after - target + (scroller.scrollTop - scrollTopAtArmRef.current)
        const correction = growth - injectedRef.current
        if (Math.abs(correction) > 0.5) {
          listRef?.current?.scrollBy(correction)
          injectedRef.current += correction
        }
      })
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(close, REVEAL_SETTLE_MS)
    })
    observer.observe(card)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [cardRef, measure, listRef, scrollerRef, close])

  useEffect(() => () => close(), [close])

  return beginReveal
}
