import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePageResume } from "./use-page-resume"

let visibilityState: DocumentVisibilityState = "visible"
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState")

function setVisibility(state: DocumentVisibilityState) {
  visibilityState = state
  document.dispatchEvent(new Event("visibilitychange"))
}

function blurWindow() {
  window.dispatchEvent(new Event("blur"))
}

function focusWindow() {
  window.dispatchEvent(new Event("focus"))
}

describe("usePageResume", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibilityState = "visible"
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState)
    } else {
      Reflect.deleteProperty(document, "visibilityState")
    }
  })

  it("does not fire when hide is shorter than the threshold", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(5_000)
      setVisibility("visible")
    })

    expect(onResume).not.toHaveBeenCalled()
  })

  it("fires exactly once when hide meets the threshold", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(10_500)
      setVisibility("visible")
    })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it("evaluates each hide/visible cycle independently", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(12_000)
      setVisibility("visible")
    })
    expect(onResume).toHaveBeenCalledTimes(1)

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(2_000)
      setVisibility("visible")
    })
    expect(onResume).toHaveBeenCalledTimes(1)

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(15_000)
      setVisibility("visible")
    })
    expect(onResume).toHaveBeenCalledTimes(2)
  })

  it("does not fire when becoming visible without a prior hide", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      setVisibility("visible")
    })

    expect(onResume).not.toHaveBeenCalled()
  })

  it("honors updates to the onResume callback without re-subscribing", () => {
    const onResumeA = vi.fn()
    const onResumeB = vi.fn()

    const { rerender } = renderHook(({ cb }: { cb: () => void }) => usePageResume(cb, 10_000), {
      initialProps: { cb: onResumeA },
    })

    rerender({ cb: onResumeB })

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(12_000)
      setVisibility("visible")
    })

    expect(onResumeA).not.toHaveBeenCalled()
    expect(onResumeB).toHaveBeenCalledTimes(1)
  })

  it("removes the listener on unmount", () => {
    const onResume = vi.fn()
    const { unmount } = renderHook(() => usePageResume(onResume, 10_000))

    unmount()

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(12_000)
      setVisibility("visible")
    })

    expect(onResume).not.toHaveBeenCalled()
  })

  it("fires when the window regains focus after a long blur (desktop app-switch)", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      blurWindow()
      vi.advanceTimersByTime(12_000)
      focusWindow()
    })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it("does not fire for a brief focus loss under the threshold", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      blurWindow()
      vi.advanceTimersByTime(2_000)
      focusWindow()
    })

    expect(onResume).not.toHaveBeenCalled()
  })

  it("does not fire on focus without a prior blur", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      focusWindow()
    })

    expect(onResume).not.toHaveBeenCalled()
  })

  it("resumes exactly once when a tab switch fires both visibility and focus events", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      setVisibility("hidden")
      blurWindow()
      vi.advanceTimersByTime(12_000)
      setVisibility("visible")
      focusWindow()
    })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it("does not resume on focus while the tab is still hidden", () => {
    const onResume = vi.fn()
    renderHook(() => usePageResume(onResume, 10_000))

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(12_000)
      focusWindow()
    })

    expect(onResume).not.toHaveBeenCalled()

    act(() => {
      setVisibility("visible")
    })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it("removes the focus and blur listeners on unmount", () => {
    const onResume = vi.fn()
    const { unmount } = renderHook(() => usePageResume(onResume, 10_000))

    unmount()

    act(() => {
      blurWindow()
      vi.advanceTimersByTime(12_000)
      focusWindow()
    })

    expect(onResume).not.toHaveBeenCalled()
  })
})
