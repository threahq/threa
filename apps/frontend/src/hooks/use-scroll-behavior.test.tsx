import { describe, it, expect, afterEach } from "vitest"
import { act, render, renderHook } from "@testing-library/react"
import { useScrollBehavior } from "./use-scroll-behavior"

type ResizeCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void

function installManualResizeObserver(): { trigger: () => void; restore: () => void } {
  let lastCallback: ResizeCallback | null = null
  const original = global.ResizeObserver
  class ManualResizeObserver {
    constructor(cb: ResizeCallback) {
      lastCallback = cb
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ManualResizeObserver as unknown as typeof ResizeObserver
  return {
    trigger: () => lastCallback?.([], {} as ResizeObserver),
    restore: () => {
      global.ResizeObserver = original
    },
  }
}

function makeScrollableDiv(initial: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  const el = document.createElement("div")
  let scrollTop = initial.scrollTop ?? 0
  let clientHeight = initial.clientHeight
  let scrollHeight = initial.scrollHeight
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  })
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    },
  })
  return {
    el,
    get scrollTop() {
      return scrollTop
    },
    setClientHeight: (h: number) => {
      clientHeight = h
    },
    setScrollHeight: (h: number) => {
      scrollHeight = h
    },
  }
}

type HookApi = ReturnType<typeof useScrollBehavior>

/**
 * Mounts useScrollBehavior with `element` pre-attached to its scroll container
 * ref. Direct-assigning the ref in the render body — rather than after
 * renderHook returns — guarantees the hook's `useEffect` sees a populated ref
 * on mount, which is what happens in production when JSX attaches the ref to a
 * DOM element. Without this, the resize observer effect short-circuits on
 * `if (!el) return` and the test exercises the wrong branch.
 */
function renderHookWithElement(
  options: Parameters<typeof useScrollBehavior>[0],
  element: HTMLDivElement
): { current: HookApi } {
  // Box the latest hook return through a stable wrapper so callers always see
  // the post-update value after React re-renders — the local snapshot stays
  // stale and reads like `isScrolledFarFromBottom` would never flip.
  const ref: { current: HookApi | undefined } = { current: undefined }
  function Probe() {
    const api = useScrollBehavior(options)
    api.scrollContainerRef.current = element
    ref.current = api
    return null
  }
  render(<Probe />)
  if (!ref.current) throw new Error("Probe did not capture the hook return value")
  return ref as { current: HookApi }
}

