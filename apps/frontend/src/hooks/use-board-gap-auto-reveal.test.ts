import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { useBoardGapAutoReveal } from "./use-board-gap-auto-reveal"

// jsdom has no IntersectionObserver and no layout; drive the seam's visibility by
// hand so the gesture/intersection pairing is what the tests actually assert.
// `observe`/`unobserve` track targets the way the real API does — the hook re-arms
// by re-observing, and a re-observed target only counts once the harness delivers
// its (asynchronous, in the browser) entry.
let observers: FakeIntersectionObserver[] = []
class FakeIntersectionObserver {
  cb: (entries: { isIntersecting: boolean }[]) => void
  targets: Element[] = []
  disconnected = false
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    this.cb = cb
    observers.push(this)
  }
  observe(target: Element) {
    this.targets.push(target)
  }
  unobserve(target: Element) {
    this.targets = this.targets.filter((t) => t !== target)
  }
  disconnect() {
    this.targets = []
    this.disconnected = true
  }
}

/** One intersection report per observed target, as the browser delivers after layout. */
function deliverIntersection(visible: boolean) {
  for (const observer of observers) for (const _ of observer.targets) observer.cb([{ isIntersecting: visible }])
}

function wheel(target: HTMLElement, deltaY: number) {
  target.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }))
}

function touch(target: HTMLElement, type: "touchstart" | "touchmove", clientY: number) {
  const event = new Event(type, { bubbles: true }) as Event & { touches: { clientY: number }[] }
  event.touches = [{ clientY }]
  target.dispatchEvent(event)
}

function setup(options: { enabled?: boolean; withScroller?: boolean } = {}) {
  const scroller = document.createElement("div")
  const card = document.createElement("div")
  const sibling = document.createElement("div")
  const seam = document.createElement("button")
  card.append(seam)
  scroller.append(card, sibling)
  document.body.append(scroller)
  const onReveal = vi.fn()
  const { rerender, unmount } = renderHook(
    ({ enabled }: { enabled: boolean }) =>
      useBoardGapAutoReveal({
        seamRef: { current: seam },
        cardRef: { current: card },
        scrollerRef: options.withScroller === false ? undefined : { current: scroller },
        enabled,
        onReveal,
      }),
    { initialProps: { enabled: options.enabled ?? true } }
  )
  return { seam, card, sibling, scroller, onReveal, rerender, unmount }
}

describe("useBoardGapAutoReveal", () => {
  let originalIO: typeof IntersectionObserver | undefined
  beforeEach(() => {
    observers = []
    document.body.innerHTML = ""
    originalIO = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
  })
  afterEach(() => {
    globalThis.IntersectionObserver = originalIO as typeof IntersectionObserver
  })

  it("reveals one page per fresh intersection report, not per wheel event", () => {
    const { card, onReveal } = setup()
    deliverIntersection(true)
    wheel(card, -40)
    wheel(card, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)

    deliverIntersection(true)
    wheel(card, -40)
    expect(onReveal).toHaveBeenCalledTimes(2)
  })

  it("gives a flick one page: rapid wheel events with no fresh report in between don't dump the middle", () => {
    const { card, onReveal } = setup()
    deliverIntersection(true)
    for (let i = 0; i < 5; i++) wheel(card, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it("stays closed when the re-armed report says the revealed page pushed the seam off screen", () => {
    const { card, onReveal } = setup()
    deliverIntersection(true)
    wheel(card, -40)
    deliverIntersection(false)
    wheel(card, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it("does not reveal while the seam is off screen, however far the reader scrolls up", () => {
    const { card, onReveal } = setup()
    deliverIntersection(false)
    wheel(card, -40)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("never reveals on intersection alone — a short page must not chain without a fresh gesture", () => {
    const { onReveal } = setup()
    deliverIntersection(true)
    deliverIntersection(true)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("ignores a gesture over another card: only the card under the pointer pages", () => {
    const { sibling, scroller, onReveal } = setup()
    deliverIntersection(true)
    wheel(sibling, -40)
    wheel(scroller, -40)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("ignores downward scrolling: reading forward doesn't dig up older messages", () => {
    const { card, onReveal } = setup()
    deliverIntersection(true)
    wheel(card, 40)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("fires on a finger moving down the screen (content scrolling up), not up", () => {
    const { card, onReveal } = setup()
    deliverIntersection(true)
    touch(card, "touchstart", 200)
    touch(card, "touchmove", 260)
    expect(onReveal).toHaveBeenCalledTimes(1)
    deliverIntersection(true)
    touch(card, "touchmove", 210)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it("ignores a touchmove with no recorded start (listener attached mid-drag)", () => {
    const { card, onReveal } = setup()
    deliverIntersection(true)
    touch(card, "touchmove", 260)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("does nothing when disabled, and detaches when it becomes disabled", () => {
    const { card, onReveal, rerender } = setup({ enabled: false })
    deliverIntersection(true)
    wheel(card, -40)
    expect(onReveal).not.toHaveBeenCalled()

    rerender({ enabled: true })
    deliverIntersection(true)
    wheel(card, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    deliverIntersection(true)
    wheel(card, -40)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it("detaches on unmount", () => {
    const { card, onReveal, unmount } = setup()
    deliverIntersection(true)
    unmount()
    wheel(card, -40)
    expect(onReveal).not.toHaveBeenCalled()
    expect(observers[0].disconnected).toBe(true)
  })

  it("no-ops without a scroller (off-board surfaces, tests)", () => {
    const { card, onReveal } = setup({ withScroller: false })
    expect(observers).toHaveLength(0)
    wheel(card, -40)
    expect(onReveal).not.toHaveBeenCalled()
  })
})
