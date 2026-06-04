import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useStatusAutoExpiry } from "./use-status-auto-expiry"
import * as useWorkspacesModule from "./use-workspaces"

describe("useStatusAutoExpiry", () => {
  const mutate = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    mutate.mockReset()
    vi.spyOn(useWorkspacesModule, "useClearStatus").mockReturnValue({
      mutate,
    } as unknown as ReturnType<typeof useWorkspacesModule.useClearStatus>)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("clears the status when a finite expiry lapses", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    renderHook(() =>
      useStatusAutoExpiry("ws_1", { statusEmoji: "dart", statusText: "Focus", statusExpiresAt: expiresAt })
    )

    expect(mutate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(mutate).toHaveBeenCalledWith(undefined, expect.objectContaining({ onError: expect.any(Function) }))
  })

  it("does not schedule a clear for an indefinite status", () => {
    renderHook(() => useStatusAutoExpiry("ws_1", { statusEmoji: "dart", statusText: "Focus", statusExpiresAt: null }))
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("no-ops when there is no current user", () => {
    renderHook(() => useStatusAutoExpiry("ws_1", null))
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("does not schedule a timer for an already-expired status (masked, left to read-time clearing)", () => {
    const expired = new Date(Date.now() - 60_000).toISOString()
    renderHook(() => useStatusAutoExpiry("ws_1", { statusEmoji: "dart", statusText: "Old", statusExpiresAt: expired }))
    vi.advanceTimersByTime(10 * 60_000)
    expect(mutate).not.toHaveBeenCalled()
  })
})
