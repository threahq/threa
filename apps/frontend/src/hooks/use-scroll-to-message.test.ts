import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { readHold, useScrollToMessage } from "./use-scroll-to-message"

function scrollerWithRowAt(rowTop: number, scrollTop = 800): HTMLElement {
  const el = document.createElement("div")
  const row = document.createElement("div")
  row.dataset.messageId = "msg_held"
  el.appendChild(row)
  Object.defineProperty(el, "scrollTop", { value: scrollTop })
  el.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 400, height: 600 })
  row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100 + rowTop, width: 400, height: 40 })
  return el
}

describe("readHold", () => {
  const hold = { id: "msg_held", offsetPx: 120, takenAt: 1000, contentTop: 920 }
  const row = (offsetPx: number) => ({ id: "msg_held", offsetPx })

  it("tells a held row, a reflow above it, and an unstamped scroll apart", () => {
    expect({
      held: readHold(scrollerWithRowAt(120), hold, 500),
      reflow: readHold(scrollerWithRowAt(260), hold, 500),
      reflowWithVirtualizerShift: readHold(scrollerWithRowAt(520, 272), hold, 500),
      scrolled: readHold(scrollerWithRowAt(-340, 1260), hold, 500),
      unlandedSeed: readHold(scrollerWithRowAt(-340, 1260), { ...hold, contentTop: null }, 500),
    }).toEqual({
      held: { state: "held", row: row(120) },
      reflow: { state: "reflowed", row: row(260) },
      reflowWithVirtualizerShift: { state: "reflowed", row: row(520) },
      scrolled: { state: "scrolled" },
      unlandedSeed: { state: "reflowed", row: row(-340) },
    })
  })

  it("voids the hold after a gesture, and when the row unmounts", () => {
    expect({
      gesture: readHold(scrollerWithRowAt(120), hold, 1500),
      unmounted: readHold(document.createElement("div"), hold, 500),
    }).toEqual({ gesture: { state: "void" }, unmounted: { state: "void" } })
  })
})

function renderClampedScroller(rowContentTop: number) {
  const el = document.createElement("div")
  const row = document.createElement("div")
  row.dataset.messageId = "msg_target"
  el.appendChild(row)
  const layout = { rowContentTop, scrollHeight: 1200 }
  let scrollTop = 300
  Object.defineProperties(el, {
    clientHeight: { get: () => 600 },
    scrollHeight: { get: () => layout.scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, layout.scrollHeight - 600))
      },
    },
  })
  el.getBoundingClientRect = () => DOMRect.fromRect({ y: 100, width: 400, height: 600 })
  row.getBoundingClientRect = () =>
    DOMRect.fromRect({ y: 100 + layout.rowContentTop - scrollTop, width: 400, height: 40 })
  const userInteractedAtRef = { current: 0 }
  const { result } = renderHook(() =>
    useScrollToMessage({
      findIndex: () => 0,
      findLiveIndex: () => 0,
      scrollerRef: { current: el },
      listRef: { current: null },
      disableAutoScroll: vi.fn(),
      isFollowingTailRef: { current: false },
      userInteractedAtRef,
      programmaticScrollAtRef: { current: 0 },
    })
  )
  return { el, row, layout, result, userInteractedAtRef }
}

describe("useScrollToMessage at scroll boundaries", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each([
    { boundary: "tail", rowContentTop: 1160, expectedScrollTop: 600, expectedOffset: 560 },
    { boundary: "head", rowContentTop: 0, expectedScrollTop: 0, expectedOffset: 0 },
  ])("should reveal a visible target promptly when start alignment is clamped at the $boundary", (scenario) => {
    const { el, row, result } = renderClampedScroller(scenario.rowContentTop)
    const onFirstSettle = vi.fn()

    act(() => {
      result.current.scrollToMessage("msg_target", { align: "start", onFirstSettle })
      vi.advanceTimersByTime(180)
    })

    expect({
      scrollTop: el.scrollTop,
      offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top,
      settled: onFirstSettle.mock.calls,
      hold: result.current.detachedHoldRef.current && {
        id: result.current.detachedHoldRef.current.id,
        offsetPx: result.current.detachedHoldRef.current.offsetPx,
      },
    }).toEqual({
      scrollTop: scenario.expectedScrollTop,
      offset: scenario.expectedOffset,
      settled: [[]],
      hold: { id: "msg_target", offsetPx: scenario.expectedOffset },
    })
  })

  it("should keep correcting late reflow after a clamped settle until the user takes over", () => {
    const { el, layout, result, userInteractedAtRef } = renderClampedScroller(1160)
    const onFirstSettle = vi.fn()
    act(() => {
      result.current.scrollToMessage("msg_target", { align: "start", onFirstSettle })
      vi.advanceTimersByTime(180)
    })
    expect(onFirstSettle.mock.calls).toEqual([[]])

    act(() => {
      layout.rowContentTop += 300
      layout.scrollHeight += 300
      vi.advanceTimersByTime(60)
    })
    expect(el.scrollTop).toBe(900)

    act(() => {
      userInteractedAtRef.current = performance.now()
      el.dispatchEvent(new Event("wheel"))
      el.scrollTop = 700
      layout.rowContentTop += 300
      layout.scrollHeight += 300
      vi.advanceTimersByTime(1200)
    })
    expect({
      scrollTop: el.scrollTop,
      settled: onFirstSettle.mock.calls,
      active: result.current.scrollAbortRef.current,
    }).toEqual({
      scrollTop: 700,
      settled: [[]],
      active: null,
    })
  })
})
