import { describe, expect, it, vi } from "vitest"
import { attachScrollGestureDirection } from "./scroll-gesture-direction"

/** jsdom has no Touch constructor, so events carry the two fields the reader uses. */
function touchEvent(type: string, touches: { identifier: number; clientY: number }[]) {
  const event = new Event(type, { bubbles: true }) as Event & {
    touches: { identifier: number; clientY: number }[]
  }
  event.touches = touches
  return event
}

function setup() {
  const scroller = document.createElement("div")
  const onUp = vi.fn()
  const onDown = vi.fn()
  const detach = attachScrollGestureDirection(scroller, { onUp, onDown })
  return { scroller, onUp, onDown, detach }
}

describe("attachScrollGestureDirection", () => {
  it("reads a single finger dragging down the screen as scrolling toward older", () => {
    const { scroller, onUp, onDown } = setup()
    scroller.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientY: 200 }]))
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientY: 260 }]))
    expect(onUp).toHaveBeenCalledTimes(1)
    expect(onDown).not.toHaveBeenCalled()
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientY: 210 }]))
    expect(onDown).toHaveBeenCalledTimes(1)
  })

  it("ignores a touchmove with no recorded start", () => {
    const { scroller, onUp, onDown } = setup()
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientY: 260 }]))
    expect(onUp).not.toHaveBeenCalled()
    expect(onDown).not.toHaveBeenCalled()
  })

  it("re-origins on the surviving finger instead of misreading a multi-touch swap", () => {
    const { scroller, onUp, onDown } = setup()
    // A seeds the gesture and drags down the screen (content up).
    scroller.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientY: 200 }]))
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientY: 260 }]))
    expect(onUp).toHaveBeenCalledTimes(1)

    // A lifts; B (which was resting far up the screen) is now touches[0]. Comparing
    // B's coordinate against A's last would read a large DOWNWARD move nobody made.
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 2, clientY: 100 }]))
    expect(onDown).not.toHaveBeenCalled()
    expect(onUp).toHaveBeenCalledTimes(1)

    // B's next move reads against B's own origin.
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 2, clientY: 160 }]))
    expect(onUp).toHaveBeenCalledTimes(2)
    expect(onDown).not.toHaveBeenCalled()
  })

  it("clears the tracked finger when it ends, so the next gesture starts fresh", () => {
    const { scroller, onUp, onDown } = setup()
    scroller.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientY: 200 }]))
    scroller.dispatchEvent(touchEvent("touchend", []))
    scroller.dispatchEvent(touchEvent("touchstart", [{ identifier: 2, clientY: 400 }]))
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 2, clientY: 350 }]))
    expect(onDown).toHaveBeenCalledTimes(1)
    expect(onUp).not.toHaveBeenCalled()
  })

  it("reads wheel direction and detaches every listener", () => {
    const { scroller, onUp, onDown, detach } = setup()
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }))
    expect(onUp).toHaveBeenCalledTimes(1)
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }))
    expect(onDown).toHaveBeenCalledTimes(1)
    detach()
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }))
    scroller.dispatchEvent(touchEvent("touchstart", [{ identifier: 1, clientY: 200 }]))
    scroller.dispatchEvent(touchEvent("touchmove", [{ identifier: 1, clientY: 260 }]))
    expect(onUp).toHaveBeenCalledTimes(1)
  })
})
