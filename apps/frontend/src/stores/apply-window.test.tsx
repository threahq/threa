import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  beginApplyWindow,
  endApplyWindow,
  isApplyWindowOpen,
  resetApplyWindow,
  subscribeApplyWindow,
  useBatchedValue,
} from "./apply-window"

describe("apply window gate", () => {
  beforeEach(() => {
    resetApplyWindow()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetApplyWindow()
  })

  it("refcounts begin/end so nested windows stay open until the last close", () => {
    expect(isApplyWindowOpen()).toBe(false)
    beginApplyWindow()
    beginApplyWindow()
    expect(isApplyWindowOpen()).toBe(true)
    endApplyWindow()
    expect(isApplyWindowOpen()).toBe(true)
    endApplyWindow()
    expect(isApplyWindowOpen()).toBe(false)
  })

  it("ignores an unbalanced end", () => {
    endApplyWindow()
    expect(isApplyWindowOpen()).toBe(false)
  })

  it("notifies subscribers on every open/close transition", () => {
    const transitions: boolean[] = []
    const unsubscribe = subscribeApplyWindow(() => transitions.push(isApplyWindowOpen()))
    beginApplyWindow()
    endApplyWindow()
    unsubscribe()
    expect(transitions).toEqual([true, false])
  })

  it("stays open until its opener closes it, however long that takes", () => {
    // A clock-driven close would paint a half-applied refresh. A stuck refresh
    // is cancelled by its request timeout instead, which reaches the opener's
    // own endApplyWindow.
    vi.useFakeTimers()
    beginApplyWindow()
    act(() => vi.advanceTimersByTime(60_000))
    expect(isApplyWindowOpen()).toBe(true)
    endApplyWindow()
    expect(isApplyWindowOpen()).toBe(false)
  })
})

describe("useBatchedValue", () => {
  beforeEach(() => {
    resetApplyWindow()
  })

  afterEach(() => {
    resetApplyWindow()
  })

  it("passes the value through while no window is open", () => {
    const { result, rerender } = renderHook(({ value }) => useBatchedValue(value), {
      initialProps: { value: "a" },
    })
    expect(result.current).toBe("a")
    rerender({ value: "b" })
    expect(result.current).toBe("b")
  })

  it("freezes at the pre-window value while open, then releases to the latest on close", () => {
    const { result, rerender } = renderHook(({ value }) => useBatchedValue(value), {
      initialProps: { value: "a" },
    })
    expect(result.current).toBe("a")

    act(() => beginApplyWindow())
    rerender({ value: "b" })
    expect(result.current).toBe("a")
    rerender({ value: "c" })
    expect(result.current).toBe("a")

    act(() => endApplyWindow())
    expect(result.current).toBe("c")
  })
})
