import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test"
import * as pointerModule from "@/hooks/use-pointer"
import { StreamTitlePreview } from "./stream-title-preview"

const LONG_NAME = "A very long stream name that the header truncates"

function touchStart(el: Element) {
  fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] })
}

describe("StreamTitlePreview", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("reveals the full name on long press and hides it on release (touch)", () => {
    vi.spyOn(pointerModule, "useCoarsePointer").mockReturnValue(true)
    render(
      <StreamTitlePreview name={LONG_NAME}>
        <h1 className="truncate">{LONG_NAME}</h1>
      </StreamTitlePreview>
    )

    const title = screen.getByRole("heading", { name: LONG_NAME })
    // Only the truncated title before the hold.
    expect(screen.getAllByText(LONG_NAME)).toHaveLength(1)

    touchStart(title)
    act(() => {
      vi.advanceTimersByTime(500)
    })

    // Title + the revealed full-name preview.
    expect(screen.getAllByText(LONG_NAME)).toHaveLength(2)

    act(() => {
      fireEvent.touchEnd(title)
    })

    expect(screen.getAllByText(LONG_NAME)).toHaveLength(1)
  })

  it("swallows the trailing click so a hold does not fire the title's tap action", () => {
    vi.spyOn(pointerModule, "useCoarsePointer").mockReturnValue(true)
    const onClick = vi.fn()
    render(
      <StreamTitlePreview name={LONG_NAME}>
        <button type="button" onClick={onClick}>
          {LONG_NAME}
        </button>
      </StreamTitlePreview>
    )

    const button = screen.getByRole("button", { name: LONG_NAME })
    touchStart(button)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    act(() => {
      fireEvent.touchEnd(button)
    })
    fireEvent.click(button)

    expect(onClick).not.toHaveBeenCalled()
  })

  it("leaves a normal tap (no hold) to trigger the title's tap action", () => {
    vi.spyOn(pointerModule, "useCoarsePointer").mockReturnValue(true)
    const onClick = vi.fn()
    render(
      <StreamTitlePreview name={LONG_NAME}>
        <button type="button" onClick={onClick}>
          {LONG_NAME}
        </button>
      </StreamTitlePreview>
    )

    const button = screen.getByRole("button", { name: LONG_NAME })
    touchStart(button)
    act(() => {
      fireEvent.touchEnd(button)
    })
    fireEvent.click(button)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("renders the child untouched on a fine pointer (no preview affordance)", () => {
    vi.spyOn(pointerModule, "useCoarsePointer").mockReturnValue(false)
    render(
      <StreamTitlePreview name={LONG_NAME}>
        <h1 className="truncate">{LONG_NAME}</h1>
      </StreamTitlePreview>
    )

    const title = screen.getByRole("heading", { name: LONG_NAME })
    touchStart(title)
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getAllByText(LONG_NAME)).toHaveLength(1)
  })
})
