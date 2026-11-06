import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { TouchEvent, WheelEvent } from "react"
import { useForwardScroll } from "./use-forward-scroll"

function setup(enabled = true) {
  const scrollBy = vi.fn()
  const scroller = document.createElement("div")
  scroller.scrollBy = scrollBy
  const gestures: Array<{ type: string; deltaY?: number; clientY?: number }> = []
  for (const type of ["wheel", "touchstart", "touchmove"]) {
    scroller.addEventListener(type, (event) => {
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
  return { scrollBy, gestures, handlers: result.current }
}

const wheel = (deltaY: number) => ({ deltaY }) as unknown as WheelEvent
const touch = (clientY: number) => {
  const touches = [{ clientY }] as unknown as globalThis.Touch[]
  return { touches, nativeEvent: { touches } } as unknown as TouchEvent
}

describe("useForwardScroll", () => {
  it("forwards a wheel delta to the scroller when enabled", () => {
    const { scrollBy, gestures, handlers } = setup()
    handlers.onWheel(wheel(40))
    expect({ gestures, calls: scrollBy.mock.calls }).toEqual({
      gestures: [{ type: "wheel", deltaY: 40 }],
      calls: [[{ top: 40 }]],
    })
  })

  it("does not forward a wheel when disabled", () => {
    const { scrollBy, gestures, handlers } = setup(false)
    handlers.onWheel(wheel(40))
    expect({ gestures, calls: scrollBy.mock.calls }).toEqual({ gestures: [], calls: [] })
  })

  it("forwards a touch drag as scroll delta and resets on end", () => {
    const { scrollBy, gestures, handlers } = setup()
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
    handlers.onTouchEnd()
    scrollBy.mockClear()
    handlers.onTouchMove(touch(10)) // no active drag → no-op
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("ignores a touch drag when disabled", () => {
    const { scrollBy, gestures, handlers } = setup(false)
    handlers.onTouchStart(touch(100))
    handlers.onTouchMove(touch(70))
    expect({ gestures, calls: scrollBy.mock.calls }).toEqual({ gestures: [], calls: [] })
  })
})
