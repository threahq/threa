import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { useBoardGapAutoReveal } from "./use-board-gap-auto-reveal"

// jsdom has no IntersectionObserver and no layout; drive the seam's visibility by
// hand so the gesture/intersection pairing is what the tests actually assert.
let observers: FakeIntersectionObserver[] = []
class FakeIntersectionObserver {
  cb: (entries: { isIntersecting: boolean }[]) => void
  disconnected = false
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    this.cb = cb
    observers.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
}

function setSeamVisible(visible: boolean) {
  for (const observer of observers) observer.cb([{ isIntersecting: visible }])
}

function wheel(scroller: HTMLElement, deltaY: number) {
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }))
}

function touch(scroller: HTMLElement, type: "touchstart" | "touchmove", clientY: number) {
  const event = new Event(type, { bubbles: true }) as Event & { touches: { clientY: number }[] }
  event.touches = [{ clientY }]
  scroller.dispatchEvent(event)
}

function setup(options: { enabled?: boolean; withScroller?: boolean } = {}) {
  const seam = document.createElement("button")
  const scroller = document.createElement("div")
  const onReveal = vi.fn()
  const { rerender, unmount } = renderHook(
    ({ enabled }: { enabled: boolean }) =>
      useBoardGapAutoReveal({
        seamRef: { current: seam },
        scrollerRef: options.withScroller === false ? undefined : { current: scroller },
        enabled,
        onReveal,
      }),
    { initialProps: { enabled: options.enabled ?? true } }
  )
  return { seam, scroller, onReveal, rerender, unmount }
}

describe("useBoardGapAutoReveal", () => {
  let originalIO: typeof IntersectionObserver | undefined
  beforeEach(() => {
    observers = []
    originalIO = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
  })
  afterEach(() => {
    globalThis.IntersectionObserver = originalIO as typeof IntersectionObserver
  })

  it("reveals one page per upward wheel event while the seam is on screen", () => {
    const { scroller, onReveal } = setup()
    setSeamVisible(true)
    wheel(scroller, -40)
    wheel(scroller, -40)
    expect(onReveal).toHaveBeenCalledTimes(2)
  })

  it("does not reveal while the seam is off screen, however far the reader scrolls up", () => {
    const { scroller, onReveal } = setup()
    setSeamVisible(false)
    wheel(scroller, -40)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("never reveals on intersection alone — a short page must not chain without a fresh gesture", () => {
    const { onReveal } = setup()
    setSeamVisible(true)
    setSeamVisible(true)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("ignores downward scrolling: reading forward doesn't dig up older messages", () => {
    const { scroller, onReveal } = setup()
    setSeamVisible(true)
    wheel(scroller, 40)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("fires on a finger moving down the screen (content scrolling up), not up", () => {
    const { scroller, onReveal } = setup()
    setSeamVisible(true)
    touch(scroller, "touchstart", 200)
    touch(scroller, "touchmove", 260)
    expect(onReveal).toHaveBeenCalledTimes(1)
    touch(scroller, "touchmove", 210)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it("ignores a touchmove with no recorded start (listener attached mid-drag)", () => {
    const { scroller, onReveal } = setup()
    setSeamVisible(true)
    touch(scroller, "touchmove", 260)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("does nothing when disabled, and detaches when it becomes disabled", () => {
    const { scroller, onReveal, rerender } = setup({ enabled: false })
    setSeamVisible(true)
    wheel(scroller, -40)
    expect(onReveal).not.toHaveBeenCalled()

    rerender({ enabled: true })
    setSeamVisible(true)
    wheel(scroller, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    wheel(scroller, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it("detaches on unmount", () => {
    const { scroller, onReveal, unmount } = setup()
    setSeamVisible(true)
    unmount()
    wheel(scroller, -40)
    expect(onReveal).not.toHaveBeenCalled()
    expect(observers[0].disconnected).toBe(true)
  })

  it("no-ops without a scroller (off-board surfaces, tests)", () => {
    const { scroller, onReveal } = setup({ withScroller: false })
    expect(observers).toHaveLength(0)
    wheel(scroller, -40)
    expect(onReveal).not.toHaveBeenCalled()
  })
})
