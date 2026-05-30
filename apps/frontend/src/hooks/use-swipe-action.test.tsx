import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useSwipeAction } from "./use-swipe-action"

function touchEvent(target: EventTarget, x: number, y: number): React.TouchEvent {
  return {
    target,
    touches: [{ clientX: x, clientY: y }],
  } as unknown as React.TouchEvent
}

function makeScroller({
  overflowX,
  scrollWidth,
  clientWidth,
}: {
  overflowX: string
  scrollWidth: number
  clientWidth: number
}) {
  const el = document.createElement("div")
  el.style.overflowX = overflowX
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true })
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true })
  const child = document.createElement("span")
  el.appendChild(child)
  document.body.appendChild(el)
  return { el, child }
}

describe("useSwipeAction", () => {
  it("ignores touches that start inside a horizontally-scrollable ancestor", () => {
    const onSwipe = vi.fn()
    const { result } = renderHook(() => useSwipeAction({ onSwipe }))
    const { el, child } = makeScroller({ overflowX: "auto", scrollWidth: 500, clientWidth: 200 })

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(child, 200, 100))
      result.current.handlers.onTouchMove(touchEvent(child, 80, 100))
      result.current.handlers.onTouchEnd()
    })

    expect(onSwipe).not.toHaveBeenCalled()
    expect(result.current.offset).toBe(0)
    expect(result.current.isLocked).toBe(false)

    el.remove()
  })

  it("still tracks swipes when the ancestor has overflow-x:auto but no actual horizontal overflow", () => {
    const onSwipe = vi.fn()
    const { result } = renderHook(() => useSwipeAction({ onSwipe }))
    const { el, child } = makeScroller({ overflowX: "auto", scrollWidth: 200, clientWidth: 200 })

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(child, 200, 100))
      result.current.handlers.onTouchMove(touchEvent(child, 80, 100))
      result.current.handlers.onTouchEnd()
    })

    expect(onSwipe).toHaveBeenCalledTimes(1)

    el.remove()
  })

  it("triggers onSwipe for a leftward swipe past threshold outside any scroller", () => {
    const onSwipe = vi.fn()
    const { result } = renderHook(() => useSwipeAction({ onSwipe, threshold: 80 }))
    const target = document.createElement("div")
    document.body.appendChild(target)

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(target, 200, 100))
      result.current.handlers.onTouchMove(touchEvent(target, 100, 100))
      result.current.handlers.onTouchEnd()
    })

    expect(onSwipe).toHaveBeenCalledTimes(1)

    target.remove()
  })

  it("snaps back to 0 and does not fire onSwipe when the touch is cancelled mid-swipe", () => {
    const onSwipe = vi.fn()
    const { result } = renderHook(() => useSwipeAction({ onSwipe, threshold: 80 }))
    const target = document.createElement("div")
    document.body.appendChild(target)

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(target, 200, 100))
      result.current.handlers.onTouchMove(touchEvent(target, 110, 100))
    })

    // Mid-swipe the message is shifted left.
    expect(result.current.offset).toBeLessThan(0)

    act(() => {
      // The browser/OS takes over the gesture and fires touchcancel
      // instead of touchend.
      result.current.handlers.onTouchCancel()
    })

    // Offset must reset so the message does not stay stuck shifted left.
    expect(result.current.offset).toBe(0)
    expect(result.current.isLocked).toBe(false)
    expect(onSwipe).not.toHaveBeenCalled()

    target.remove()
  })
})
