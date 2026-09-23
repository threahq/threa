import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook } from "@testing-library/react"
import { PopIn, useArrivals } from "./pop-in"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
})

afterEach(() => {
  vi.useRealTimers()
})

interface Props {
  ids: string[]
  resetKey?: string
  enabled?: boolean
}

function mountArrivals(initial: Props) {
  return renderHook(
    ({ ids, resetKey = "stream_a", enabled = true }: Props) => [...useArrivals(ids, resetKey, enabled).keys()],
    {
      initialProps: initial,
    }
  )
}

describe("useArrivals", () => {
  it("should report nothing on the first render of a list", () => {
    const { result } = mountArrivals({ ids: ["a", "b", "c"] })
    expect(result.current).toEqual([])
  })

  it("should report rows appended after the last seen row", () => {
    const { result, rerender } = mountArrivals({ ids: ["a", "b"] })
    rerender({ ids: ["a", "b", "c"] })
    expect(result.current).toEqual(["c"])
    rerender({ ids: ["a", "b", "c", "d", "e"] })
    expect(result.current).toEqual(["c", "e", "d"])
  })

  it("should not report prepended or backfilled rows", () => {
    const { result, rerender } = mountArrivals({ ids: ["c", "d"] })
    rerender({ ids: ["a", "b", "c", "d"] })
    rerender({ ids: ["a", "b", "bb", "c", "d"] })
    expect(result.current).toEqual([])
  })

  it("should not report a bulk append or a replaced window", () => {
    const { result, rerender } = mountArrivals({ ids: ["a"] })
    rerender({ ids: ["a", "b", "c", "d", "e"] })
    rerender({ ids: ["x", "y"] })
    expect(result.current).toEqual([])
  })

  it("should only seed while disabled and after a reset", () => {
    const { result, rerender } = mountArrivals({ ids: ["a"], enabled: false })
    rerender({ ids: ["a", "b"], enabled: false })
    rerender({ ids: ["a", "b"], enabled: true })
    expect(result.current).toEqual([])
    rerender({ ids: ["q", "r"], resetKey: "stream_b" })
    expect(result.current).toEqual([])
    rerender({ ids: ["q", "r", "s"], resetKey: "stream_b" })
    expect(result.current).toEqual(["s"])
  })

  it("should report the viewer's own send once, across its optimistic row's swap", () => {
    const { result, rerender } = mountArrivals({ ids: ["a"] })
    rerender({ ids: ["a", "temp_1"] })
    rerender({ ids: ["a", "temp_1"] })
    expect(result.current).toEqual(["temp_1"])
  })

  it("should forget an arrival once its effect has run out", () => {
    const { result, rerender } = mountArrivals({ ids: ["a"] })
    rerender({ ids: ["a", "b"] })
    vi.advanceTimersByTime(450)
    rerender({ ids: ["a", "b"] })
    rerender({ ids: ["a", "b"] })
    expect(result.current).toEqual([])
  })
})

function popInState(container: HTMLElement) {
  const outer = container.firstElementChild as HTMLElement
  const inner = outer.firstElementChild as HTMLElement
  return {
    outer: outer.className,
    inner: inner.className,
    elapsed: outer.style.getPropertyValue("--pop-in-elapsed"),
    content: inner.textContent,
  }
}

describe("PopIn", () => {
  it("should render a row that was already there without any animation", () => {
    const { container } = render(
      <PopIn arrivedAt={undefined} className="row">
        hello
      </PopIn>
    )
    expect(popInState(container)).toEqual({ outer: "row", inner: "", elapsed: "", content: "hello" })
  })

  it("should grow and fade in, then settle for a fresh arrival", () => {
    const { container } = render(
      <PopIn arrivedAt={performance.now()} className="row">
        hello
      </PopIn>
    )
    expect(popInState(container)).toEqual({
      outer: "row pop-in-grow",
      inner: "pop-in-fx",
      elapsed: "0ms",
      content: "hello",
    })
    act(() => vi.advanceTimersByTime(450))
    expect(popInState(container)).toEqual({ outer: "row", inner: "", elapsed: "", content: "hello" })
  })

  it("should resume mid-arrival when remounted rather than replay", () => {
    const arrivedAt = performance.now()
    vi.advanceTimersByTime(200)
    const { container } = render(
      <PopIn arrivedAt={arrivedAt} className="row">
        hello
      </PopIn>
    )
    expect(popInState(container)).toEqual({
      outer: "row pop-in-grow",
      inner: "pop-in-fx",
      elapsed: "200ms",
      content: "hello",
    })
    act(() => vi.advanceTimersByTime(250))
    expect(popInState(container)).toEqual({ outer: "row", inner: "", elapsed: "", content: "hello" })
  })
})
