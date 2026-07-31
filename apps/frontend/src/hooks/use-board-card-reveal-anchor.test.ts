import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import type { VirtualizerHandle } from "virtua"
import { useBoardCardRevealAnchor } from "./use-board-card-reveal-anchor"

// The hook reacts to card resizes via a ResizeObserver and defers its correction a
// frame; drive both deterministically. jsdom has no layout, so element rects are
// stubbed to model the card growing when its middle fills.
let roCallback: (() => void) | null = null
class FakeResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb
  }
  observe() {}
  disconnect() {}
}

function setRect(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
}

function setup() {
  const card = document.createElement("div")
  const scroller = document.createElement("div")
  setRect(scroller, 0, 720)
  setRect(card, 100, 300) // card bottom sits at viewport-Y 300 (scroller top is 0)
  scroller.scrollTop = 500
  // Close the loop the way the browser does: injected scroll moves the offset AND
  // drags the card's viewport rect with it, so the correction can't silently
  // double-count its own effect.
  const scrollBy = vi.fn((delta: number) => {
    scroller.scrollTop += delta
    const rect = card.getBoundingClientRect()
    setRect(card, rect.top - delta, rect.bottom - delta)
  })
  const listRef = { current: { scrollBy } as unknown as VirtualizerHandle }
  const { result } = renderHook(() =>
    useBoardCardRevealAnchor({ cardRef: { current: card }, scrollerRef: { current: scroller }, listRef })
  )
  return { card, scroller, scrollBy, beginReveal: result.current }
}

describe("useBoardCardRevealAnchor", () => {
  let originalRO: typeof ResizeObserver | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    roCallback = null
    originalRO = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0)
      return 0
    })
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalRO as typeof ResizeObserver
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("holds the card bottom fixed when the middle fills above the trailing replies", () => {
    const { card, scrollBy, beginReveal } = setup()
    beginReveal() // captures the anchor at the card bottom (300)
    setRect(card, 100, 632) // 332px of older middle inserted above the trailing
    roCallback?.()
    // Correct by exactly how far the bottom moved, through virtua's own scrollBy, so
    // the newest replies stay at the same viewport-Y.
    expect(scrollBy).toHaveBeenCalledWith(332)
  })

  it("leaves scroll alone when no reveal is armed, so a live append still pushes normally", () => {
    const { card, scrollBy } = setup()
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("stops holding once the reader scrolls, rather than fighting the gesture", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    beginReveal()
    scroller.dispatchEvent(new Event("wheel"))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("keeps holding when a keystroke bubbles from the in-scroller composer", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    const editor = document.createElement("textarea")
    scroller.appendChild(editor)
    beginReveal()
    // A key typed into the composer bubbles to the scroller's keydown listener;
    // it must NOT disarm the hold, or the backfill correction is dropped.
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledWith(332)
  })

  it("stops holding on a keydown that is not typing (keyboard scroll)", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    beginReveal()
    scroller.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("closes the window after the post-resize settle gap", () => {
    const { card, scrollBy, beginReveal } = setup()
    beginReveal()
    setRect(card, 100, 632)
    roCallback?.() // corrects (arms the settle timer)
    expect(scrollBy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(400) // REVEAL_SETTLE_MS elapses → close
    setRect(card, 100, 700)
    roCallback?.() // disarmed → no further correction
    expect(scrollBy).toHaveBeenCalledTimes(1)
  })

  it("scroll mode keeps holding through the upward gesture that asked for the page", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    beginReveal({ mode: "scroll" })
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledWith(332)
  })

  it("scroll mode still hands control back when the reader turns around and scrolls down", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    beginReveal({ mode: "scroll" })
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("scroll mode holds through a finger dragging down (content up) but not up", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    const touchEvent = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true }) as Event & { touches: { clientY: number }[] }
      event.touches = [{ clientY }]
      return event
    }
    beginReveal({ mode: "scroll" })
    scroller.dispatchEvent(touchEvent("touchstart", 200))
    scroller.dispatchEvent(touchEvent("touchmove", 260))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledWith(332)

    scroller.dispatchEvent(touchEvent("touchmove", 210))
    setRect(card, 100, 700)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledTimes(1)
  })

  it("scroll mode still closes on a keyboard scroll, and still ignores typing", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    const editor = document.createElement("textarea")
    scroller.appendChild(editor)
    beginReveal({ mode: "scroll" })
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledWith(332)

    scroller.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }))
    setRect(card, 100, 700)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledTimes(1)
  })

  it("compensates each page once across a multi-page window, never the growth already undone", () => {
    const { card, scrollBy, beginReveal } = setup()
    beginReveal({ mode: "scroll" })
    setRect(card, 100, 632)
    roCallback?.() // 332px of page 1 undone; the card bottom is back at 300
    expect(scrollBy).toHaveBeenLastCalledWith(332)
    // Second page grows another 68 on top of the already-corrected view.
    beginReveal({ mode: "scroll" })
    setRect(card, -232, 368)
    roCallback?.()
    expect(scrollBy).toHaveBeenLastCalledWith(68)
  })

  it("re-arming mid-correction keeps the first page's baseline, so the next page can't adopt its growth", () => {
    const { card, scrollBy, beginReveal } = setup()
    beginReveal({ mode: "scroll" })
    setRect(card, 100, 432) // page 1 lands; its correction has not run yet
    beginReveal({ mode: "scroll" }) // second wheel tick asks for page 2
    setRect(card, 100, 632)
    roCallback?.()
    // Both pages' growth since the FIRST arm — re-measuring at 432 would have
    // compensated only 200 and let the trailing replies leap by a page.
    expect(scrollBy).toHaveBeenCalledWith(332)
  })

  it("undoes the card's growth only, letting the reader's own scrolling through", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    beginReveal({ mode: "scroll" })
    // The reader keeps flicking upward: the scroller moves 50px and the card rides
    // down with it, no resize involved.
    scroller.scrollTop -= 50
    setRect(card, 150, 350)
    // Then the page lands: 120px of older middle.
    setRect(card, 150, 470)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledWith(120)
  })

  it("ignores a touchmove with no recorded start rather than reading it as a gesture", () => {
    const { card, scroller, scrollBy, beginReveal } = setup()
    const touchEvent = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true }) as Event & { touches: { clientY: number }[] }
      event.touches = [{ clientY }]
      return event
    }
    beginReveal() // tap mode: any real gesture would close the window
    // The listener attached mid-drag, so this move has no origin — direction unknown.
    scroller.dispatchEvent(touchEvent("touchmove", 260))
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).toHaveBeenCalledWith(332)
  })

  it("closes the window at the hard cap even if no resize ever settles it", () => {
    const { card, scrollBy, beginReveal } = setup()
    beginReveal()
    vi.advanceTimersByTime(2500) // REVEAL_MAX_MS elapses → close
    setRect(card, 100, 632)
    roCallback?.()
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