describe("useScrollBehavior", () => {
  afterEach(() => {
    // installManualResizeObserver returns a restore() function — tests that
    // need cleanup call it directly so this hook stays defensive only.
  })

  it("clears the jump-to-latest state when force-scrolling to the bottom", () => {
    const { result } = renderHook(() =>
      useScrollBehavior({
        isLoading: false,
        itemCount: 100,
      })
    )

    const element = document.createElement("div")
    let scrollTop = 0

    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    })
    Object.defineProperty(element, "clientHeight", {
      configurable: true,
      get: () => 100,
    })
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })

    result.current.scrollContainerRef.current = element

    act(() => {
      scrollTop = 0
      result.current.handleScroll()
    })

    expect(result.current.isScrolledFarFromBottom).toBe(true)

    act(() => {
      result.current.scrollToBottom({ force: true })
    })

    expect(scrollTop).toBe(1000)
    expect(result.current.isScrolledFarFromBottom).toBe(false)
  })

  it("shifts scrollTop by the height delta when the container shrinks and user is not at bottom", async () => {
    // Captures the keyboard-open scenario: container goes 800→500, user was
    // scrolled away from the bottom. Without compensation the previously-
    // visible bottom row would drift up by the 300px the container lost;
    // the resize handler adds the delta to scrollTop so the bottom anchor
    // tracks the same content.
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ scrollHeight: 5000, clientHeight: 800 })
      const apiRef = renderHookWithElement({ isLoading: false, itemCount: 100 }, scrollable.el)

      // Initial mount triggers the auto-scroll useLayoutEffect, which pins
      // scrollTop to scrollHeight (5000) and starts a 150ms grace period
      // during which handleScroll won't clear shouldAutoScroll. Wait it out,
      // then place the user mid-list and let handleScroll flip the flag.
      await new Promise((r) => setTimeout(r, 200))
      scrollable.el.scrollTop = 1000
      act(() => apiRef.current.handleScroll())
      expect(apiRef.current.isScrolledFarFromBottom).toBe(true)

      // Container shrinks (keyboard opened): clientHeight 800 → 500.
      scrollable.setClientHeight(500)
      act(() => trigger())

      expect(scrollable.scrollTop).toBe(1300)
    } finally {
      restore()
    }
  })

  it("skipInitialScroll leaves the list at the top on first content", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 5000, clientHeight: 800 })
    const options = { isLoading: false, itemCount: 0, skipInitialScroll: true }
    const ref: { current: HookApi | undefined } = { current: undefined }
    function Probe({ itemCount }: { itemCount: number }) {
      const api = useScrollBehavior({ ...options, itemCount })
      api.scrollContainerRef.current = scrollable.el
      ref.current = api
      return null
    }
    const { rerender } = render(<Probe itemCount={0} />)
    rerender(<Probe itemCount={5} />)

    expect(scrollable.scrollTop).toBe(0)
  })

  it("skipInitialScroll does not disable a later forced scrollToBottom", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 5000, clientHeight: 800 })
    const apiRef = renderHookWithElement({ isLoading: false, itemCount: 5, skipInitialScroll: true }, scrollable.el)
    expect(scrollable.scrollTop).toBe(0)

    act(() => apiRef.current.scrollToBottom({ force: true }))
    expect(scrollable.scrollTop).toBe(5000)
  })

  it("scrolls to the bottom on first content when the option is omitted (thread path)", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 5000, clientHeight: 800 })
    const ref: { current: HookApi | undefined } = { current: undefined }
    function Probe({ itemCount }: { itemCount: number }) {
      const api = useScrollBehavior({ isLoading: false, itemCount })
      api.scrollContainerRef.current = scrollable.el
      ref.current = api
      return null
    }
    const { rerender } = render(<Probe itemCount={0} />)
    rerender(<Probe itemCount={5} />)

    expect(scrollable.scrollTop).toBe(5000)
  })

  it("re-anchors to the bottom when resetKey changes with an unchanged itemCount", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 4000, clientHeight: 800 })
    const ref: { current: HookApi | undefined } = { current: undefined }
    function Probe({ resetKey, itemCount }: { resetKey: string; itemCount: number }) {
      const api = useScrollBehavior({ isLoading: false, itemCount, resetKey })
      api.scrollContainerRef.current = scrollable.el
      ref.current = api
      return null
    }
    const { rerender } = render(<Probe resetKey="conv_a" itemCount={0} />)
    rerender(<Probe resetKey="conv_a" itemCount={12} />)
    expect(scrollable.scrollTop).toBe(4000)

    // Conversation B is taller but happens to have the same row count.
    scrollable.setScrollHeight(9000)
    rerender(<Probe resetKey="conv_b" itemCount={12} />)

    expect(scrollable.scrollTop).toBe(9000)
  })

  it("flipping skipInitialScroll true→false does not reset scroll state", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 5000, clientHeight: 800 })
    const ref: { current: HookApi | undefined } = { current: undefined }
    function Probe({ skipInitialScroll, itemCount }: { skipInitialScroll: boolean; itemCount: number }) {
      const api = useScrollBehavior({ isLoading: false, itemCount, resetKey: "conv_a", skipInitialScroll })
      api.scrollContainerRef.current = scrollable.el
      ref.current = api
      return null
    }
    const { rerender } = render(<Probe skipInitialScroll itemCount={5} />)
    scrollable.el.scrollTop = 1000

    // `?m=` is stripped from the URL 3s after a deep link lands; the panel is
    // still parked on the deep-linked row and must stay there.
    rerender(<Probe skipInitialScroll={false} itemCount={5} />)
    rerender(<Probe skipInitialScroll={false} itemCount={6} />)

    expect(scrollable.scrollTop).toBe(1000)
  })

  it("anchors to the bottom on resize when shouldAutoScroll is true", () => {
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ scrollHeight: 5000, clientHeight: 800 })
      renderHookWithElement({ isLoading: false, itemCount: 100 }, scrollable.el)

      // Initial mount auto-scrolls to bottom (scrollTop=scrollHeight=5000) and
      // leaves shouldAutoScroll=true. Keyboard opens (clientHeight 800→500);
      // the resize handler must pin scrollTop to scrollHeight rather than
      // shift by the delta, so the latest message stays anchored above the
      // composer.
      scrollable.setClientHeight(500)
      act(() => trigger())
      expect(scrollable.scrollTop).toBe(5000)
    } finally {
      restore()
    }
  })

  describe("rows arriving while detached", () => {
    type Rows = { itemCount: number; firstItemKey: string; isFetchingOlder?: boolean }

    // jsdom has no CSS.supports, which the hook reads as "no scroll anchoring".
    afterEach(() => {
      delete (CSS as Partial<typeof CSS>).supports
    })

    // A thread landed on its unread marker: 50 rows, reader 1056px above the
    // tail. The older page's rows land a render after the fetch flag clears.
    function landDetached() {
      const scrollable = makeScrollableDiv({ scrollHeight: 4362, clientHeight: 752 })
      const ref: { current: HookApi | undefined } = { current: undefined }
      function Probe({ itemCount, firstItemKey, isFetchingOlder = false }: Rows) {
        const api = useScrollBehavior({
          isLoading: false,
          itemCount,
          firstItemKey,
          isFetchingOlder,
          bottomThreshold: 4,
        })
        api.scrollContainerRef.current = scrollable.el
        ref.current = api
        return null
      }
      const { rerender } = render(<Probe itemCount={50} firstItemKey="event_50" />)
      act(() => {
        ref.current?.disableAutoScroll()
        scrollable.el.scrollTop = 2554
        ref.current?.handleScroll()
      })
      rerender(<Probe itemCount={50} firstItemKey="event_50" isFetchingOlder />)
      rerender(<Probe itemCount={50} firstItemKey="event_50" />)
      return { scrollable, rerender: (rows: Rows) => rerender(<Probe {...rows} />) }
    }

    it("keeps the reader's row and stays detached when the browser anchored the prepend", () => {
      CSS.supports = () => true
      const { scrollable, rerender } = landDetached()

      // Chromium's scroll anchoring has shifted scrollTop by the prepended
      // 1931px by the time the layout effect reads it.
      scrollable.setScrollHeight(6293)
      scrollable.el.scrollTop = 4485
      rerender({ itemCount: 89, firstItemKey: "event_11" })
      const afterPrepend = scrollable.scrollTop

      scrollable.setScrollHeight(6400)
      rerender({ itemCount: 90, firstItemKey: "event_11" })

      expect({ afterPrepend, afterAppend: scrollable.scrollTop }).toEqual({ afterPrepend: 4485, afterAppend: 4485 })
    })

    it.each([
      ["on an engine with anchoring that did not anchor", true],
      ["on an engine without anchoring", false],
    ])("restores the reader's row %s", (_label, anchoring) => {
      CSS.supports = () => anchoring
      const { scrollable, rerender } = landDetached()

      scrollable.setScrollHeight(6293)
      rerender({ itemCount: 89, firstItemKey: "event_11" })
      const afterPrepend = scrollable.scrollTop

      scrollable.setScrollHeight(6400)
      rerender({ itemCount: 90, firstItemKey: "event_11" })

      expect({ afterPrepend, afterAppend: scrollable.scrollTop }).toEqual({ afterPrepend: 4485, afterAppend: 4485 })
    })

    it("adds the prepended height to a scroll still in flight on an engine without anchoring", () => {
      const { scrollable, rerender } = landDetached()

      // Momentum moved the reader 40px up; its scroll event has not fired yet.
      scrollable.el.scrollTop = 2514
      scrollable.setScrollHeight(6293)
      rerender({ itemCount: 89, firstItemKey: "event_11" })

      expect(scrollable.scrollTop).toBe(4445)
    })
  })

  it("follows rows appended at the bottom while the reader is at the bottom", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 1000, clientHeight: 800 })
    const ref: { current: HookApi | undefined } = { current: undefined }
    function Probe({ itemCount }: { itemCount: number }) {
      const api = useScrollBehavior({ isLoading: false, itemCount, firstItemKey: "event_1", bottomThreshold: 4 })
      api.scrollContainerRef.current = scrollable.el
      ref.current = api
      return null
    }
    const { rerender } = render(<Probe itemCount={10} />)

    scrollable.setScrollHeight(1200)
    rerender(<Probe itemCount={11} />)
    const following = scrollable.scrollTop

    // A landing whose target is the last row detaches without leaving the
    // bottom; the next append re-arms follow.
    act(() => ref.current?.disableAutoScroll())
    scrollable.setScrollHeight(1400)
    rerender(<Probe itemCount={12} />)

    expect({ following, afterLanding: scrollable.scrollTop }).toEqual({ following: 1200, afterLanding: 1400 })
  })

  it("stays detached when a landing moved the reader off the bottom before the next rows", () => {
    const scrollable = makeScrollableDiv({ scrollHeight: 1000, clientHeight: 800 })
    const ref: { current: HookApi | undefined } = { current: undefined }
    function Probe({ itemCount }: { itemCount: number }) {
      const api = useScrollBehavior({ isLoading: false, itemCount, firstItemKey: "event_1", bottomThreshold: 4 })
      api.scrollContainerRef.current = scrollable.el
      ref.current = api
      return null
    }
    const { rerender } = render(<Probe itemCount={10} />)

    // The landing writes scrollTop; the rows arrive before its scroll event.
    act(() => ref.current?.disableAutoScroll())
    scrollable.el.scrollTop = 300
    scrollable.setScrollHeight(1400)
    rerender(<Probe itemCount={12} />)

    expect(scrollable.scrollTop).toBe(300)
  })
})
