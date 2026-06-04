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

function makeScrollableDiv(initial: { clientHeight: number; scrollTop?: number }) {
  const el = document.createElement("div")
  let scrollTop = initial.scrollTop ?? 0
  let clientHeight = initial.clientHeight
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight })
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
  }
}

type HookApi = ReturnType<typeof useVirtuosoScroll>

type ScrollOptions = Parameters<typeof useVirtuosoScroll>[0]

function renderScrollHook(initialOptions: ScrollOptions): {
  current: HookApi
  rerender: (options: ScrollOptions) => void
} {
  const ref: { current: HookApi | undefined } = { current: undefined }
  function Probe({ options }: { options: ScrollOptions }) {
    ref.current = useVirtuosoScroll(options)
    return null
  }
  const utils = render(<Probe options={initialOptions} />)
  return {
    get current(): HookApi {
      if (!ref.current) throw new Error("Probe did not capture the hook return value")
      return ref.current
    },
    rerender: (options: ScrollOptions) => act(() => utils.rerender(<Probe options={options} />)),
  }
}

function makeKeys(prefixes: number[]): string[] {
  return prefixes.map((n) => `e${n}`)
}

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

describe("useVirtuosoScroll", () => {
  it("re-anchors firstItemIndex when the window slides forward on cold first visit", () => {
    // Cold first visit: the list mounts off stale IDB data, then the bootstrap
    // response slides the window forward — the oldest rows drop as the floor
    // moves up and newer rows append, so the item count is unchanged. A
    // count-growth heuristic does nothing here, leaving firstItemIndex stale so
    // the surviving rows shift virtual index and Virtuoso jumps the viewport.
    // The anchor-based compensation must shift firstItemIndex by the same
    // amount the surviving rows moved.
    const stale: ScrollOptions = {
      itemCount: 50,
      getItemKey: (i) => makeKeys(Array.from({ length: 50 }, (_, n) => n))[i],
      resetKey: "stream_1",
    }
    const harness = renderScrollHook({ itemCount: 0, getItemKey: () => "", resetKey: "stream_1" })

    // IDB live query resolves with the stale window e0..e49.
    harness.rerender(stale)
    const base = harness.current.firstItemIndex

    // Bootstrap resolves: drop the 10 oldest (e0..e9), append 10 newer
    // (e50..e59). e10 was at index 10 and is now at index 0.
    const slidKeys = makeKeys(Array.from({ length: 50 }, (_, n) => n + 10))
    harness.rerender({ itemCount: 50, getItemKey: (i) => slidKeys[i], resetKey: "stream_1" })

    // To keep the surviving anchor (e10) at the same virtual index
    // (firstItemIndex + index) after it moved from index 10 to index 0,
    // firstItemIndex must increase by 10.
    expect(harness.current.firstItemIndex).toBe(base + 10)
  })

  it("decrements firstItemIndex when older messages are prepended", () => {
    const initialKeys = makeKeys(Array.from({ length: 50 }, (_, n) => n + 10))
    const harness = renderScrollHook({ itemCount: 0, getItemKey: () => "", resetKey: "stream_1" })

    harness.rerender({ itemCount: 50, getItemKey: (i) => initialKeys[i], resetKey: "stream_1" })
    const base = harness.current.firstItemIndex

    // Prepend 10 older messages (e0..e9). The anchor e10 moves from index 0 to
    // index 10, so firstItemIndex must decrease by 10 to hold its position.
    const prependedKeys = makeKeys(Array.from({ length: 60 }, (_, n) => n))
    harness.rerender({ itemCount: 60, getItemKey: (i) => prependedKeys[i], resetKey: "stream_1" })

    expect(harness.current.firstItemIndex).toBe(base - 10)
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
