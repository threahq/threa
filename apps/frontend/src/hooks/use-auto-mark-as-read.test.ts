import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useAutoMarkAsRead } from "./use-auto-mark-as-read"
import * as useUnreadCountsModule from "./use-unread-counts"
import * as useActivityCountsModule from "./use-activity-counts"
import * as useMobileModule from "./use-mobile"

const mockMarkAsRead = vi.fn()
const mockGetUnreadCount = vi.fn()
const mockGetActivityCount = vi.fn()

let unreadCount = 1
let activityCount = 0
let hasFocus = true
let visibilityState: DocumentVisibilityState = "visible"
// Device shape — drives the phone-like focus relaxation. Defaults are a desktop
// (fine pointer, wide viewport): focus is required. Touch/tablet tests flip these.
let isMobileViewport = false
let isCoarsePointer = false

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState")

function restoreProperty(target: object, key: PropertyKey, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
    return
  }
  Reflect.deleteProperty(target, key)
}

describe("useAutoMarkAsRead", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockMarkAsRead.mockReset()
    mockGetUnreadCount.mockReset()
    mockGetActivityCount.mockReset()
    vi.useFakeTimers()

    unreadCount = 1
    activityCount = 0
    hasFocus = true
    visibilityState = "visible"
    isMobileViewport = false
    isCoarsePointer = false

    mockGetUnreadCount.mockImplementation(() => unreadCount)
    mockGetActivityCount.mockImplementation(() => activityCount)

    vi.spyOn(useMobileModule, "useIsMobile").mockImplementation(() => isMobileViewport)
    vi.spyOn(useMobileModule, "useIsCoarsePointer").mockImplementation(() => isCoarsePointer)

    vi.spyOn(useUnreadCountsModule, "useUnreadCounts").mockReturnValue({
      markAsRead: mockMarkAsRead,
      getUnreadCount: mockGetUnreadCount,
    } as unknown as ReturnType<typeof useUnreadCountsModule.useUnreadCounts>)
    vi.spyOn(useActivityCountsModule, "useActivityCounts").mockReturnValue({
      getActivityCount: mockGetActivityCount,
    } as unknown as ReturnType<typeof useActivityCountsModule.useActivityCounts>)

    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus)

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()

    restoreProperty(document, "visibilityState", originalVisibilityState)
  })

  it("marks the stream as read when the page is visible and focused", () => {
    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).toHaveBeenCalledWith("stream_123", "event_123", { partial: false })
  })

  it("does not mark the stream as read while the tab is hidden and unfocused", () => {
    visibilityState = "hidden"
    hasFocus = false

    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).not.toHaveBeenCalled()
  })

  it("does not mark the stream as read while the tab is visible but the window is unfocused", () => {
    hasFocus = false

    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).not.toHaveBeenCalled()
  })

  it("marks read on a phone-like device (coarse + narrow) that is visible but reports no focus", () => {
    // Mobile browsers / installed PWAs routinely report `document.hasFocus()` ===
    // false while the page is the foreground the user is looking at (and the
    // resume `focus` event often never fires). On a phone-like device, visible
    // must be enough — otherwise auto-mark wedges off and a stream the user is
    // clearly reading stays unread (a persisted mark-unread divider stuck red
    // across a cold app resume).
    hasFocus = false
    isMobileViewport = true
    isCoarsePointer = true

    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).toHaveBeenCalledWith("stream_123", "event_123", { partial: false })
  })

  it("does NOT mark read on a coarse-but-wide device (tablet / iPad split view) while unfocused", () => {
    // A coarse pointer alone is not "phone-like": an iPad in Split View / Stage
    // Manager is coarse but wide, and an unfocused pane there means the user is
    // working in the OTHER app — exactly the false-positive the focus gate
    // exists to prevent. The relaxation requires BOTH coarse and a phone-width
    // viewport, so a wide coarse device stays focus-gated.
    hasFocus = false
    isCoarsePointer = true
    isMobileViewport = false

    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).not.toHaveBeenCalled()
  })

  it("does NOT mark read on a phone-like device while the tab is hidden", () => {
    // The phone relaxation drops only the FOCUS requirement, never visibility —
    // a backgrounded PWA the user has switched away from must not auto-read.
    hasFocus = false
    visibilityState = "hidden"
    isMobileViewport = true
    isCoarsePointer = true

    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).not.toHaveBeenCalled()
  })

  it("waits until the tab is visible and focused again before sending the read event", () => {
    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123"))

    act(() => {
      vi.advanceTimersByTime(250)
      visibilityState = "hidden"
      hasFocus = false
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("blur"))
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).not.toHaveBeenCalled()

    act(() => {
      visibilityState = "visible"
      document.dispatchEvent(new Event("visibilitychange"))
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).not.toHaveBeenCalled()

    act(() => {
      hasFocus = true
      window.dispatchEvent(new Event("focus"))
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).toHaveBeenCalledWith("stream_123", "event_123", { partial: false })
  })

  it("passes partial through so a mid-window read does not zero the badge", () => {
    renderHook(() => useAutoMarkAsRead("ws_123", "stream_123", "event_123", { partial: true }))

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mockMarkAsRead).toHaveBeenCalledWith("stream_123", "event_123", { partial: true })
  })

  it("re-fires a full mark when partial flips to false at the same event (scrolled on to the tail)", () => {
    const { rerender } = renderHook(
      ({ partial }) => useAutoMarkAsRead("ws_123", "stream_123", "event_123", { partial }),
      {
        initialProps: { partial: true },
      }
    )

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(mockMarkAsRead).toHaveBeenLastCalledWith("stream_123", "event_123", { partial: true })

    rerender({ partial: false })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    // Same event, now full — must re-fire so the badge clears optimistically
    // rather than waiting on the server round-trip.
    expect(mockMarkAsRead).toHaveBeenLastCalledWith("stream_123", "event_123", { partial: false })
    expect(mockMarkAsRead).toHaveBeenCalledTimes(2)
  })

  it("clears the dedup on stream switch so the next stream's first mark always fires", () => {
    // The consumer isn't keyed by streamId, so the hook persists across switches.
    // The dedup refs must reset per stream — otherwise a prior stream's marked
    // event/partial-ness could suppress the next stream's first mark.
    const { rerender } = renderHook(({ streamId }) => useAutoMarkAsRead("ws_123", streamId, "event_shared"), {
      initialProps: { streamId: "stream_a" },
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(mockMarkAsRead).toHaveBeenLastCalledWith("stream_a", "event_shared", { partial: false })

    // Switch streams; the (artificially) same event id must still re-fire because
    // the dedup was cleared on the streamId change.
    rerender({ streamId: "stream_b" })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(mockMarkAsRead).toHaveBeenLastCalledWith("stream_b", "event_shared", { partial: false })
    expect(mockMarkAsRead).toHaveBeenCalledTimes(2)
  })
})
