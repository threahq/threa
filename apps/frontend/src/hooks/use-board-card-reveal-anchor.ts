import { useCallback, useEffect, useMemo, useRef } from "react"
import type { RefObject } from "react"
import type { VirtualizerHandle } from "virtua"
import { attachScrollGestureDirection } from "./scroll-gesture-direction"

/** No-resize quiet gap after which the reveal window closes on its own. Long
 *  enough to span the sync expand and its async server backfill; short enough that
 *  a live reply landing after it pushes the view normally again. */
const REVEAL_SETTLE_MS = 400
/** Hard cap so a stalled backfill can't leave the window armed forever. */
const REVEAL_MAX_MS = 2500
/** The cap while the card says its server backfill is still in flight. An ordinary
 *  page routinely takes 600ms+, so the plain cap would expire mid-request and let
 *  the late rows shove the trailing region uncompensated. Past this the window
 *  closes regardless — that slow a backfill ends in the seam's error label. */
const REVEAL_HELD_MAX_MS = 10_000

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
  /** Read at each settle check: true while the card's server backfill for this
   *  reveal is still in flight, so the window waits for the rows it asked for
   *  instead of expiring just before they land. */
  shouldHoldOpen?: () => boolean
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
 *
 * WHAT is held still: a LANDMARK row when the caller names one (the first reply of
 * the visible window, the row directly below the seam), else the card's bottom
 * edge. The landmark is the better fixed point because it separates the two kinds
 * of growth a card sees during a reveal: growth ABOVE it (the revealed page, a
 * mid-region backfill) moves it down and is compensated, while growth BELOW it (a
 * live tail reply, the composer expanding) doesn't move it and correctly passes
 * through. Anchoring on the card bottom conflates the two and scrolls the reader
 * away from their eye-line on any tail growth.
 */
export interface BeginRevealOptions {
  /** `"tap"` (default): any scroll gesture hands control back to the reader.
   *  `"scroll"`: the reveal WAS an upward scroll, so the gesture that triggered it
   *  — and the ones continuing it — must not disarm the hold, or the inserted page
   *  lands uncompensated and the viewport leaps. Downward scroll still closes. */
  mode?: "tap" | "scroll"
  /** The row to hold still: the first reply of the window as it stands BEFORE the
   *  reveal, which the incoming page pushes down. Only read on ARM — the first
   *  page's landmark stays the fixed point for the whole walk, because re-pointing
   *  it mid-window re-baselines against an element whose position already includes
   *  pending, uncompensated growth (the same trap as re-measuring the anchor). */
  landmark?: HTMLElement | null
}

export function useBoardCardRevealAnchor({ cardRef, scrollerRef, listRef, shouldHoldOpen }: Options): {
  beginReveal: (opts?: BeginRevealOptions) => void
  closeReveal: () => void
} {
  // Target viewport-Y of the anchored target (landmark top, or the card's bottom
  // edge) while the window is armed; null when disarmed (the RO correction and
  // gesture-close both key off this).
  const anchorRef = useRef<number | null>(null)
  const landmarkRef = useRef<HTMLElement | null>(null)
  const shouldHoldOpenRef = useRef(shouldHoldOpen)
  shouldHoldOpenRef.current = shouldHoldOpen
  const armedAtRef = useRef(0)
  const heldRef = useRef(false)
  // The scroller's own offset when the window armed, and the total scroll we have
  // injected since — together they separate the card's growth from the reader's
  // own scrolling, so the correction only ever undoes the former.
  const scrollTopAtArmRef = useRef(0)
  const injectedRef = useRef(0)
  const settleTimerRef = useRef(0)
  const maxTimerRef = useRef(0)
  const detachGestureRef = useRef<(() => void) | null>(null)

  const measure = useCallback(() => {
    const scroller = scrollerRef?.current
    if (!scroller) return null
    const scrollerTop = scroller.getBoundingClientRect().top
    const landmark = landmarkRef.current
    if (landmark) return landmark.getBoundingClientRect().top - scrollerTop
    const card = cardRef.current
    if (!card) return null
    return card.getBoundingClientRect().bottom - scrollerTop
  }, [cardRef, scrollerRef])

  const close = useCallback(() => {
    anchorRef.current = null
    landmarkRef.current = null
    heldRef.current = false
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

  /** (Re)arm the hard cap: `REVEAL_MAX_MS` from now normally, or whatever is left
   *  of `REVEAL_HELD_MAX_MS` since the ARM once a settle check has held the window
   *  open — a hold extends the ceiling, it never resets it. */
  const armMaxTimer = useCallback(() => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    const remaining = heldRef.current ? armedAtRef.current + REVEAL_HELD_MAX_MS - Date.now() : REVEAL_MAX_MS
    maxTimerRef.current = window.setTimeout(close, Math.max(0, remaining))
  }, [close])

  const onSettle: () => void = useCallback(() => {
    settleTimerRef.current = 0
    if (shouldHoldOpenRef.current?.()) {
      if (!heldRef.current) {
        heldRef.current = true
        armMaxTimer()
      }
      settleTimerRef.current = window.setTimeout(onSettle, REVEAL_SETTLE_MS)
      return
    }
    close()
  }, [close, armMaxTimer])

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
        landmarkRef.current = opts?.landmark ?? null
        const anchor = measure()
        if (anchor === null) {
          landmarkRef.current = null
          return
        }
        anchorRef.current = anchor
        scrollTopAtArmRef.current = scroller.scrollTop
        injectedRef.current = 0
        armedAtRef.current = Date.now()
      }
      armMaxTimer()
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
    [measure, scrollerRef, listRef, close, armMaxTimer]
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
        // A landmark that left the DOM was deleted or re-filed: its rect is
        // garbage, and correcting against garbage moves the reader somewhere
        // arbitrary. Bail instead.
        const landmark = landmarkRef.current
        if (landmark && !landmark.isConnected) {
          close()
          return
        }
        const after = measure()
        if (after === null) return
        // The anchored target's viewport-Y is its document-Y minus the scroll
        // offset, so the GROWTH above it since arming is what's left once the
        // reader's own scrolling (and our own injections, which move scrollTop the
        // same way) is added back in. Driving total injected scroll to total growth
        // holds it still while letting a continuous flick scroll through.
        const growth = after - target + (scroller.scrollTop - scrollTopAtArmRef.current)
        const correction = growth - injectedRef.current
        if (Math.abs(correction) > 0.5) {
          // Book what actually APPLIED, not what was asked for: `scrollBy` clamps
          // at the scroll extents and iOS drops it outright during an active touch.
          // Recording the request would under-compensate every later pass forever.
          // If virtua applies asynchronously the sync delta reads 0, we record 0,
          // and the next RO pass re-requests the remainder — self-healing.
          const before = scroller.scrollTop
          listRef?.current?.scrollBy(correction)
          injectedRef.current += scroller.scrollTop - before
        }
      })
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(onSettle, REVEAL_SETTLE_MS)
    })
    observer.observe(card)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [cardRef, measure, listRef, scrollerRef, close, onSettle])

  useEffect(() => () => close(), [close])

  return useMemo(() => ({ beginReveal, closeReveal: close }), [beginReveal, close])
}
