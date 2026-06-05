import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useNotificationPauseControls } from "./use-notification-pause-controls"
import * as useWorkspacesModule from "./use-workspaces"
import * as useWorkScheduleModule from "./use-work-schedule"
import { createMockUser } from "@/test/fixtures/users"

describe("useNotificationPauseControls", () => {
  const pauseAsync = vi.fn().mockResolvedValue(undefined)
  const resumeAsync = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    pauseAsync.mockClear()
    resumeAsync.mockClear()
    vi.spyOn(useWorkspacesModule, "usePauseNotifications").mockReturnValue({
      mutateAsync: pauseAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useWorkspacesModule.usePauseNotifications>)
    vi.spyOn(useWorkspacesModule, "useResumeNotifications").mockReturnValue({
      mutateAsync: resumeAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useWorkspacesModule.useResumeNotifications>)
    vi.spyOn(useWorkScheduleModule, "useEffectiveWorkSchedule").mockReturnValue(
      {} as unknown as ReturnType<typeof useWorkScheduleModule.useEffectiveWorkSchedule>
    )
    vi.spyOn(useWorkspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("pauses for a timed option with an absolute future instant", async () => {
    const { result } = renderHook(() => useNotificationPauseControls("ws_1"))
    result.current.pauseFor({ id: "1h", label: "For 1 hour", duration: { kind: "duration", minutes: 60 } })
    await waitFor(() => expect(pauseAsync).toHaveBeenCalledTimes(1))
    const until = pauseAsync.mock.calls[0][0] as string
    expect(typeof until).toBe("string")
    expect(new Date(until).getTime()).toBeGreaterThan(Date.now())
  })

  it("pauses indefinitely with null", async () => {
    const { result } = renderHook(() => useNotificationPauseControls("ws_1"))
    result.current.pauseFor({ id: "never", label: "Until I turn it back on", duration: null })
    await waitFor(() => expect(pauseAsync).toHaveBeenCalledWith(null))
  })

  it("rejects a past custom time without pausing", () => {
    const { result } = renderHook(() => useNotificationPauseControls("ws_1"))
    const ok = result.current.pauseUntilLocal("2020-01-01", "00:00")
    expect(ok).toBe(false)
    expect(pauseAsync).not.toHaveBeenCalled()
  })

  it("resolves an indefinite manual pause as active/manual (resumable)", () => {
    vi.spyOn(useWorkspacesModule, "useCurrentWorkspaceUser").mockReturnValue(
      createMockUser({ id: "usr_1", workosUserId: "workos_1", notificationsPausedIndefinitely: true })
    )
    const { result } = renderHook(() => useNotificationPauseControls("ws_1"))
    expect(result.current.active).toEqual({ until: null, source: "manual" })
    expect(result.current.statusOnly).toBe(false)
  })

  it("resumes notifications", async () => {
    const { result } = renderHook(() => useNotificationPauseControls("ws_1"))
    result.current.resume()
    await waitFor(() => expect(resumeAsync).toHaveBeenCalledTimes(1))
  })
})
