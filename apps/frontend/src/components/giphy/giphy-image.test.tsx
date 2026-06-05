import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { GiphyImage } from "./giphy-image"

const GIF_URL = "https://media.giphy.com/media/abc123/giphy.gif"

function getImg(): HTMLImageElement {
  const img = document.querySelector('img[data-type], [data-type="giphy-embed"] img') as HTMLImageElement | null
  if (!img) throw new Error("GIF image not rendered")
  return img
}

describe("GiphyImage — load reliability", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("loads the pristine URL on the first attempt (no cache-bust param)", () => {
    render(<GiphyImage url={GIF_URL} title="dance" />)
    expect(getImg().getAttribute("src")).toBe(GIF_URL)
  })

  it("retries with a cache-busting param after a transient load error", () => {
    render(<GiphyImage url={GIF_URL} title="dance" />)

    act(() => {
      fireEvent.error(getImg())
    })
    // Backoff hasn't elapsed yet — still on the original src.
    expect(getImg().getAttribute("src")).toBe(GIF_URL)

    act(() => {
      vi.advanceTimersByTime(500)
    })
    const retried = getImg().getAttribute("src") ?? ""
    expect(retried).toContain("_threaRetry=1")
    expect(retried).toContain(GIF_URL)
  })

  it("shows a manual retry affordance once retries are exhausted, then recovers on tap", () => {
    render(<GiphyImage url={GIF_URL} title="dance" />)

    // Exhaust every retry: each error schedules the next attempt after backoff.
    for (let i = 0; i <= 5; i++) {
      act(() => {
        fireEvent.error(getImg())
        vi.advanceTimersByTime(500 * 2 ** i)
      })
    }

    const retryButton = screen.getByRole("button", { name: /tap to retry/i })
    expect(retryButton).toBeInTheDocument()

    act(() => {
      fireEvent.click(retryButton)
    })
    // The image is back, attempting a fresh cache-busted load.
    expect(getImg().getAttribute("src")).toContain("_threaRetry")
  })

  it("resets retry state when the GIF URL changes", () => {
    const { rerender } = render(<GiphyImage url={GIF_URL} title="dance" />)

    act(() => {
      fireEvent.error(getImg())
      vi.advanceTimersByTime(500)
    })
    expect(getImg().getAttribute("src")).toContain("_threaRetry=1")

    const nextUrl = "https://media.giphy.com/media/xyz789/giphy.gif"
    rerender(<GiphyImage url={nextUrl} title="wave" />)
    expect(getImg().getAttribute("src")).toBe(nextUrl)
  })
})
