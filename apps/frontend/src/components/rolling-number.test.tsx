import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { RollingNumber } from "./rolling-number"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
})

function snapshot(container: HTMLElement) {
  const roll = container.querySelector<HTMLElement>(".rolling-number")
  return {
    text: container.textContent,
    rolling: roll !== null,
    direction: roll?.dataset.direction ?? null,
    from: roll?.querySelector<HTMLElement>(".rolling-number-out")?.dataset.text ?? null,
  }
}

describe("RollingNumber", () => {
  it("should render the first value in place", () => {
    const { container } = render(<RollingNumber value={4} />)
    expect(snapshot(container)).toEqual({ text: "4", rolling: false, direction: null, from: null })
  })

  it("should roll up from the old value when the count grows, then settle", () => {
    const { container, rerender } = render(<RollingNumber value={4} />)
    rerender(<RollingNumber value={5} />)
    expect(snapshot(container)).toEqual({ text: "5", rolling: true, direction: "up", from: "4" })
    act(() => void vi.advanceTimersByTime(300))
    expect(snapshot(container)).toEqual({ text: "5", rolling: false, direction: null, from: null })
  })

  it("should roll down when the count shrinks", () => {
    const { container, rerender } = render(<RollingNumber value={5} />)
    rerender(<RollingNumber value={2} />)
    expect(snapshot(container)).toEqual({ text: "2", rolling: true, direction: "down", from: "5" })
  })

  it("should not roll when the count leaves zero", () => {
    const { container, rerender } = render(<RollingNumber value={0} />)
    rerender(<RollingNumber value={3} />)
    expect(snapshot(container)).toEqual({ text: "3", rolling: false, direction: null, from: null })
  })

  it("should not roll when the formatted text is unchanged", () => {
    const format = (n: number) => (n > 99 ? "99+" : String(n))
    const { container, rerender } = render(<RollingNumber value={120} format={format} />)
    rerender(<RollingNumber value={121} format={format} />)
    expect(snapshot(container)).toEqual({ text: "99+", rolling: false, direction: null, from: null })
  })

  it("should roll from the last shown value when changes land mid-roll", () => {
    const { container, rerender } = render(<RollingNumber value={1} />)
    rerender(<RollingNumber value={2} />)
    act(() => void vi.advanceTimersByTime(150))
    rerender(<RollingNumber value={3} />)
    expect(snapshot(container)).toEqual({ text: "3", rolling: true, direction: "up", from: "2" })
    act(() => void vi.advanceTimersByTime(299))
    expect(snapshot(container).rolling).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(snapshot(container)).toEqual({ text: "3", rolling: false, direction: null, from: null })
  })
})
