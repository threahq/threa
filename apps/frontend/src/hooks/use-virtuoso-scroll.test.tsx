import { describe, it, expect, vi } from "vitest"
import { useLayoutEffect } from "react"
import { act, render } from "@testing-library/react"
import { useVirtuosoScroll } from "./use-virtuoso-scroll"
import type { VirtuosoHandle } from "react-virtuoso"

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

function makeScrollableDiv(initial: { clientHeight: number; scrollHeight?: number; scrollTop?: number }) {
  const el = document.createElement("div")
  let scrollTop = initial.scrollTop ?? 0
  let clientHeight = initial.clientHeight
  let scrollHeight = initial.scrollHeight ?? initial.clientHeight
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight })
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
    setScrollTop: (v: number) => {
      scrollTop = v
    },
  }
}

type HookApi = ReturnType<typeof useVirtuosoScroll>

function renderHookWithScroller(
  options: Parameters<typeof useVirtuosoScroll>[0],
  scrollerEl: HTMLDivElement,
  virtuosoHandle: VirtuosoHandle
): { current: HookApi } {
  const ref: { current: HookApi | undefined } = { current: undefined }
  function Probe() {
    const api = useVirtuosoScroll(options)
    api.virtuosoRef.current = virtuosoHandle
    ref.current = api
    // handleScrollerRef setState — must run in an effect, not during render.
    useLayoutEffect(() => {
      api.handleScrollerRef(scrollerEl)
    }, [api])
    return null
  }
  render(<Probe />)
  if (!ref.current) throw new Error("Probe did not capture the hook return value")
  return ref as { current: HookApi }
}

function renderDynamicHook(initial: { keys: string[]; resetKey: string; skipInitialScroll?: boolean }) {
  const ref: { current: HookApi | undefined } = { current: undefined }
  function Probe(props: { keys: string[]; resetKey: string; skipInitialScroll?: boolean }) {
    const api = useVirtuosoScroll({
      itemCount: props.keys.length,
      getItemKey: (index) => props.keys[index] ?? `missing-${index}`,
      resetKey: props.resetKey,
      skipInitialScroll: props.skipInitialScroll ?? false,
    })
    ref.current = api
    return null
  }
  const view = render(<Probe {...initial} />)
  if (!ref.current) throw new Error("Probe did not capture the hook return value")
  return {
    apiRef: ref as { current: HookApi },
    rerender: (next: { keys: string[]; resetKey: string; skipInitialScroll?: boolean }) => {
      view.rerender(<Probe {...next} />)
      if (!ref.current) throw new Error("Probe did not capture the hook return value")
    },
  }
}

