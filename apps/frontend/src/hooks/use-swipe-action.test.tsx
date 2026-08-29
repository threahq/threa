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

  describe("the L (swipe, then down)", () => {
    function gesture(onSwipe: () => void, onSwipeDown: (() => void) | undefined, moves: Array<[number, number]>) {
      const { result } = renderHook(() => useSwipeAction({ onSwipe, onSwipeDown, threshold: 80, downThreshold: 24 }))
      const target = document.createElement("div")
      document.body.appendChild(target)
      act(() => {
        result.current.handlers.onTouchStart(touchEvent(target, 200, 100))
        for (const [x, y] of moves) result.current.handlers.onTouchMove(touchEvent(target, x, y))
      })
      const armBeforeRelease = result.current.arm
      act(() => result.current.handlers.onTouchEnd())
      target.remove()
      return { result, armBeforeRelease }
    }

    it("fires the down action when the finger drags down past the leg after locking", () => {
      const onSwipe = vi.fn()
      const onSwipeDown = vi.fn()
      const { armBeforeRelease } = gesture(onSwipe, onSwipeDown, [
        [100, 100],
        [100, 130],
      ])
      expect(armBeforeRelease).toBe("down")
      expect(onSwipeDown).toHaveBeenCalledTimes(1)
      expect(onSwipe).not.toHaveBeenCalled()
    })

    it("measures the leg from the lock point, so drift during the stroke does not arm it", () => {
      const onSwipe = vi.fn()
      const onSwipeDown = vi.fn()
      // 20px of drift before the lock, then 15px after: neither leg alone reaches 24.
      const { armBeforeRelease } = gesture(onSwipe, onSwipeDown, [
        [150, 120],
        [100, 120],
        [100, 135],
      ])
      expect(armBeforeRelease).toBe("primary")
      expect(onSwipe).toHaveBeenCalledTimes(1)
      expect(onSwipeDown).not.toHaveBeenCalled()
    })

    it("disarms when the finger comes back up, and stays a plain swipe with no down action wired", () => {
      const onSwipe = vi.fn()
      const onSwipeDown = vi.fn()
      const back = gesture(onSwipe, onSwipeDown, [
        [100, 100],
        [100, 140],
        [100, 105],
      ])
      expect(back.armBeforeRelease).toBe("primary")
      expect(onSwipe).toHaveBeenCalledTimes(1)
      expect(onSwipeDown).not.toHaveBeenCalled()

      const plain = gesture(onSwipe, undefined, [
        [100, 100],
        [100, 160],
      ])
      expect(plain.armBeforeRelease).toBe("primary")
      expect(onSwipe).toHaveBeenCalledTimes(2)
    })
  })

  describe("claiming the touch", () => {
    function scrollerWithRow() {
      const scroller = document.createElement("div")
      scroller.style.overflowY = "auto"
      Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true })
      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true })
      const row = document.createElement("div")
      scroller.appendChild(row)
      document.body.appendChild(scroller)
      const listeners: Array<(e: TouchEvent) => void> = []
      vi.spyOn(row, "addEventListener").mockImplementation((type, listener) => {
        if (type === "touchmove") listeners.push(listener as (e: TouchEvent) => void)
      })
      const nativeMove = () => {
        const event = { cancelable: true, preventDefault: vi.fn() } as unknown as TouchEvent
        for (const listener of listeners) listener(event)
        return event.preventDefault as ReturnType<typeof vi.fn>
      }
      return { scroller, row, nativeMove }
    }
    const withCurrentTarget = (row: HTMLElement, x: number, y: number) =>
      ({ ...touchEvent(row, x, y), currentTarget: row }) as React.TouchEvent

    it("takes the touch half-way to the threshold: moves are prevented and the timeline is pinned until release", () => {
      const onSwipeDown = vi.fn()
      const { result } = renderHook(() => useSwipeAction({ onSwipe: vi.fn(), onSwipeDown, threshold: 80 }))
      const { scroller, row, nativeMove } = scrollerWithRow()

      act(() => {
        result.current.handlers.onTouchStart(withCurrentTarget(row, 200, 100))
        result.current.handlers.onTouchMove(touchEvent(row, 170, 100))
      })
      expect(nativeMove()).not.toHaveBeenCalled()
      expect(scroller.style.overflowY).toBe("auto")

      act(() => result.current.handlers.onTouchMove(touchEvent(row, 155, 100)))
      expect(nativeMove()).toHaveBeenCalled()
      expect(scroller.style.overflowY).toBe("hidden")

      // The row follows the finger down the leg, a little past the arming point.
      act(() => {
        result.current.handlers.onTouchMove(touchEvent(row, 100, 100))
        result.current.handlers.onTouchMove(touchEvent(row, 100, 120))
      })
      expect(result.current.offsetY).toBe(20)
      act(() => result.current.handlers.onTouchMove(touchEvent(row, 100, 200)))
      expect(result.current.offsetY).toBe(36)
      expect(result.current.arm).toBe("down")

      act(() => result.current.handlers.onTouchEnd())
      expect(onSwipeDown).toHaveBeenCalledTimes(1)
      expect(scroller.style.overflowY).toBe("auto")
      expect(result.current.offsetY).toBe(0)
      expect(nativeMove()).not.toHaveBeenCalled()
      scroller.remove()
    })
  })
})
