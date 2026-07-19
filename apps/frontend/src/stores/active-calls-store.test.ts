import { describe, expect, it, beforeEach } from "vitest"
import type { ActiveCall } from "@threa/types"
import {
  seedActiveCalls,
  upsertActiveCall,
  updateCallParticipants,
  removeActiveCall,
  getActiveCall,
  __resetActiveCallsStore,
} from "./active-calls-store"

function call(overrides: Partial<ActiveCall> = {}): ActiveCall {
  return {
    callId: "call_1",
    streamId: "stream_1",
    rootStreamId: "stream_1",
    mode: "video",
    participantCount: 1,
    ...overrides,
  }
}

beforeEach(() => __resetActiveCallsStore())

describe("active-calls-store", () => {
  it("seed then read a live call by id", () => {
    seedActiveCalls("ws_1", [call()])
    expect(getActiveCall("ws_1", "call_1")?.mode).toBe("video")
  })

  it("re-seed REPLACES the set, dropping a call whose end signal was missed (INV-53)", () => {
    seedActiveCalls("ws_1", [call({ callId: "call_1" }), call({ callId: "call_2" })])
    seedActiveCalls("ws_1", [call({ callId: "call_2" })])
    expect(getActiveCall("ws_1", "call_1")).toBeNull()
    expect(getActiveCall("ws_1", "call_2")).not.toBeNull()
  })

  it("upsert adds a live call; remove clears it", () => {
    upsertActiveCall("ws_1", call())
    expect(getActiveCall("ws_1", "call_1")).not.toBeNull()
    removeActiveCall("ws_1", "call_1")
    expect(getActiveCall("ws_1", "call_1")).toBeNull()
  })

  it("participants_changed refines the joined roster + count", () => {
    upsertActiveCall("ws_1", call({ participantCount: 1 }))
    updateCallParticipants("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      participantCount: 2,
      participantUserIds: ["usr_a", "usr_b"],
    })
    const entry = getActiveCall("ws_1", "call_1")
    expect(entry?.participantCount).toBe(2)
    expect(entry?.participantUserIds).toEqual(["usr_a", "usr_b"])
  })

  it("participants_changed for an unknown call is a no-op — never fabricates a live entry", () => {
    // A late roster event for a call the store isn't tracking (already ended /
    // removed) must not resurrect it — the seed/upsert paths own creation.
    updateCallParticipants("ws_1", {
      callId: "call_ghost",
      streamId: "stream_1",
      participantCount: 2,
      participantUserIds: ["usr_a", "usr_b"],
    })
    expect(getActiveCall("ws_1", "call_ghost")).toBeNull()
  })

  it("re-seed preserves a known roster the workspace seed does not carry", () => {
    // The call is tracked (a `call_started` upsert) and then its roster is refined
    // by a participants_changed, mirroring the live sequence.
    upsertActiveCall("ws_1", call({ participantCount: 1 }))
    updateCallParticipants("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      participantCount: 2,
      participantUserIds: ["usr_a", "usr_b"],
    })
    // A workspace re-seed carries only the count, not the joined UserIds.
    seedActiveCalls("ws_1", [call({ participantCount: 2 })])
    expect(getActiveCall("ws_1", "call_1")?.participantUserIds).toEqual(["usr_a", "usr_b"])
  })
})
