import { describe, expect, test } from "vitest"
import { renderHook } from "@testing-library/react"
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
        null
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
})
