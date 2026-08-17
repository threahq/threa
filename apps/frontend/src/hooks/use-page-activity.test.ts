import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePageActivity, INTERACTION_RESAMPLE_THROTTLE_MS } from "./use-page-activity"

let visibilityState: DocumentVisibilityState = "hidden"
let hasFocus = false

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState")

function setPageState(next: { visibilityState: DocumentVisibilityState; hasFocus: boolean }) {
  visibilityState = next.visibilityState
  hasFocus = next.hasFocus
}

describe("usePageActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setPageState({ visibilityState: "hidden", hasFocus: false })
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    })
    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState)
    } else {
      Reflect.deleteProperty(document, "visibilityState")
    }
  })

  it("recovers from a stuck-hidden resume on pointerdown, with no lifecycle event", () => {
    const { result } = renderHook(() => usePageActivity())
    expect(result.current).toEqual({ isVisible: false, isFocused: false, isActive: false })

    setPageState({ visibilityState: "visible", hasFocus: true })
    act(() => {
      window.dispatchEvent(new Event("pointerdown"))
    })

    expect(result.current).toEqual({ isVisible: true, isFocused: true, isActive: true })
  })

  it("recovers from a stuck-hidden resume on keydown, with no lifecycle event", () => {
    const { result } = renderHook(() => usePageActivity())

    setPageState({ visibilityState: "visible", hasFocus: true })
    act(() => {
      window.dispatchEvent(new Event("keydown"))
    })

    expect(result.current).toEqual({ isVisible: true, isFocused: true, isActive: true })
  })

  it("throttles resampling: a second interaction inside the window is ignored, the next one after it lands", () => {
    const { result } = renderHook(() => usePageActivity())

    setPageState({ visibilityState: "visible", hasFocus: true })
    act(() => {
      window.dispatchEvent(new Event("pointerdown"))
    })
    expect(result.current).toEqual({ isVisible: true, isFocused: true, isActive: true })

    setPageState({ visibilityState: "hidden", hasFocus: false })
    act(() => {
      window.dispatchEvent(new Event("keydown"))
    })
    expect(result.current).toEqual({ isVisible: true, isFocused: true, isActive: true })

    act(() => {
      vi.advanceTimersByTime(INTERACTION_RESAMPLE_THROTTLE_MS)
      window.dispatchEvent(new Event("keydown"))
    })
    expect(result.current).toEqual({ isVisible: false, isFocused: false, isActive: false })
  })

  it("removes every interaction listener on unmount, each with its registered callback and capture flag", () => {
    const added = vi.spyOn(window, "addEventListener")
    const removed = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => usePageActivity())

    const interactionTypes = ["pointerdown", "keydown", "wheel", "touchstart"]
    const registered = new Map(
      added.mock.calls.filter(([type]) => interactionTypes.includes(type as string)).map(([type, cb]) => [type, cb])
    )
    expect([...registered.keys()].sort()).toEqual([...interactionTypes].sort())

    unmount()

    const removedInteraction = removed.mock.calls.filter(([type]) => interactionTypes.includes(type as string))
    expect(removedInteraction.sort()).toEqual(
      [...registered.entries()].map(([type, cb]) => [type, cb, { capture: true }]).sort()
    )
  })

  it("still tracks visibilitychange", () => {
    const { result } = renderHook(() => usePageActivity())

    setPageState({ visibilityState: "visible", hasFocus: true })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })

    expect(result.current).toEqual({ isVisible: true, isFocused: false, isActive: false })
  })
})
