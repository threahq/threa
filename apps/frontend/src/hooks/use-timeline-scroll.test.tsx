import { describe, it, expect, vi } from "vitest"
import { StrictMode, type ReactNode } from "react"
import type { VirtualizerHandle } from "virtua"
import { act, render } from "@testing-library/react"
import { useTimelineScroll } from "./use-timeline-scroll"

type Options = Parameters<typeof useTimelineScroll>[0]
type HookApi = ReturnType<typeof useTimelineScroll>

function renderScrollHookWith(
  initialOptions: Options,
  wrap: (node: ReactNode) => ReactNode = (node) => node
): { current: HookApi; rerender: (options: Options) => void } {
  const ref: { current: HookApi | undefined } = { current: undefined }
  function Probe({ options }: { options: Options }) {
    ref.current = useTimelineScroll(options)
    return null
  }
  const utils = render(wrap(<Probe options={initialOptions} />))
  return {
    get current(): HookApi {
      if (!ref.current) throw new Error("Probe did not capture the hook return value")
      return ref.current
    },
    rerender: (options: Options) => act(() => utils.rerender(wrap(<Probe options={options} />))),
  }
}

const renderScrollHook = (initialOptions: Options) => renderScrollHookWith(initialOptions)

/**
 * Mounts the hook under StrictMode so every render is double-invoked — the
 * condition that exposed the `shift` regression where the prepend baseline was
 * tracked with a during-render ref write (the second pass read the first pass's
 * value and collapsed shift to false).
 */
const renderScrollHookStrict = (initialOptions: Options) =>
  renderScrollHookWith(initialOptions, (node) => <StrictMode>{node}</StrictMode>)

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
  // jsdom has no Element.scrollTo — the smooth dead-band dock path uses it.
  Object.defineProperty(el, "scrollTo", {
    configurable: true,
    value: (options?: ScrollToOptions | number) => {
      if (typeof options === "object" && options?.top !== undefined) el.scrollTop = options.top
      else if (typeof options === "number") el.scrollTop = options
    },
  })
  return el
}

