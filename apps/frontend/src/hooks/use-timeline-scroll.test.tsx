import { describe, it, expect } from "vitest"
import { act, render } from "@testing-library/react"
import { useTimelineScroll } from "./use-timeline-scroll"

type Options = Parameters<typeof useTimelineScroll>[0]
type HookApi = ReturnType<typeof useTimelineScroll>

function renderScrollHook(initialOptions: Options): {
  current: HookApi
  rerender: (options: Options) => void
} {
  const ref: { current: HookApi | undefined } = { current: undefined }
  function Probe({ options }: { options: Options }) {
    ref.current = useTimelineScroll(options)
    return null
  }
  const utils = render(<Probe options={initialOptions} />)
  return {
    get current(): HookApi {
      if (!ref.current) throw new Error("Probe did not capture the hook return value")
      return ref.current
    },
    rerender: (options: Options) => act(() => utils.rerender(<Probe options={options} />)),
  }
}

/** A div whose scroll metrics are mockable (jsdom has no layout). */
function makeScrollerDiv(metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  const el = document.createElement("div")
  let scrollTop = metrics.scrollTop ?? 0
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    },
  })
  return el
}

const opts = (overrides: Partial<Options> & Pick<Options, "itemCount" | "getFirstKey">): Options => ({
  resetKey: "stream_1",
  ...overrides,
})

describe("useTimelineScroll — shift (prepend) detection", () => {
  it("does not shift on the initial populated render", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    expect(harness.current.shift).toBe(false)
  })

  it("shifts when an older page is prepended while reading history", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    // Leave the live tail (reading history).
    act(() => harness.current.disableAutoScroll())
    // Older page lands: the first row's identity changes from e10 to e0.
    harness.rerender(opts({ itemCount: 60, getFirstKey: () => "e0" }))
    expect(harness.current.shift).toBe(true)
  })

  it("does not shift on appends at the bottom (first row unchanged)", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    act(() => harness.current.disableAutoScroll())
    // A live message appended at the end leaves the first row untouched.
    harness.rerender(opts({ itemCount: 51, getFirstKey: () => "e10" }))
    expect(harness.current.shift).toBe(false)
  })

  it("never shifts while following the live tail", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    // Still following (default). A sliding tail window can change the first row,
    // but shift must stay false — we scroll to the bottom anyway.
    harness.rerender(opts({ itemCount: 60, getFirstKey: () => "e0" }))
    expect(harness.current.shift).toBe(false)
  })

  it("resets the prepend baseline on stream switch", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    act(() => harness.current.disableAutoScroll())
    // New stream: first window must not be mis-detected as a prepend.
    harness.rerender(opts({ resetKey: "stream_2", itemCount: 60, getFirstKey: () => "e0" }))
    expect(harness.current.shift).toBe(false)
  })

  it("resetShiftBaseline clears detection so the next window isn't a prepend", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    act(() => harness.current.disableAutoScroll())
    act(() => harness.current.resetShiftBaseline())
    // exitJumpMode swaps the window wholesale; baseline was cleared so no shift.
    harness.rerender(opts({ itemCount: 30, getFirstKey: () => "e90" }))
    expect(harness.current.shift).toBe(false)
  })
})

