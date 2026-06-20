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

  it("force-closes a stranded window via the watchdog", () => {
    vi.useFakeTimers()
    beginApplyWindow()
    expect(isApplyWindowOpen()).toBe(true)
    act(() => vi.advanceTimersByTime(5_000))
    expect(isApplyWindowOpen()).toBe(false)
  })

  it("does not push the watchdog deadline out on a nested begin", () => {
    vi.useFakeTimers()
    beginApplyWindow() // arms the 5s watchdog at depth 1
    act(() => vi.advanceTimersByTime(3_000))
    beginApplyWindow() // nested (depth 2) — must NOT re-arm and extend the deadline
    act(() => vi.advanceTimersByTime(2_000)) // 5s total since the FIRST open
    // Fires 5s from the first open regardless of the nested begin; a re-arming
    // watchdog would have reset to t=8s and still be open here.
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
