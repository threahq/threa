import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useAutoClearStickyUnread } from "./use-auto-clear-sticky-unread"

let hasFocus = true

/** Drive the focus the hook reads via `usePageActivity`, then fire the window
 *  listeners that hook subscribes to so its state re-reads. */
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
    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("flushes read residue when the sidebar becomes hidden", () => {
    const clearRead = vi.fn()
    const { rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) =>
        useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: hidden, isMobile: false }),
      { initialProps: { hidden: false } }
    )
    expect(clearRead).not.toHaveBeenCalled()

    rerender({ hidden: true })
    expect(clearRead).toHaveBeenCalledTimes(1)
  })

  it("flushes read residue when the app regains focus", () => {
    const clearRead = vi.fn()
    renderHook(() =>
      useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: false, isMobile: false })
    )

    setFocus(false)
    expect(clearRead).not.toHaveBeenCalled()

    setFocus(true)
    expect(clearRead).toHaveBeenCalledTimes(1)
  })

  it("flushes read residue after the idle timeout while left open on desktop", () => {
    const clearRead = vi.fn()
    renderHook(() =>
      useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: false, isMobile: false })
    )

    expect(clearRead).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(15_000))
    expect(clearRead).toHaveBeenCalledTimes(1)
  })

  it("does not run the idle timer on mobile, where the open sidebar is an on-screen overlay", () => {
    const clearRead = vi.fn()
    renderHook(() =>
      useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: false, isMobile: true })
    )

    act(() => vi.advanceTimersByTime(15_000))
    expect(clearRead).not.toHaveBeenCalled()
  })

  it("still flushes on mobile via the hidden and refocus triggers", () => {
    const clearRead = vi.fn()
    const { rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) =>
        useAutoClearStickyUnread({ hasReadResidue: true, clearRead, sidebarHidden: hidden, isMobile: true }),
      { initialProps: { hidden: false } }
    )

    setFocus(false)
    setFocus(true)
    expect(clearRead).toHaveBeenCalledTimes(1)

    rerender({ hidden: true })
    expect(clearRead).toHaveBeenCalledTimes(2)
  })

  it("does nothing when there is no read residue", () => {
    const clearRead = vi.fn()
    const { rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) =>
        useAutoClearStickyUnread({ hasReadResidue: false, clearRead, sidebarHidden: hidden, isMobile: false }),
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
        useAutoClearStickyUnread({ hasReadResidue: true, clearRead: fn, sidebarHidden: false, isMobile: false }),
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
