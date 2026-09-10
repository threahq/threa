import { beforeEach, describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ActiveAgentSession } from "@threahq/types"
import { PanelProvider } from "@/contexts"
import { seedAgentActivity, resetAgentActivityStore } from "@/stores/agent-activity-store"
import { useThreadAnchor } from "./use-thread-anchor"

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <PanelProvider>{children}</PanelProvider>
    </MemoryRouter>
  )
}

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
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", {}), { wrapper })
    expect(result.current.effectiveThreadId).toBeUndefined()
    expect(result.current.threadHref).toBeNull()
    expect(result.current.draftPanelUrl).toBe("/w/ws_1?panel=draft%3Astream_1%3Amsg_a")
    expect(result.current.replyUrl).toBe(result.current.draftPanelUrl)
  })

  it("points reply at the real thread once a threadId is known", () => {
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", { threadId: "stream_thread" }), {
      wrapper,
    })
    expect(result.current.effectiveThreadId).toBe("stream_thread")
    expect(result.current.threadHref).toBe("/w/ws_1?panel=stream_thread")
    expect(result.current.replyUrl).toBe(result.current.threadHref)
  })

  it("falls back to the thread stream an agent session under this anchor is running in", () => {
    seedAgentActivity("ws_1", [session()])
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", {}), { wrapper })
    expect(result.current.effectiveThreadId).toBe("stream_inflight")
    expect(result.current.threadHref).toBe("/w/ws_1?panel=stream_inflight")
  })

  it("ignores a session running in this same stream (it is no thread to link to)", () => {
    seedAgentActivity("ws_1", [session({ streamId: "stream_1", parentAnchorId: null, triggerMessageId: "msg_a" })])
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "msg_a", {}), { wrapper })
    expect(result.current.effectiveThreadId).toBeUndefined()
    expect(result.current.threadHref).toBeNull()
  })

  it("keys the draft panel on a card (event) anchor too", () => {
    const { result } = renderHook(() => useThreadAnchor("ws_1", "stream_1", "event_c", {}), { wrapper })
    expect(result.current.draftPanelUrl).toBe("/w/ws_1?panel=draft%3Astream_1%3Aevent_c")
  })
})