describe("useTimelineScroll — scroll position", () => {
  it("scrollToBottom pins scrollTop to scrollHeight (footer-spacer-inclusive bottom)", () => {
    // Browser-clamped scrollTop=scrollHeight lands at the true bottom INCLUDING
    // the composer footer spacer below virtua's items, so the last message sits
    // above the composer (not behind it). Deliberately not virtua's
    // scrollToIndex, which aligns to the item and ignores the trailing spacer.
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 1000 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.scrollToBottom({ force: true }))
    expect(el.scrollTop).toBe(5000)
  })

  it("does not disarm follow while a programmatic snap is in flight (initial-convergence fix)", () => {
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 0 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.scrollToBottom({ force: true }))
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // Mid-convergence the content is still growing underneath, so a scroll event
    // reads "not at bottom" — but it's our own snap, so follow must stay armed
    // (otherwise the list strands ~2 screens up on load).
    el.scrollTop = 1000
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
  })

  it("does not disarm follow when content shrinks and clamps scrollTop down (composer collapse on send)", () => {
    // Sending a message clears the composer, so it shrinks back to one line:
    // scrollHeight drops and the browser clamps scrollTop down on its own. That
    // is NOT a user scroll-up — follow must stay armed so the freshly-sent
    // message still pins above the composer instead of hiding behind it.
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4200 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // Composer collapses: scrollHeight shrinks, scrollTop clamped down, leaving us
    // briefly off the bottom — but it's content shrink, not a user gesture.
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 4200 })
    el.scrollTop = 3200
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
  })

  it("disarms follow when scrollTop drops with no gesture stamp (desktop scrollbar drag)", () => {
    // The desktop bug: dragging the scrollbar scrolls without firing
    // wheel/touch/pointer on the scroller, so the gesture stamp stays 0. Follow
    // must still disarm from the scrollTop decrease itself — otherwise it stays
    // armed and the next composer resize snaps the user back to the bottom.
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    const el = makeScrollerDiv({ scrollHeight: 11122, clientHeight: 991, scrollTop: 10131 })
    harness.current.scrollerRef.current = el
    // Establish the baseline at the bottom (re-arms follow).
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // User drags the scrollbar up ~348px — no gesture event, just scrollTop.
    el.scrollTop = 9783
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(false)
  })

  it("disarms follow on a genuine user gesture even while a programmatic window is open", () => {
    // Opening the keyboard / a follow re-pin leaves a programmatic window open
    // during which our own snaps must not disarm follow. But a real scroll-away
    // in that window MUST still disarm — otherwise follow stays wrongly armed
    // and the next composer resize yanks the user back to the tail (the
    // "scrolled away but it snaps back on composer resize" report).
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 0 })
    harness.current.scrollerRef.current = el
    // Force a snap — this opens the programmatic window (PROGRAMMATIC_SCROLL_MS).
    act(() => harness.current.scrollToBottom({ force: true }))
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // The user scrolls away WHILE that window is still open.
    userInteractedAtRef.current = performance.now()
    el.scrollTop = 1000
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(false)
  })

  it("handleScroll shows Jump-to-latest when the user scrolls far from the bottom and hides it near it", () => {
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 1000 })
    harness.current.scrollerRef.current = el

    // 5000 - 1000 - 800 = 3200px from the bottom -> far, after a user gesture.
    userInteractedAtRef.current = performance.now()
    act(() => harness.current.handleScroll())
    expect(harness.current.isScrolledFarFromBottom).toBe(true)
    expect(harness.current.isFollowingTailRef.current).toBe(false)

    // Near the bottom -> hidden, and following re-arms (no gesture needed).
    el.scrollTop = 4200
    act(() => harness.current.handleScroll())
    expect(harness.current.isScrolledFarFromBottom).toBe(false)
    expect(harness.current.isFollowingTailRef.current).toBe(true)
  })

  it("keeps following when content grows under the tail with no user gesture (new messages push up)", () => {
    // A new message / link preview growing the content moves us off the bottom
    // with no gesture; follow must stay armed so the ResizeObserver re-pins,
    // instead of disarming and stranding the tail.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4200 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)

    // Content grows (scrollHeight jumps) with scrollTop unchanged and no gesture.
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 6000 })
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    expect(harness.current.isScrolledFarFromBottom).toBe(false)
  })

  it("stays following when only the composer footer spacer sits below the fold", () => {
    // The footer spacer (composer height) is dead space at the bottom; the last
    // message resting just above it is "at the bottom", so follow must NOT
    // disarm — otherwise the initial scroll strands ~a composer height short and
    // keyboard-follow (gated on follow) breaks.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4130 })
    el.style.setProperty("--composer-height", "70px")
    harness.current.scrollerRef.current = el
    // distanceFromBottom = 5000 - 4130 - 800 = 70 == the composer height.
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)

    // The user scrolling a real amount past the spacer DOES disarm.
    userInteractedAtRef.current = performance.now()
    el.scrollTop = 3500
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(false)
  })

  it("does not re-arm follow at the bottom while in jump mode", () => {
    const harness = renderScrollHook(
      opts({ itemCount: 50, getFirstKey: () => "e10", isJumpMode: true, skipInitialScroll: true })
    )
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4200 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(false)
  })
})
