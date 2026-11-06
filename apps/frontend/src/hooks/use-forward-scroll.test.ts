import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { TouchEvent, WheelEvent } from "react"
import { useForwardScroll } from "./use-forward-scroll"
import { attachScrollGestureDirection } from "./scroll-gesture-direction"

function setup(enabled = true) {
  const order: string[] = []
  const scrollBy = vi.fn(() => order.push("scroll"))
  const scroller = document.createElement("div")
  scroller.scrollBy = scrollBy
  const gestures: Array<{ type: string; deltaY?: number; clientY?: number }> = []
  for (const type of ["wheel", "touchstart", "touchmove"]) {
    scroller.addEventListener(type, (event) => {
      order.push(type)
      gestures.push({
        type,
        ...(event instanceof window.WheelEvent
          ? { deltaY: event.deltaY }
          : { clientY: (event as globalThis.TouchEvent).touches[0]?.clientY }),
      })
    })
  }
  const scrollerRef = { current: scroller }
  const { result } = renderHook(() => useForwardScroll(scrollerRef, enabled))
  return { scrollBy, gestures, order, scroller, handlers: result.current }
}

const wheel = (deltaY: number) => ({ deltaY }) as unknown as WheelEvent
const touch = (clientY: number, identifier = 1) => {
  const touches = [{ clientY, identifier }] as unknown as globalThis.Touch[]
  return { touches, nativeEvent: { touches } } as unknown as TouchEvent
}

const endTouch = () => ({ touches: [], nativeEvent: { touches: [] } }) as unknown as TouchEvent

describe("useForwardScroll", () => {
  it("forwards a wheel delta to the scroller when enabled", () => {
    const { scrollBy, gestures, order, handlers } = setup()
    handlers.onWheel(wheel(40))
    expect({ gestures, calls: scrollBy.mock.calls, order }).toEqual({
      gestures: [{ type: "wheel", deltaY: 40 }],
      calls: [[{ top: 40 }]],
      order: ["wheel", "scroll"],
    })
  })

  it("does not forward a wheel when disabled", () => {
    const { scrollBy, gestures, handlers } = setup(false)
    handlers.onWheel(wheel(40))
    expect({ gestures, calls: scrollBy.mock.calls }).toEqual({ gestures: [], calls: [] })
  })

  it("forwards a touch drag as scroll delta and resets on end", () => {
    const { scrollBy, gestures, order, handlers } = setup()
    handlers.onTouchStart(touch(100))
    handlers.onTouchMove(touch(70)) // finger up 30 → scroll down 30
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 30 })
    handlers.onTouchMove(touch(55)) // up another 15
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 15 })
    expect(gestures).toEqual([
      { type: "touchstart", clientY: 100 },
      { type: "touchmove", clientY: 70 },
      { type: "touchmove", clientY: 55 },
    ])
    expect(order).toEqual(["touchstart", "touchmove", "scroll", "touchmove", "scroll"])
    handlers.onTouchEnd(endTouch())
    scrollBy.mockClear()
    handlers.onTouchMove(touch(10)) // no active drag → no-op
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it.each(["onTouchEnd", "onTouchCancel"] as const)(
    "resets the owned direction tracker on %s before the next gesture",
    (termination) => {
      const { handlers, scroller } = setup()
      const directions: string[] = []
      const detach = attachScrollGestureDirection(scroller, {
        onUp: () => directions.push("up"),
        onDown: () => directions.push("down"),
      })
      try {
        handlers.onTouchStart(touch(100, 1))
        handlers.onTouchMove(touch(70, 1))
        handlers[termination](endTouch())
        handlers.onTouchMove(touch(55, 1))
        handlers.onTouchStart(touch(100, 2))
        handlers.onTouchMove(touch(120, 2))
        expect(directions).toEqual(["down", "up"])
      } finally {
        detach()
      }
    }
  )

  it("ignores a touch drag when disabled", () => {
    const { scrollBy, gestures, handlers } = setup(false)
    handlers.onTouchStart(touch(100))
    handlers.onTouchMove(touch(70))
    expect({ gestures, calls: scrollBy.mock.calls }).toEqual({ gestures: [], calls: [] })
  })
})
