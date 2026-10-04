import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { PopIn } from "./pop-in"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
})

afterEach(() => {
  vi.useRealTimers()
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
