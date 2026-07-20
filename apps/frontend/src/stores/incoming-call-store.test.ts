import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  useIncomingCalls,
  addIncomingCall,
  settleIncomingCall,
  resetIncomingCallStoreCache,
  getIncomingCalls,
  type IncomingCall,
} from "./incoming-call-store"

function makeCall(overrides: Partial<IncomingCall> = {}): IncomingCall {
  return {
    attemptId: "callinv_1",
    callId: "call_1",
    workspaceId: "ws_1",
    streamId: "stream_dm",
    inviterId: "usr_a",
    inviterName: "Ada",
    mode: "video",
    expiresAtMs: Date.now() + 45_000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetIncomingCallStoreCache()
})

afterEach(() => {
  resetIncomingCallStoreCache()
  vi.useRealTimers()
})

describe("incoming call store", () => {
  it("surfaces a live ring and clears it on settle (cross-device accept path)", () => {
    const { result } = renderHook(() => useIncomingCalls())
    expect(result.current).toEqual([])

    act(() => addIncomingCall(makeCall()))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].attemptId).toBe("callinv_1")

    // A settle arriving from any device (or this one) removes the overlay.
    act(() => settleIncomingCall("callinv_1"))
    expect(result.current).toEqual([])
  })

  it("is idempotent on a duplicate attempt id (one ring per attempt across devices)", () => {
    const { result } = renderHook(() => useIncomingCalls())
    act(() => addIncomingCall(makeCall()))
    act(() => addIncomingCall(makeCall({ inviterName: "Someone else" })))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].inviterName).toBe("Ada")
  })

  it("drops a ring already past its deadline (stale sync-log replay after being offline)", () => {
    act(() => addIncomingCall(makeCall({ expiresAtMs: Date.now() - 1 })))
    expect(getIncomingCalls()).toEqual([])
  })

  it("self-dismisses at the deadline when no settle arrives", () => {
    const { result } = renderHook(() => useIncomingCalls())
    act(() => addIncomingCall(makeCall({ expiresAtMs: Date.now() + 1_000 })))
    expect(result.current).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1_000))
    expect(result.current).toEqual([])
  })

  it("resets every ring on account switch", () => {
    act(() => addIncomingCall(makeCall()))
    act(() => addIncomingCall(makeCall({ attemptId: "callinv_2" })))
    expect(getIncomingCalls()).toHaveLength(2)
    act(() => resetIncomingCallStoreCache())
    expect(getIncomingCalls()).toEqual([])
  })
})
