import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useNotificationPauseAutoExpiry } from "./use-notification-pause-auto-expiry"
import * as useWorkspacesModule from "./use-workspaces"

describe("useNotificationPauseAutoExpiry", () => {
  const mutate = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    mutate.mockReset()
    vi.spyOn(useWorkspacesModule, "useResumeNotifications").mockReturnValue({
      mutate,
    } as unknown as ReturnType<typeof useWorkspacesModule.useResumeNotifications>)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("resumes notifications when a timed pause lapses", () => {
    const until = new Date(Date.now() + 60_000).toISOString()
    renderHook(() =>
      useNotificationPauseAutoExpiry("ws_1", {
        notificationsPausedUntil: until,
        notificationsPausedIndefinitely: false,
      })
    )

    expect(mutate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(mutate).toHaveBeenCalledWith(undefined, expect.objectContaining({ onError: expect.any(Function) }))
  })

  it("does not schedule a resume for an indefinite pause", () => {
    renderHook(() =>
      useNotificationPauseAutoExpiry("ws_1", {
        notificationsPausedUntil: null,
        notificationsPausedIndefinitely: true,
      })
    )
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("does not schedule a resume when notifications are not paused", () => {
    renderHook(() =>
      useNotificationPauseAutoExpiry("ws_1", {
        notificationsPausedUntil: null,
        notificationsPausedIndefinitely: false,
      })
    )
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("no-ops when there is no current user", () => {
    renderHook(() => useNotificationPauseAutoExpiry("ws_1", null))
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("does not schedule a timer for an already-elapsed pause (masked, left to read-time clearing)", () => {
    const elapsed = new Date(Date.now() - 60_000).toISOString()
    renderHook(() =>
      useNotificationPauseAutoExpiry("ws_1", {
        notificationsPausedUntil: elapsed,
        notificationsPausedIndefinitely: false,
      })
    )
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })
})
