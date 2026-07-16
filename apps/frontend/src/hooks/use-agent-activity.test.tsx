import { beforeEach, describe, expect, test, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { Socket } from "socket.io-client"
import { AuthorTypes, type StreamEvent } from "@threa/types"
import * as contextsModule from "@/contexts"
import { useAgentActivity } from "./use-agent-activity"

let reconnectCount = 0

beforeEach(() => {
  vi.restoreAllMocks()
  reconnectCount = 0
  vi.spyOn(contextsModule, "useSocketReconnectCount").mockImplementation(() => reconnectCount)
})

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

  test("clears socket-only entries on reconnect so a swallowed activity_ended can't strand the indicator", () => {
    const { socket, handlers } = fakeSocket()
    const { result, rerender } = renderHook(() => useAgentActivity([], socket, "ws_test", "usr_test"))

    act(() => {
      handlers.get("agent_session:activity_started")?.({
        sessionId: "asess_1",
        triggerMessageId: "msg_in_thread",
        personaName: "Ariadne",
        threadStreamId: "thread_1",
        parentMessageId: "msg_parent",
      })
    })
    expect(result.current.get("msg_parent")).toBeDefined()

    // Disconnect/reconnect: activity_ended may have been swallowed while the
    // socket was down. The slate resets; a still-running session re-announces
    // itself on its next progress emit.
    reconnectCount = 1
    rerender()
    expect(result.current.get("msg_parent")).toBeUndefined()
    expect(result.current.get("msg_in_thread")).toBeUndefined()
  })

  // The socket is in every member stream's room (sync-engine joins them all for
  // sidebar updates), so a stream-scoped view must not adopt other streams'
  // sessions — without the `streamId` gate the header chip lit up on unrelated
  // streams (caught in live browser QA).
  test("stream-scoped view drops another stream's session but accepts its own", () => {
    const { socket, handlers } = fakeSocket()
    const { result } = renderHook(() => useAgentActivity([], socket, "ws_test", "usr_test", "stream_a"))

    act(() => {
      handlers.get("agent_session:progress")?.({
        workspaceId: "ws_test",
        streamId: "stream_b",
        sessionId: "asess_foreign",
        triggerMessageId: "msg_foreign",
        personaName: "Ariadne",
        stepCount: 4,
        messageCount: 1,
        currentStepType: "thinking",
      })
    })
    expect(result.current.size).toBe(0)

    act(() => {
      handlers.get("agent_session:progress")?.({
        workspaceId: "ws_test",
        streamId: "stream_a",
        sessionId: "asess_own",
        triggerMessageId: "msg_own",
        personaName: "Ariadne",
        stepCount: 1,
        messageCount: 0,
        currentStepType: "thinking",
      })
    })
    expect(result.current.get("msg_own")?.sessionId).toBe("asess_own")
  })

  test("stream-scoped view accepts a thread session only when its parent message is in this view", () => {
    const { socket, handlers } = fakeSocket()
    const parentMessageEvent: StreamEvent = {
      id: "event_m1",
      streamId: "stream_a",
      sequence: "2",
      eventType: "message_created",
      payload: { messageId: "msg_parent" },
      actorId: "usr_test",
      actorType: AuthorTypes.USER,
      createdAt: "2026-05-25T00:00:00.000Z",
    }
    const { result } = renderHook(() =>
      useAgentActivity([parentMessageEvent], socket, "ws_test", "usr_test", "stream_a")
    )

    act(() => {
      handlers.get("agent_session:activity_started")?.({
        sessionId: "asess_1",
        triggerMessageId: "msg_in_thread",
        personaName: "Ariadne",
        threadStreamId: "thread_1",
        parentMessageId: "msg_parent",
      })
      handlers.get("agent_session:activity_started")?.({
        sessionId: "asess_other",
        triggerMessageId: "msg_in_other_thread",
        personaName: "Ariadne",
        threadStreamId: "thread_9",
        parentMessageId: "msg_not_here",
      })
    })

    expect(result.current.get("msg_parent")?.sessionId).toBe("asess_1")
    expect(result.current.get("msg_not_here")).toBeUndefined()
    expect(result.current.get("msg_in_other_thread")).toBeUndefined()
  })

  test("switching the view's stream resets socket-only entries", () => {
    const { socket, handlers } = fakeSocket()
    let streamId = "stream_a"
    const { result, rerender } = renderHook(() => useAgentActivity([], socket, "ws_test", "usr_test", streamId))

    act(() => {
      handlers.get("agent_session:progress")?.({
        workspaceId: "ws_test",
        streamId: "stream_a",
        sessionId: "asess_1",
        triggerMessageId: "msg_1",
        personaName: "Ariadne",
        stepCount: 2,
        messageCount: 0,
        currentStepType: "thinking",
      })
    })
    expect(result.current.get("msg_1")).toBeDefined()

    streamId = "stream_b"
    rerender()
    expect(result.current.size).toBe(0)
  })
})
