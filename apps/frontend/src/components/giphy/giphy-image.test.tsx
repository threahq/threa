import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { GiphyImage } from "./giphy-image"

const GIF_URL = "https://media.giphy.com/media/abc123/giphy.gif"

function getImg(): HTMLImageElement {
  const img = document.querySelector('[data-type="giphy-embed"] img') as HTMLImageElement | null
  if (!img) throw new Error("GIF image not rendered")
  return img
}

/** Drive every automatic retry until the manual-retry fallback appears. */
function exhaustRetries() {
  for (let i = 0; i <= 5; i++) {
    act(() => {
      fireEvent.error(getImg())
      vi.advanceTimersByTime(500 * 2 ** i)
    })
  }
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
    expect(retried).toContain("_threaReload=1")
    expect(retried).toContain(GIF_URL)
  })

  it("shows a manual retry affordance once retries are exhausted", () => {
    render(<GiphyImage url={GIF_URL} title="dance" />)
    exhaustRetries()

    expect(screen.getByRole("button", { name: /tap to retry/i })).toBeInTheDocument()
    expect(document.querySelector('[data-type="giphy-embed"] img')).toBeNull()
  })

  it("starts a fresh backoff cycle when the user taps retry (not an instant re-fail)", () => {
    render(<GiphyImage url={GIF_URL} title="dance" />)
    exhaustRetries()

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /tap to retry/i }))
    })
    // The image is back with a fresh cache-busted load.
    expect(getImg().getAttribute("src")).toContain("_threaReload")

    // A subsequent error must schedule another backoff retry rather than
    // immediately falling back to the broken state.
    act(() => {
      fireEvent.error(getImg())
    })
    expect(screen.queryByRole("button", { name: /tap to retry/i })).toBeNull()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(getImg()).toBeTruthy()
  })

  it("resets retry state when the GIF URL changes", () => {
    const { rerender } = render(<GiphyImage url={GIF_URL} title="dance" />)

    act(() => {
      fireEvent.error(getImg())
      vi.advanceTimersByTime(500)
    })
    expect(getImg().getAttribute("src")).toContain("_threaReload=1")

    const nextUrl = "https://media.giphy.com/media/xyz789/giphy.gif"
    rerender(<GiphyImage url={nextUrl} title="wave" />)
    expect(getImg().getAttribute("src")).toBe(nextUrl)
  })

  it("reserves an aspect-ratio box from intrinsic dimensions to avoid load reflow", () => {
    render(<GiphyImage url={GIF_URL} title="dance" width={480} height={270} />)
    const img = getImg()
    expect(img.getAttribute("width")).toBe("480")
    expect(img.getAttribute("height")).toBe("270")
    expect(img.style.aspectRatio).toBe("480 / 270")
  })

  it("omits dimension hints when none are known (legacy embeds) so nothing distorts", () => {
    render(<GiphyImage url={GIF_URL} title="dance" />)
    const img = getImg()
    expect(img.getAttribute("width")).toBeNull()
    expect(img.getAttribute("height")).toBeNull()
    expect(img.style.aspectRatio).toBe("")
  })
})
