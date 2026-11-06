import { useRef, type RefObject, type TouchEvent, type WheelEvent } from "react"

/**
 * Wheel/touch handlers that forward a scroll gesture landing on an overlay
 * control to a scroller it floats over. A pill positioned `absolute` as a sibling
 * of the scroller (the stream date pill, the board "N new" pill) is not a
 * descendant of it, so a wheel/touch caught by the pill's `pointer-events-auto`
 * button would otherwise be trapped and never scroll the content beneath. Spread
 * the returned handlers onto the control.
 *
 * `enabled` gates forwarding off while the control owns the gesture itself (e.g.
 * the date pill's jump popover is open and scrolls its own list).
 */
export function useForwardScroll(scrollerRef: RefObject<HTMLElement | null> | undefined, enabled = true) {
  // Touch-drag start Y so a touch scroll begun on the control still scrolls the
  // scroller (the touch equivalent of onWheel); a tap doesn't move, so it never
  // scrolls.
  const touchStartY = useRef<number | null>(null)
  const finishTouch = (type: "touchend" | "touchcancel", e: TouchEvent) => {
    touchStartY.current = null
    if (enabled) {
      scrollerRef?.current?.dispatchEvent(new window.TouchEvent(type, { touches: Array.from(e.nativeEvent.touches) }))
    }
  }

  return {
    onWheel: (e: WheelEvent) => {
      const scroller = scrollerRef?.current
      if (!enabled || !scroller) return
      // Gesture listeners must run before movement so landing refinements yield.
      scroller.dispatchEvent(
        new window.WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode })
      )
      scroller.scrollBy({ top: e.deltaY })
    },
    onTouchStart: (e: TouchEvent) => {
      touchStartY.current = enabled ? (e.touches[0]?.clientY ?? null) : null
      if (enabled) {
        scrollerRef?.current?.dispatchEvent(
          new window.TouchEvent("touchstart", { touches: Array.from(e.nativeEvent.touches) })
        )
      }
    },
    onTouchMove: (e: TouchEvent) => {
      if (touchStartY.current == null) return
      const y = e.touches[0]?.clientY ?? touchStartY.current
      const scroller = scrollerRef?.current
      scroller?.dispatchEvent(new window.TouchEvent("touchmove", { touches: Array.from(e.nativeEvent.touches) }))
      scroller?.scrollBy({ top: touchStartY.current - y })
      touchStartY.current = y
    },
    onTouchEnd: (e: TouchEvent) => finishTouch("touchend", e),
    onTouchCancel: (e: TouchEvent) => finishTouch("touchcancel", e),
  }
}
