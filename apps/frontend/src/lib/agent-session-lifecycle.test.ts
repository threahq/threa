import { describe, expect, it } from "vitest"
import type { StreamEvent } from "@threa/types"
import { deriveAgentSessionLifecycle, isAgentSessionLifecycleEvent } from "./agent-session-lifecycle"

function event(eventType: StreamEvent["eventType"], payload: StreamEvent["payload"], sequence: string): StreamEvent {
  return {
    id: `evt_${sequence}`,
    streamId: "stream_1",
    sequence,
    eventType,
    payload,
    actorId: "persona_1",
    actorType: "persona",
    createdAt: `2026-08-27T11:25:${sequence.padStart(2, "0")}.000Z`,
  }
}

describe("deriveAgentSessionLifecycle", () => {
  it("treats completion as terminal for a started session", () => {
    const result = deriveAgentSessionLifecycle([
      event(
        "agent_session:started",
        {
          sessionId: "session_1",
          personaId: "persona_1",
          personaName: "Ariadne",
          triggerMessageId: "msg_1",
          startedAt: "2026-08-27T11:25:00.000Z",
        },
        "1"
      ),
      event(
        "agent_session:completed",
        {
          sessionId: "session_1",
          stepCount: 2,
          messageCount: 1,
          duration: 10_000,
          completedAt: "2026-08-27T11:25:02.000Z",
        },
        "2"
      ),
    ])

    expect({ running: [...result.running.keys()], terminated: [...result.terminated] }).toEqual({
      running: [],
      terminated: ["session_1"],
    })
  })

  it("treats failure and deletion as terminal", () => {
    const result = deriveAgentSessionLifecycle([
      event(
        "agent_session:failed",
        {
          sessionId: "session_failed",
          stepCount: 1,
          error: "failed",
          traceId: "trace_1",
          failedAt: "2026-08-27T11:25:02.000Z",
        },
        "2"
      ),
      event("agent_session:deleted", { sessionId: "session_deleted", deletedAt: "2026-08-27T11:25:03.000Z" }, "3"),
    ])

    expect([...result.terminated]).toEqual(["session_failed", "session_deleted"])
  })

  it("identifies only events that change lifecycle state", () => {
    expect([
      isAgentSessionLifecycleEvent(event("agent_session:started", {}, "1")),
      isAgentSessionLifecycleEvent(event("agent_session:completed", {}, "2")),
      isAgentSessionLifecycleEvent(event("agent_session:failed", {}, "3")),
      isAgentSessionLifecycleEvent(event("agent_session:deleted", {}, "4")),
      isAgentSessionLifecycleEvent(event("agent_session:interrupted", {}, "5")),
      isAgentSessionLifecycleEvent(event("message_created", {}, "6")),
    ]).toEqual([true, true, true, true, false, false])
  })

  it("keeps an interrupted session running while it waits to retry", () => {
    const result = deriveAgentSessionLifecycle([
      event(
        "agent_session:started",
        {
          sessionId: "session_1",
          personaId: "persona_1",
          personaName: "Ariadne",
          triggerMessageId: "msg_1",
          startedAt: "2026-08-27T11:25:00.000Z",
        },
        "1"
      ),
      event(
        "agent_session:interrupted",
        {
          sessionId: "session_1",
          stepCount: 1,
          attempt: 0,
          maxAttempts: 3,
          error: "retry",
          interruptedAt: "2026-08-27T11:25:02.000Z",
        },
        "2"
      ),
    ])

    expect({ running: [...result.running.keys()], terminated: [...result.terminated] }).toEqual({
      running: ["session_1"],
      terminated: [],
    })
  })
})
