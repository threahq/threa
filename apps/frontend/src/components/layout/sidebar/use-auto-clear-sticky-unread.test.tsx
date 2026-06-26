import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useAutoClearStickyUnread } from "./use-auto-clear-sticky-unread"

let hasFocus = true
let visibilityState: DocumentVisibilityState = "visible"

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState")

/** Drive the focus/visibility the hook reads via `usePageActivity`, then fire
 *  the listeners that hook subscribes to so its state re-reads. */
function setFocus(focused: boolean) {
  hasFocus = focused
  act(() => {
    window.dispatchEvent(new Event(focused ? "focus" : "blur"))
  })
}

describe("useAutoClearStickyUnread", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hasFocus = true
    visibilityState = "visible"
    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus)
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (originalVisibilityState) Object.defineProperty(document, "visibilityState", originalVisibilityState)
  })

  it("flushes read residue when the sidebar becomes hidden", () => {
    const clearRead = vi.fn()
    const { rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) =>
        useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: hidden }),
      { initialProps: { hidden: false } }
    )
    expect(clearRead).not.toHaveBeenCalled()

    rerender({ hidden: true })
    expect(clearRead).toHaveBeenCalledTimes(1)
  })

  it("flushes read residue when the app regains focus", () => {
    const clearRead = vi.fn()
    renderHook(() => useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: false }))

    setFocus(false)
    expect(clearRead).not.toHaveBeenCalled()

    setFocus(true)
    expect(clearRead).toHaveBeenCalledTimes(1)
  })

  it("flushes read residue after the idle timeout while left open", () => {
    const clearRead = vi.fn()
    renderHook(() => useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: false }))

    expect(clearRead).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(15_000))
    expect(clearRead).toHaveBeenCalledTimes(1)
  })

  it("does nothing when there is no read residue", () => {
    const clearRead = vi.fn()
    const { rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) =>
        useAutoClearStickyUnread({ hasReadResidue: false, clearRead, sidebarHidden: hidden }),
      { initialProps: { hidden: false } }
    )

    rerender({ hidden: true })
    setFocus(false)
    setFocus(true)
    act(() => vi.advanceTimersByTime(15_000))
    expect(clearRead).not.toHaveBeenCalled()
  })

  it("keeps the idle timer armed across stream-list churn (clearRead identity changes)", () => {
    let clearRead = vi.fn()
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) =>
        useAutoClearStickyUnread({ hasReadResidue: true, clearRead: fn, sidebarHidden: false }),
      { initialProps: { fn: clearRead } }
    )

    act(() => vi.advanceTimersByTime(10_000))
    // A new stream-list render hands the hook a fresh clearRead identity.
    const firstClearRead = clearRead
    clearRead = vi.fn()
    rerender({ fn: clearRead })

    // The timer must not have been reset by the identity change.
    act(() => vi.advanceTimersByTime(5_000))
    expect(firstClearRead).not.toHaveBeenCalled()
    expect(clearRead).toHaveBeenCalledTimes(1)
  })
})
