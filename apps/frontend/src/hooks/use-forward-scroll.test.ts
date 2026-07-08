import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { TouchEvent, WheelEvent } from "react"
import { useForwardScroll } from "./use-forward-scroll"

function setup(enabled = true) {
  const scrollBy = vi.fn()
  const scrollerRef = { current: { scrollBy } as unknown as HTMLElement }
  const { result } = renderHook(() => useForwardScroll(scrollerRef, enabled))
  return { scrollBy, handlers: result.current }
}

const wheel = (deltaY: number) => ({ deltaY }) as unknown as WheelEvent
const touch = (clientY: number) => ({ touches: [{ clientY }] }) as unknown as TouchEvent

describe("useForwardScroll", () => {
  it("forwards a wheel delta to the scroller when enabled", () => {
    const { scrollBy, handlers } = setup()
    handlers.onWheel(wheel(40))
    expect(scrollBy).toHaveBeenCalledWith({ top: 40 })
  })

  it("does not forward a wheel when disabled", () => {
    const { scrollBy, handlers } = setup(false)
    handlers.onWheel(wheel(40))
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("forwards a touch drag as scroll delta and resets on end", () => {
    const { scrollBy, handlers } = setup()
    handlers.onTouchStart(touch(100))
    handlers.onTouchMove(touch(70)) // finger up 30 → scroll down 30
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 30 })
    handlers.onTouchMove(touch(55)) // up another 15
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 15 })
    handlers.onTouchEnd()
    scrollBy.mockClear()
    handlers.onTouchMove(touch(10)) // no active drag → no-op
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("ignores a touch drag when disabled", () => {
    const { scrollBy, handlers } = setup(false)
    handlers.onTouchStart(touch(100))
    handlers.onTouchMove(touch(70))
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