describe("useVirtuosoScroll", () => {
  it("adjusts firstItemIndex by the actual leading insert count when prepend and append arrive together", () => {
    const api = renderDynamicHook({ keys: ["a", "b"], resetKey: "stream_1" })
    const initialFirstItemIndex = api.apiRef.current.firstItemIndex

    api.rerender({ keys: ["older_1", "older_2", "a", "b", "newer_1"], resetKey: "stream_1" })

    expect(api.apiRef.current.firstItemIndex).toBe(initialFirstItemIndex - 2)
  })

  it("adjusts firstItemIndex upward when leading items are removed", () => {
    const api = renderDynamicHook({ keys: ["a", "b", "c", "d"], resetKey: "stream_1" })
    const initialFirstItemIndex = api.apiRef.current.firstItemIndex

    api.rerender({ keys: ["c", "d"], resetKey: "stream_1" })

    expect(api.apiRef.current.firstItemIndex).toBe(initialFirstItemIndex + 2)
  })

  it("resets firstItemIndex synchronously when the stream key changes", () => {
    const api = renderDynamicHook({ keys: ["a", "b"], resetKey: "stream_1" })
    const initialFirstItemIndex = api.apiRef.current.firstItemIndex
    api.rerender({ keys: ["older", "a", "b"], resetKey: "stream_1" })
    expect(api.apiRef.current.firstItemIndex).toBe(initialFirstItemIndex - 1)

    api.rerender({ keys: ["x", "y"], resetKey: "stream_2" })

    expect(api.apiRef.current.firstItemIndex).toBe(initialFirstItemIndex)
  })

  it("does not reset firstItemIndex when skipInitialScroll changes within the same stream", () => {
    const api = renderDynamicHook({ keys: ["a", "b"], resetKey: "stream_1" })
    const initialFirstItemIndex = api.apiRef.current.firstItemIndex
    api.rerender({ keys: ["older", "a", "b"], resetKey: "stream_1" })
    expect(api.apiRef.current.firstItemIndex).toBe(initialFirstItemIndex - 1)

    api.rerender({ keys: ["older", "a", "b"], resetKey: "stream_1", skipInitialScroll: true })

    expect(api.apiRef.current.firstItemIndex).toBe(initialFirstItemIndex - 1)
    expect(api.apiRef.current.shouldFollowOutput).toBe(false)
  })

  it("does NOT keep snapping to LAST on every measurement fire during a deep-link jump", async () => {
    // Regression: deep-link to an old message. skipInitialScroll=true keeps
    // the user away from the bottom on initial render, but Virtuoso emits a
    // burst of delta=0 ResizeObserver fires as it measures items during the
    // scrollToMessage retry loop. The bug had the safety-net re-arm
    // scrollToIndex({ index: "LAST" }) on every fire (regardless of delta),
    // which fought the centering loop and dropped the user on the latest
    // message instead of the linked one.
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ clientHeight: 800 })
      const scrollToIndex = vi.fn()
      const virtuosoHandle = { scrollToIndex } as unknown as VirtuosoHandle

      const apiRef = renderHookWithScroller(
        { itemCount: 50, getItemKey: (i) => String(i), resetKey: "stream_1", skipInitialScroll: true },
        scrollable.el,
        virtuosoHandle
      )

      // Consume the initial observe fire (browsers auto-fire ResizeObserver
      // once on observe()). With skipInitialScroll=true → isAtBottomRef starts
      // false, so this hits the not-at-bottom branch and does nothing.
      act(() => trigger())
      await new Promise((r) => setTimeout(r, 150))
      expect(scrollToIndex).not.toHaveBeenCalled()

      // Simulate the bootstrap→jumpState transition: Virtuoso reports atBottom
      // briefly (e.g. the new shorter jump window clamps scrollTop to the new
      // bottom), so isAtBottomRef flips to true.
      act(() => apiRef.current.handleAtBottomChange(true))

      // Now several delta=0 fires arrive as Virtuoso measures items in the
      // around-target window. None of them should arm the LAST snap.
      for (let i = 0; i < 5; i++) act(() => trigger())
      await new Promise((r) => setTimeout(r, 150))

      expect(scrollToIndex).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it("still snaps to LAST on the initial observe (cold-boot safety net)", async () => {
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ clientHeight: 800 })
      const scrollToIndex = vi.fn()
      const virtuosoHandle = { scrollToIndex } as unknown as VirtuosoHandle

      renderHookWithScroller(
        { itemCount: 50, getItemKey: (i) => String(i), resetKey: "stream_1", skipInitialScroll: false },
        scrollable.el,
        virtuosoHandle
      )

      // skipInitialScroll=false → isAtBottomRef starts true. The initial
      // observe fire (delta=0) must still arm the safety-net snap so the
      // timeline lands at the bottom even when the scroller mounts inside a
      // coordinated-loading gate that doesn't produce a resize delta.
      act(() => trigger())
      await new Promise((r) => setTimeout(r, 150))

      expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })
    } finally {
      restore()
    }
  })

  it("uses actual scroll distance for the jump button instead of the overscanned rendered range", () => {
    const { restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ clientHeight: 800, scrollHeight: 4000, scrollTop: 0 })
      const virtuosoHandle = { scrollToIndex: vi.fn() } as unknown as VirtuosoHandle

      const apiRef = renderHookWithScroller(
        { itemCount: 100, getItemKey: (i) => String(i), resetKey: "stream_1", skipInitialScroll: false },
        scrollable.el,
        virtuosoHandle
      )

      act(() => apiRef.current.handleAtBottomChange(false))
      act(() => apiRef.current.handleRangeChanged({ startIndex: 1_000_000, endIndex: 1_000_099 }))

      expect(apiRef.current.isScrolledFarFromBottom).toBe(true)
    } finally {
      restore()
    }
  })

  it("does not run a delayed LAST snap after the user scrolls away from bottom", async () => {
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ clientHeight: 800 })
      const scrollToIndex = vi.fn()
      const virtuosoHandle = { scrollToIndex } as unknown as VirtuosoHandle

      const apiRef = renderHookWithScroller(
        { itemCount: 50, getItemKey: (i) => String(i), resetKey: "stream_1", skipInitialScroll: false },
        scrollable.el,
        virtuosoHandle
      )

      act(() => trigger())
      act(() => apiRef.current.handleAtBottomChange(false))
      await new Promise((r) => setTimeout(r, 150))

      expect(scrollToIndex).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it("snaps to LAST when the container actually shrinks while at bottom (keyboard open)", async () => {
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ clientHeight: 800 })
      const scrollToIndex = vi.fn()
      const virtuosoHandle = { scrollToIndex } as unknown as VirtuosoHandle

      const apiRef = renderHookWithScroller(
        { itemCount: 50, getItemKey: (i) => String(i), resetKey: "stream_1", skipInitialScroll: false },
        scrollable.el,
        virtuosoHandle
      )

      // Consume the initial-fire safety net so we can isolate the keyboard-
      // resize path.
      act(() => trigger())
      await new Promise((r) => setTimeout(r, 150))
      scrollToIndex.mockClear()

      // User scrolls back to the bottom, then keyboard opens.
      act(() => apiRef.current.handleAtBottomChange(true))
      scrollable.setClientHeight(500)
      act(() => trigger())
      await new Promise((r) => setTimeout(r, 150))

      expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })
    } finally {
      restore()
    }
  })

  it("shifts scrollTop by the delta when scrolled away from the bottom (keyboard open)", () => {
    const { trigger, restore } = installManualResizeObserver()
    try {
      const scrollable = makeScrollableDiv({ clientHeight: 800, scrollTop: 1000 })
      const scrollToIndex = vi.fn()
      const virtuosoHandle = { scrollToIndex } as unknown as VirtuosoHandle

      const apiRef = renderHookWithScroller(
        { itemCount: 50, getItemKey: (i) => String(i), resetKey: "stream_1", skipInitialScroll: false },
        scrollable.el,
        virtuosoHandle
      )

      // Move user off the bottom so the not-at-bottom branch runs.
      act(() => apiRef.current.handleAtBottomChange(false))

      // Keyboard opens: container shrinks 800→500. scrollTop should shift by
      // the 300px delta so the previously-visible bottom row stays anchored.
      scrollable.setClientHeight(500)
      act(() => trigger())

      expect(scrollable.scrollTop).toBe(1300)
    } finally {
      restore()
    }
  })
})
