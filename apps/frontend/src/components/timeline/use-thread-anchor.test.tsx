import { beforeEach, describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ActiveAgentSession } from "@threahq/types"
import { seedAgentActivity, resetAgentActivityStore } from "@/stores/agent-activity-store"
import { useThreadAnchor } from "./use-thread-anchor"

function session(overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession {
  return {
    sessionId: "session_1",
    streamId: "stream_inflight",
    rootStreamId: "stream_1",
    parentAnchorId: "msg_a",
    personaName: "Ariadne",
    startedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => resetAgentActivityStore())

describe("useThreadAnchor", () => {
  it("points reply at the draft panel when no thread exists yet", () => {
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", {}))
    expect(result.current).toEqual({
      effectiveThreadId: undefined,
      draftPanelId: "draft:stream_1:msg_a",
      replyPanelId: "draft:stream_1:msg_a",
    })
  })

  it("points reply at the real thread once a threadId is known", () => {
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", { threadId: "stream_thread" }))
    expect(result.current).toEqual({
      effectiveThreadId: "stream_thread",
      draftPanelId: "draft:stream_1:msg_a",
      replyPanelId: "stream_thread",
    })
  })

  it("falls back to the thread stream an agent session under this anchor is running in", () => {
    seedAgentActivity("ws_1", [session()])
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", {}))
    expect(result.current.effectiveThreadId).toBe("stream_inflight")
    expect(result.current.replyPanelId).toBe("stream_inflight")
  })

  it("ignores a session running in this same stream (it is no thread to link to)", () => {
    seedAgentActivity("ws_1", [session({ streamId: "stream_1", parentAnchorId: null, triggerMessageId: "msg_a" })])
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", {}))
    expect(result.current.effectiveThreadId).toBeUndefined()
    expect(result.current.replyPanelId).toBe("draft:stream_1:msg_a")
  })

  it("keys the draft panel on a card (event) anchor too", () => {
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "event_c", {}))
    expect(result.current.draftPanelId).toBe("draft:stream_1:event_c")
  })
})
