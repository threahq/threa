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
})
