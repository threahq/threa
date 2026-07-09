import { describe, expect, test } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { Socket } from "socket.io-client"
import { AuthorTypes, type StreamEvent } from "@threa/types"
import { useAgentActivity } from "./use-agent-activity"

function streamEvent(payload: unknown): StreamEvent {
  return {
    id: "event_1",
    streamId: "stream_1",
    sequence: "1",
    eventType: "agent_session:started",
    payload,
    actorId: "bot_1",
    actorType: AuthorTypes.BOT,
    createdAt: "2026-05-25T00:00:00.000Z",
  }
}

function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler)
      return socket
    },
    off: (event: string) => {
      handlers.delete(event)
      return socket
    },
  } as unknown as Socket
  return { socket, handlers }
}

describe("useAgentActivity", () => {
  test("hydrates running session counts from bootstrapped started events", () => {
    const { result } = renderHook(() =>
      useAgentActivity(
        [
          streamEvent({
            sessionId: "asess_1",
            personaId: "bot_1",
            personaName: "Pi Remote",
            triggerMessageId: "msg_1",
            stepCount: 3,
            messageCount: 1,
            currentStepType: "tool_call",
            startedAt: "2026-05-25T00:00:00.000Z",
          }),
        ],
        null,
        "ws_test",
        "usr_test"
      )
    )

    expect(result.current.get("msg_1")).toMatchObject({
      sessionId: "asess_1",
      personaName: "Pi Remote",
      stepCount: 3,
      messageCount: 1,
      currentStepType: "tool_call",
    })
  })

  test("live activity_started clears bootstrapped currentStepType", () => {
    const { socket, handlers } = fakeSocket()
    const { result } = renderHook(() =>
      useAgentActivity(
        [
          streamEvent({
            sessionId: "asess_1",
            personaId: "bot_1",
            personaName: "Pi Remote",
            triggerMessageId: "msg_1",
            stepCount: 3,
            messageCount: 1,
            currentStepType: "tool_call",
            startedAt: "2026-05-25T00:00:00.000Z",
          }),
        ],
        socket,
        "ws_test",
        "usr_test"
      )
    )

    expect(result.current.get("msg_1")?.currentStepType).toBe("tool_call")

    act(() => {
      handlers.get("agent_session:activity_started")?.({
        sessionId: "asess_1",
        triggerMessageId: "msg_1",
        personaName: "Pi Remote",
      })
    })

    expect(result.current.get("msg_1")).toMatchObject({
      sessionId: "asess_1",
      currentStepType: null,
      stepCount: 0,
      messageCount: 0,
    })
  })

  test("keys in-thread session activity under the thread's parent message for the parent view", () => {
    const { socket, handlers } = fakeSocket()
    // Parent stream view: no session lifecycle events in the events array —
    // the session lives in the thread. Everything arrives via socket.
    const { result } = renderHook(() => useAgentActivity([], socket, "ws_test", "usr_test"))

    act(() => {
      handlers.get("agent_session:activity_started")?.({
        sessionId: "asess_1",
        triggerMessageId: "msg_in_thread",
        personaName: "Ariadne",
        threadStreamId: "thread_1",
        parentMessageId: "msg_parent",
      })
    })

    // Both the trigger message (thread view) and the thread's parent message
    // (parent stream view) resolve to the same activity.
    expect(result.current.get("msg_parent")).toMatchObject({
      sessionId: "asess_1",
      personaName: "Ariadne",
      threadStreamId: "thread_1",
    })
    expect(result.current.get("msg_in_thread")?.sessionId).toBe("asess_1")

    act(() => {
      handlers.get("agent_session:progress")?.({
        workspaceId: "ws_test",
        streamId: "thread_1",
        sessionId: "asess_1",
        triggerMessageId: "msg_in_thread",
        personaName: "Ariadne",
        stepCount: 2,
        messageCount: 0,
        currentStepType: "workspace_search",
        threadStreamId: "thread_1",
        parentMessageId: "msg_parent",
      })
    })
    expect(result.current.get("msg_parent")).toMatchObject({ stepCount: 2, currentStepType: "workspace_search" })

    act(() => {
      handlers.get("agent_session:activity_ended")?.({
        sessionId: "asess_1",
        triggerMessageId: "msg_in_thread",
      })
    })
    expect(result.current.get("msg_parent")).toBeUndefined()
    expect(result.current.get("msg_in_thread")).toBeUndefined()
  })
})