const opts = (overrides: Partial<Options> & Pick<Options, "itemCount" | "getFirstKey">): Options => ({
  resetKey: "stream_1",
  getLastKey: () => null,
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

  it("still shifts on a prepend under StrictMode double-render", () => {
    // Regression guard: tracking the prepend baseline with a during-render ref
    // write made the StrictMode second pass see firstKey === prevFirstKey, so
    // the committed render carried shift=false and virtua skipped the scroll
    // compensation — the viewport jumped on every older-page prepend. The
    // baseline now updates in a layout effect (once per commit), so both passes
    // compare against the same prior-commit value.
    const harness = renderScrollHookStrict(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    act(() => harness.current.disableAutoScroll())
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

describe("useTimelineScroll — tail replace", () => {
  it("requests the last index before paint when the tail row changes under a following reader", () => {
    const scrollToIndex = vi.fn()
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.current.scrollerRef.current = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800 })
    harness.current.listRef.current = { scrollToIndex } as unknown as VirtualizerHandle
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10", getLastKey: () => "e59" }))
    scrollToIndex.mockClear()

    // A single live append at the tail is not a replace.
    harness.rerender(opts({ itemCount: 51, getFirstKey: () => "e10", getLastKey: () => "e60" }))
    expect(scrollToIndex).not.toHaveBeenCalled()

    // A sweep lands a gap: same count, different newest row.
    harness.rerender(opts({ itemCount: 51, getFirstKey: () => "e10", getLastKey: () => "e70" }))
    expect(scrollToIndex).toHaveBeenCalledWith(50, expect.objectContaining({ align: "end" }))
  })

  it("does not re-request the tail for a reader who scrolled away", () => {
    const scrollToIndex = vi.fn()
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    harness.current.scrollerRef.current = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800 })
    harness.current.listRef.current = { scrollToIndex } as unknown as VirtualizerHandle
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10", getLastKey: () => "e59" }))
    act(() => harness.current.disableAutoScroll())
    scrollToIndex.mockClear()

    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10", getLastKey: () => "e70" }))
    expect(scrollToIndex).not.toHaveBeenCalled()
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

  it("a programmatic pin keeps follow armed — its own scroll event reads as no movement", () => {
    // The pin (initial convergence, re-pin) jumps scrollTop to the bottom and
    // syncs the scroll-up baseline in the same write, so the `scroll` event it
    // triggers reads top === prevTop and never disarms follow. This is what
    // replaces the old programmatic time-window: no window, no arbitration.
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 0 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.scrollToBottom({ force: true }))
    expect(el.scrollTop).toBe(5000)
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // The scroll event the pin triggered now fires (scrollTop already at 5000).
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

  it("does not disarm follow when viewport growth clamps scrollTop down right after a tap (keyboard close)", () => {
    // Dismissing the keyboard by tapping the timeline stamps a fresh gesture,
    // and the optimistic close grows the viewport in the same beat: a taller
    // scroller lowers the scrollTop maximum, so the browser clamps scrollTop
    // down — a drop that, combined with the fresh tap, read as a deliberate
    // scroll-up and disarmed follow (the close then parked the list a
    // keyboard-height above the tail). The clamp lands exactly AT the new
    // bottom, which a genuine scroll-up never does — follow must stay armed.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5220, clientHeight: 388, scrollTop: 4832 })
    harness.current.scrollerRef.current = el
    // Pinned at the keyboard-open bottom.
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // The dismissing tap lands on the scroller…
    userInteractedAtRef.current = performance.now()
    // …and the viewport grows back: clientHeight 388 → 677, browser clamps
    // scrollTop to the new maximum (5220 - 677 = 4543).
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 677 })
    el.scrollTop = 4543
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

  it("keeps following when content reflow lowers scrollTop AND grows scrollHeight (cold-load tail landing)", () => {
    // The cold-load "settles 2 pages up" bug: as the catch-up tail lands, virtua
    // re-anchors and LOWERS scrollTop while scrollHeight GROWS. A scrollTop drop
    // alone read as a scrollbar scroll-up and disarmed follow, so the
    // ResizeObserver stopped re-pinning and the view stranded above the tail.
    // A drop that coincides with a height change is content reflow, not the
    // user — follow must stay armed so the tail re-pins to the true bottom.
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
    const el = makeScrollerDiv({ scrollHeight: 4961, clientHeight: 852, scrollTop: 4109 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // Catch-up content lands: scrollHeight 4961 → 6420 AND virtua drops scrollTop
    // 4109 → 3040, with no user gesture.
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 6420 })
    el.scrollTop = 3040
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
  })

  it("disarms follow when the user scrolls away right after a programmatic pin", () => {
    // A real scroll-away immediately after our own re-pin MUST still disarm —
    // otherwise follow stays wrongly armed and the next composer resize yanks the
    // user back to the tail (the "scrolled away but it snaps back" report). The
    // scrollTop drop from the pinned bottom is itself the signal; the gesture
    // stamp is a redundant confirmation here.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 0 })
    harness.current.scrollerRef.current = el
    act(() => harness.current.scrollToBottom({ force: true }))
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // The user scrolls up from the pinned bottom (scrollHeight unchanged).
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

  it("detaches on a light user scroll-up even within the at-bottom band (no snap-back)", () => {
    // A small wheel/trackpad nudge inside the at-bottom band must disarm follow —
    // otherwise the re-pin snaps the user straight back to the tail and they
    // can't scroll up a little to read. Gesture-gated so keyboard-driven scroll
    // changes (no scroller gesture) never count as a user scroll-up.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4170 })
    el.style.setProperty("--composer-height", "70px")
    harness.current.scrollerRef.current = el
    // distance = 5000 - 4170 - 800 = 30, inside the 32 + 70 band → following.
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // A light scroll up to distance = 60 — still inside the band — but with a
    // real gesture. It must detach instead of being re-armed and snapped back.
    userInteractedAtRef.current = performance.now()
    el.scrollTop = 4140
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(false)
  })

  it("disarms follow on an upward touch drag inside the at-bottom band even while content heights are shifting", () => {
    // The mobile "won't let me correct it" bug: while typing, every keystroke
    // grows the composer footer spacer, so scroll frames are height-UNSTABLE
    // and the scrollTop-delta scroll-up detection (`scrolledUp`) never fires.
    // Inside the at-bottom band that meant the upward drag was read as "still
    // at the bottom" and follow re-armed — the next re-pin won over the
    // user's finger. The gesture's own direction (touch finger delta) must
    // disarm follow regardless of height stability.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    let height = 5000
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4200 })
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height })
    act(() => harness.current.registerScroller(el))
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // Finger lands and drags DOWN (content down = viewport scrolls up) — the
    // touch listeners stamp the gesture and record its direction.
    el.dispatchEvent(Object.assign(new Event("touchstart"), { touches: [{ clientY: 300 }] }))
    el.dispatchEvent(Object.assign(new Event("touchmove"), { touches: [{ clientY: 380 }] }))
    // The composer grew in the same beat: scrollTop drops a little while
    // scrollHeight rises, landing still inside the 32px at-bottom band.
    height = 5010
    el.scrollTop = 4190
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(false)
  })

  it("does not detach from sub-threshold jitter inside the band without a gesture", () => {
    // The same small scrollTop move with NO gesture (reflow jitter, momentum
    // settle) must keep follow armed — only a deliberate gesture detaches.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4170 })
    el.style.setProperty("--composer-height", "70px")
    harness.current.scrollerRef.current = el
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    // Jitter up a few px, no gesture stamp → stays armed.
    el.scrollTop = 4140
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
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

describe("useTimelineScroll — observer attaches when the scroller mounts late", () => {
  it("wires the ResizeObserver and re-pins when the scroller is registered after mount", () => {
    // Regression: the scroller and content render behind a loading skeleton, so
    // on the hook's first commit both refs are null and the ResizeObserver effect
    // bails at its null-guard. Its deps must include the scroller's attachment so
    // it re-runs once `registerScroller` provides the element — otherwise the
    // observer (and the keyboard backstop) never wire up and the tail silently
    // stops following the keyboard / composer resize on every stream.
    const observers: MockResizeObserver[] = []
    class MockResizeObserver {
      targets: Element[] = []
      constructor(public cb: ResizeObserverCallback) {
        observers.push(this)
      }
      observe(t: Element) {
        this.targets.push(t)
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    try {
      const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
      // First commit: scroller not mounted yet (skeleton), so nothing observed.
      expect(observers).toHaveLength(0)

      // Scroller mounts: content first (it nests inside the scroller), then the
      // scroller via its ref callback — the real attach order.
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 1000 })
      act(() => harness.current.registerScroller(el))

      // The effect re-ran and wired the observer to the live scroller + content.
      expect(observers).toHaveLength(1)
      expect(observers[0].targets).toContain(el)
      expect(observers[0].targets).toContain(content)

      // Keyboard opens → scroller resizes → observer fires. Following (default at
      // mount), it pins the tail synchronously to the footer-inclusive bottom.
      expect(harness.current.isFollowingTailRef.current).toBe(true)
      expect(el.scrollTop).toBe(1000)
      act(() => observers[0].cb([], observers[0] as unknown as ResizeObserver))
      expect(el.scrollTop).toBe(5000)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("leaves a detached reader's scrollTop alone when the viewport resizes (keyboard open/close)", () => {
    // The scroller resizes at its BOTTOM edge (keyboard, composer chrome), so
    // an untouched scrollTop keeps what the user positioned at the top of the
    // viewport in place. The old delta-shift anchored the bottom edge instead,
    // pushing the message a replier had parked at the top out of the viewport
    // on every composer open.
    const observers: MockResizeObserver[] = []
    class MockResizeObserver {
      targets: Element[] = []
      constructor(public cb: ResizeObserverCallback) {
        observers.push(this)
      }
      observe(t: Element) {
        this.targets.push(t)
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    try {
      const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10" }))
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 2000 })
      act(() => harness.current.registerScroller(el))
      act(() => harness.current.disableAutoScroll())
      // Keyboard opens: the scroller shrinks 800 → 500 and the observer fires
      // with a viewport entry.
      Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 500 })
      act(() =>
        observers[0].cb([{ target: el } as unknown as ResizeObserverEntry], observers[0] as unknown as ResizeObserver)
      )
      expect(el.scrollTop).toBe(2000)
      // And closes again: still hands-off.
      Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 800 })
      act(() =>
        observers[0].cb([{ target: el } as unknown as ResizeObserverEntry], observers[0] as unknown as ResizeObserver)
      )
      expect(el.scrollTop).toBe(2000)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("useTimelineScroll — gesture stamp attaches when the scroller mounts late", () => {
  it("stamps userInteractedAtRef on a wheel gesture only once the scroller is registered", () => {
    // Regression: the genuine-input stamp must attach once the scroller mounts
    // (it renders behind the loading skeleton, so it's null on first commit).
    // When this lived in an effect keyed on streamId reading scrollerRef.current,
    // it attached to null on cold loads and never re-ran — the stamp stayed dead,
    // so userGestured was always false and a deliberate scroll-up inside the band
    // could never disarm follow, snapping the user back to the tail on any reflow.
    const userInteractedAtRef = { current: 0 }
    const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 1000 })

    // Not registered yet: no listener, so a stray wheel can't stamp.
    el.dispatchEvent(new Event("wheel"))
    expect(userInteractedAtRef.current).toBe(0)

    // Scroller mounts via its ref callback → the stamp effect (re-)runs and binds.
    act(() => harness.current.registerScroller(el))
    el.dispatchEvent(new Event("wheel"))
    expect(userInteractedAtRef.current).toBeGreaterThan(0)
  })
})

describe("useTimelineScroll — deferred re-check after a resize skipped for an active scroll", () => {
  it("catches up once the grace window elapses if a resize was skipped for a just-landed scroller gesture", () => {
    // Regression: a content resize (new message, session card, composer growth)
    // that lands within USER_SCROLL_GRACE_MS (300ms) of a genuine scroller
    // gesture is deliberately skipped, so it doesn't fight an active scroll.
    // But if that's the only resize this content change ever fires, skipping it
    // with no follow-up misses it forever — the tail never re-pins and the
    // last row stays stranded behind the composer. There must be a guaranteed
    // recheck once the grace window actually elapses.
    class MockResizeObserver {
      targets: Element[] = []
      constructor(public cb: ResizeObserverCallback) {}
      observe(t: Element) {
        this.targets.push(t)
      }
      unobserve() {}
      disconnect() {}
    }
    let observer: MockResizeObserver | undefined
    class CapturingResizeObserver extends MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        super(cb)
        observer = this
      }
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver)
    vi.useFakeTimers()
    try {
      const userInteractedAtRef = { current: 0 }
      const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 800 })
      act(() => harness.current.registerScroller(el))
      expect(harness.current.isFollowingTailRef.current).toBe(true)

      // A genuine scroller gesture just landed.
      userInteractedAtRef.current = performance.now()

      // Content grows moments later (still inside the grace window) — a new
      // message, a session card, or the composer footer spacer resizing.
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 5200 })
      act(() => observer!.cb([], observer as unknown as ResizeObserver))

      // Skipped: an active scroll is not fought, so no snap yet.
      expect(el.scrollTop).toBe(800)

      // Grace window elapses with no further resize or scroll.
      act(() => vi.advanceTimersByTime(300))

      // Still following → the deferred recheck catches it up to the new bottom.
      expect(el.scrollTop).toBe(5200)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("does not catch up if the user genuinely detached from the tail before the grace window elapsed", () => {
    class MockResizeObserver {
      targets: Element[] = []
      constructor(public cb: ResizeObserverCallback) {}
      observe(t: Element) {
        this.targets.push(t)
      }
      unobserve() {}
      disconnect() {}
    }
    let observer: MockResizeObserver | undefined
    class CapturingResizeObserver extends MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        super(cb)
        observer = this
      }
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver)
    vi.useFakeTimers()
    try {
      const userInteractedAtRef = { current: 0 }
      const harness = renderScrollHook(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef }))
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800, scrollTop: 800 })
      act(() => harness.current.registerScroller(el))

      userInteractedAtRef.current = performance.now()
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 5200 })
      act(() => observer!.cb([], observer as unknown as ResizeObserver))
      expect(el.scrollTop).toBe(800)

      // The user deliberately scrolls away from the tail before the grace
      // window elapses — the deferred recheck must respect that, not override it.
      harness.current.disableAutoScroll()

      act(() => vi.advanceTimersByTime(300))
      expect(el.scrollTop).toBe(800)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

describe("useTimelineScroll — dead-band dock (downward release short of the bottom)", () => {
  class MockResizeObserver {
    constructor(public cb: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  /** Mounts the hook with a registered scroller, cold-load settle already
   *  converged (immediate-rAF mock), parked at the pinned bottom. */
  function mountAtBottom(overrides: Partial<Options> = {}) {
    const userInteractedAtRef = { current: 0 }
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(performance.now())
      return 0
    })
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null, userInteractedAtRef, ...overrides }))
    const content = document.createElement("div")
    harness.current.contentRef.current = content
    const el = makeScrollerDiv({ scrollHeight: 5000, clientHeight: 800 })
    el.style.setProperty("--composer-height", "70px")
    act(() => harness.current.registerScroller(el))
    // First window lands: the initial pin + cold-load settle converge
    // synchronously under the immediate-rAF mock and reveal the content —
    // the dock must see a *settled* timeline, exactly like the real flow.
    harness.rerender(opts({ itemCount: 50, getFirstKey: () => "e10", userInteractedAtRef, ...overrides }))
    raf.mockRestore()
    expect(harness.current.isInitialSettling).toBe(false)
    // The mock scroller doesn't browser-clamp the pin's scrollTop=scrollHeight
    // write; park at the real maximum (distance 0) and re-baseline.
    el.scrollTop = 4200
    act(() => harness.current.handleScroll())
    expect(harness.current.isFollowingTailRef.current).toBe(true)
    return { harness, el, userInteractedAtRef }
  }

  /** A user gesture moving scrollTop, as the browser delivers it: stamp + scroll. */
  function gestureScrollTo(
    harness: { current: HookApi },
    el: HTMLDivElement,
    userInteractedAtRef: { current: number },
    top: number
  ) {
    userInteractedAtRef.current = performance.now()
    el.scrollTop = top
    act(() => harness.current.handleScroll())
    el.dispatchEvent(new Event("scroll"))
  }

  it("docks to the bottom when a downward gesture settles inside the composer dead band", () => {
    // The mobile overlap bug: the bottom --composer-height px of scroll range
    // sit behind the floating pill, so a touch drag back toward the bottom
    // that releases inside that band parks the tail clipped by the composer —
    // and nothing corrects it (follow was disarmed by the gesture, the
    // at-bottom re-arm band is narrower than the dead band, jump-to-latest
    // needs 600px). Once the scroll settles, the dock must finish the gesture:
    // ease to the true bottom and re-arm follow.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      // Scrolls up out of the band (reading history) — follow disarms.
      gestureScrollTo(harness, el, userInteractedAtRef, 3800)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
      // Drags back down, releasing 60px short of max — inside the 70+32 band.
      gestureScrollTo(harness, el, userInteractedAtRef, 4140)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
      // Scroll events go quiet — the settle window elapses.
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(5000)
      expect(harness.current.isFollowingTailRef.current).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("does not dock an upward touch drag whose scrollTop deltas are masked by reflow (stale 'down' direction)", () => {
    // The video'd mobile yank: an upward touch drag through height-unstable
    // frames (virtua measuring, composer growing) never recorded via the
    // scrollTop-delta path, so the direction ref kept a stale "down" from an
    // earlier gesture — and 200ms after the finger lifted, the dock "completed"
    // a downward gesture the user never made, force-scrolling to the bottom
    // and re-arming follow. Direction read off the touch events themselves
    // must keep the release parked.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      // An earlier downward wheel recorded "down".
      el.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: 120 }))
      // New touch gesture: finger drags the content down (viewport scrolls up)
      // while every frame is height-unstable.
      let height = 5000
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height })
      el.dispatchEvent(Object.assign(new Event("touchstart"), { touches: [{ clientY: 200 }] }))
      el.dispatchEvent(Object.assign(new Event("touchmove"), { touches: [{ clientY: 320 }] }))
      // Release INSIDE the dock band (5010 - 4140 - 800 = 70 ≤ 70 + 32), so
      // only the corrected direction — not the band check — prevents the dock.
      height = 5010
      gestureScrollTo(harness, el, userInteractedAtRef, 4140)
      el.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] }))
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(4140)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("does not let a finger-lift reversal flip a downward drag's direction (still docks)", () => {
    // The last touchmove before lift-off commonly reverses 2–3px as the finger
    // peels off the glass. Recording it verbatim flipped a long downward drag
    // to "up" at the last instant, so the dock the drag was heading into never
    // fired. Direction recording has hysteresis: sub-threshold moves don't flip.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      let height = 5000
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height })
      // Finger sweeps up the glass (viewport scrolls DOWN, toward the tail)…
      el.dispatchEvent(Object.assign(new Event("touchstart"), { touches: [{ clientY: 500 }] }))
      el.dispatchEvent(Object.assign(new Event("touchmove"), { touches: [{ clientY: 380 }] }))
      // …then reverses 3px on lift-off. Sub-threshold: direction stays "down".
      el.dispatchEvent(Object.assign(new Event("touchmove"), { touches: [{ clientY: 383 }] }))
      // Height-unstable release inside the band, so the scroll-based recording
      // cannot correct a flipped direction — only the hysteresis protects it.
      height = 5010
      gestureScrollTo(harness, el, userInteractedAtRef, 4140)
      el.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] }))
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(5010)
      expect(harness.current.isFollowingTailRef.current).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("caps the dock band when the composer dwarfs the viewport (mobile keyboard open)", () => {
    // On mobile the composer can be a third of the viewport, so treating the
    // full composer height as "undershot the bottom" docked deliberate
    // reading positions. The band is capped at a quarter of the viewport:
    // releases beyond it stay put, releases inside it still dock.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      // Keyboard-open mobile: composer 380px over an 800px scroller → the
      // uncapped band would be 380+32; the cap brings it to 200+32.
      el.style.setProperty("--composer-height", "380px")
      gestureScrollTo(harness, el, userInteractedAtRef, 3600)
      // Downward release 300px short of max: inside the uncapped band, outside
      // the capped one — a chosen position, stays.
      gestureScrollTo(harness, el, userInteractedAtRef, 3900)
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(3900)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
      // Downward release 100px short: inside the capped band → docks.
      gestureScrollTo(harness, el, userInteractedAtRef, 4100)
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(5000)
      expect(harness.current.isFollowingTailRef.current).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("leaves an upward nudge inside the dead band alone", () => {
    // Nudging up a little to read context while typing is a deliberate
    // position — docking it would scroll away exactly what the nudge revealed.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      gestureScrollTo(harness, el, userInteractedAtRef, 4140)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(4140)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("does not dock after programmatic positioning with no user gesture", () => {
    // Divider/deep-link scrolls position the view without any gesture; a
    // target that happens to land near the tail must stay where it was put.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el } = mountAtBottom()
      act(() => harness.current.disableAutoScroll())
      // Programmatic positioning into the dead band — no gesture stamp.
      el.scrollTop = 4140
      act(() => harness.current.handleScroll())
      el.dispatchEvent(new Event("scroll"))
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(4140)
      expect(harness.current.isFollowingTailRef.current).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("waits for the finger to lift before docking", () => {
    // A resting finger emits no scroll events, so the quiet window alone would
    // elapse mid-gesture and yank the content out from under the touch.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      gestureScrollTo(harness, el, userInteractedAtRef, 3800)
      el.dispatchEvent(new Event("touchstart"))
      gestureScrollTo(harness, el, userInteractedAtRef, 4140)
      // Finger still down: the settle window elapsing must not dock.
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(4140)
      // Finger lifts → the dock completes the gesture.
      el.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] }))
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(5000)
      expect(harness.current.isFollowingTailRef.current).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("waits for the mouse button to release before docking", () => {
    // Mouse mirror of the finger-lift case: a held button (text-selection drag,
    // scrollbar-adjacent press) must not dock mid-gesture. The release is
    // listened on window, not the scroller — a drag can end with the cursor
    // outside it.
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.useFakeTimers()
    try {
      const { harness, el, userInteractedAtRef } = mountAtBottom()
      gestureScrollTo(harness, el, userInteractedAtRef, 3800)
      el.dispatchEvent(new Event("mousedown"))
      gestureScrollTo(harness, el, userInteractedAtRef, 4140)
      // Button still held: the settle window elapsing must not dock.
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(4140)
      // Release (on window — cursor may have left the scroller) → dock.
      window.dispatchEvent(new Event("mouseup"))
      act(() => vi.advanceTimersByTime(200))
      expect(el.scrollTop).toBe(5000)
      expect(harness.current.isFollowingTailRef.current).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

describe("useTimelineScroll — cold-load settle across a stream switch", () => {
  it("does not prematurely reveal when superseding a settle still in flight from the stream navigated away from", () => {
    // Regression: settleToBottom's own supersede-cancel used to call the
    // PREVIOUS settle's cleanup unconditionally, which always reveals
    // (setIsInitialSettling(false)) — so navigating to a new stream before the
    // old one's cold-load settle converged stripped the new stream's mask
    // before it ran even one frame of its own convergence, exposing whatever
    // unsettled position virtua was still mid-measurement at (the last row
    // parked behind the composer until something else happened to re-pin it).
    const rafCallbacks: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    const runFrame = () => act(() => rafCallbacks.shift()?.(performance.now()))
    try {
      const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null, resetKey: "stream_a" }))
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      let height = 1000
      const el = makeScrollerDiv({ scrollHeight: 0, clientHeight: 800 })
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height })
      act(() => harness.current.registerScroller(el))

      // Stream A's first window lands — the cold-load settle starts, masked.
      harness.rerender(opts({ itemCount: 10, getFirstKey: () => "a1", resetKey: "stream_a" }))
      expect(harness.current.isInitialSettling).toBe(true)

      // One frame in: height is still moving (virtua still measuring) — not
      // converged, so the settle re-schedules itself for another frame.
      height = 1200
      runFrame()
      expect(harness.current.isInitialSettling).toBe(true)
      expect(rafCallbacks).toHaveLength(1)

      // Navigate away to stream B before stream A's settle ever converged.
      harness.rerender(opts({ itemCount: 5, getFirstKey: () => "b1", resetKey: "stream_b" }))

      // Stream B's own settle just started, superseding A's stale one — still
      // masked, since it hasn't run a single frame of its own convergence yet.
      expect(harness.current.isInitialSettling).toBe(true)
    } finally {
      raf.mockRestore()
      caf.mockRestore()
    }
  })

  it("holdSettleForRestore stops the settle without revealing; revealSettle then drops the mask", () => {
    // The anchor-restore handoff: the restore engages while the settle mask is
    // still up, cancels the pin-to-bottom loop (which would fight the anchor
    // scroll), keeps the mask, and reveals itself once positioned. A settle
    // that kept ticking after the handoff would reveal at the TAIL — the
    // tail-flash-then-jump bounce this exists to remove.
    const rafCallbacks: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    const runFrame = () => act(() => rafCallbacks.shift()?.(performance.now()))
    try {
      const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null, resetKey: "stream_a" }))
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      const el = makeScrollerDiv({ scrollHeight: 1000, clientHeight: 800 })
      act(() => harness.current.registerScroller(el))

      harness.rerender(opts({ itemCount: 10, getFirstKey: () => "a1", resetKey: "stream_a" }))
      expect(harness.current.isInitialSettling).toBe(true)

      act(() => harness.current.holdSettleForRestore())

      // Height is stable, so an un-cancelled settle would converge and reveal
      // within SETTLE_STABLE_FRAMES ticks. The handed-off loop must not.
      runFrame()
      runFrame()
      runFrame()
      runFrame()
      expect(harness.current.isInitialSettling).toBe(true)

      act(() => harness.current.revealSettle())
      expect(harness.current.isInitialSettling).toBe(false)
    } finally {
      raf.mockRestore()
      caf.mockRestore()
    }
  })

  it("a converged settle parks its reveal while the landing decision is pending; releaseDeferredReveal drops the mask", () => {
    // The read-state hydration race (INV-70): the settle converges off pure
    // DOM height in a few frames, but a marker landing may still be waiting
    // on async inputs. Revealing at convergence painted the tail and let the
    // divider jump happen in full view — so a pending landing parks the
    // reveal, and the landing decision releases it.
    const rafCallbacks: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    const runFrame = () => act(() => rafCallbacks.shift()?.(performance.now()))
    try {
      const landingPendingRef = { current: true }
      const harness = renderScrollHook(
        opts({ itemCount: 0, getFirstKey: () => null, resetKey: "stream_a", landingPendingRef })
      )
      const content = document.createElement("div")
      harness.current.contentRef.current = content
      const el = makeScrollerDiv({ scrollHeight: 1000, clientHeight: 800 })
      act(() => harness.current.registerScroller(el))

      harness.rerender(opts({ itemCount: 10, getFirstKey: () => "a1", resetKey: "stream_a", landingPendingRef }))
      expect(harness.current.isInitialSettling).toBe(true)

      // Stable height → the settle converges within SETTLE_STABLE_FRAMES
      // ticks — but the landing is pending, so the mask must stay up.
      runFrame()
      runFrame()
      runFrame()
      runFrame()
      expect(harness.current.isInitialSettling).toBe(true)

      // The landing decides "tail": release the parked reveal.
      landingPendingRef.current = false
      act(() => harness.current.releaseDeferredReveal())
      expect(harness.current.isInitialSettling).toBe(false)
    } finally {
      raf.mockRestore()
      caf.mockRestore()
    }
  })
})

describe("useTimelineScroll — cold-load settle mask", () => {
  it("masks the settle by default and re-masks on a stream switch", () => {
    const harness = renderScrollHook(opts({ itemCount: 0, getFirstKey: () => null }))
    expect(harness.current.isInitialSettling).toBe(true)
    act(() => harness.current.revealSettle())
    expect(harness.current.isInitialSettling).toBe(false)
    harness.rerender(opts({ resetKey: "stream_2", itemCount: 3, getFirstKey: () => "e0" }))
    expect(harness.current.isInitialSettling).toBe(true)
  })
})
