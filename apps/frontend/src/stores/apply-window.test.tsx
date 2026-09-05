import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  beginApplyWindow,
  endApplyWindow,
  isApplyWindowOpen,
  resetApplyWindow,
  subscribeApplyWindow,
  trackPendingRead,
  useBatchedValue,
  whenReadsSettled,
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

  it("takes the new key's value inside a window instead of holding the previous key's", () => {
    const { result, rerender } = renderHook(({ value, key }) => useBatchedValue(value, key), {
      initialProps: { value: "a1", key: "stream_a" },
    })

    act(() => beginApplyWindow())
    rerender({ value: "b1", key: "stream_b" })
    expect(result.current).toBe("b1")
    rerender({ value: "b2", key: "stream_b" })
    expect(result.current).toBe("b1")

    act(() => endApplyWindow())
    expect(result.current).toBe("b2")
  })
})

describe("whenReadsSettled", () => {
  beforeEach(() => {
    resetApplyWindow()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetApplyWindow()
  })

  async function settles(promise: Promise<void>, withinMs: number): Promise<boolean> {
    return Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), withinMs)),
    ])
  }

  it("resolves right away when no read is pending", async () => {
    expect(await settles(whenReadsSettled(), 100)).toBe(true)
  })

  it("waits for a tracked read to release", async () => {
    const release = trackPendingRead()
    const settled = whenReadsSettled()
    expect(await settles(settled, 30)).toBe(false)
    release()
    expect(await settles(settled, 100)).toBe(true)
  })

  it("ignores a release from before a reset", async () => {
    const stale = trackPendingRead()
    resetApplyWindow()
    const release = trackPendingRead()
    stale()
    const settled = whenReadsSettled()
    expect(await settles(settled, 30)).toBe(false)
    release()
    expect(await settles(settled, 100)).toBe(true)
  })

  it("counts a release once, however many times it is called", async () => {
    const releaseFirst = trackPendingRead()
    const releaseSecond = trackPendingRead()
    releaseFirst()
    releaseFirst()
    const settled = whenReadsSettled()
    expect(await settles(settled, 30)).toBe(false)
    releaseSecond()
    expect(await settles(settled, 100)).toBe(true)
  })

  it("releases on the deadline when a reader never settles", async () => {
    vi.useFakeTimers()
    trackPendingRead()
    let settled = false
    const pending = whenReadsSettled().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_900)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await pending
    expect(settled).toBe(true)
  })
})
