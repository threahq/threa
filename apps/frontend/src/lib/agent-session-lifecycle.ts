import type { AgentSessionStartedPayload, AgentStepType, StreamEvent } from "@threahq/types"

export interface RunningAgentSessionEvent {
  sessionId: string
  personaName: string
  triggerMessageId: string
  currentStepType: AgentStepType | null
  stepCount?: number
  messageCount?: number
  startedAt: string
}

export interface AgentSessionLifecycle {
  running: Map<string, RunningAgentSessionEvent>
  terminated: Set<string>
}

export function deriveAgentSessionLifecycle(events: readonly StreamEvent[]): AgentSessionLifecycle {
  const running = new Map<string, RunningAgentSessionEvent>()
  const terminated = new Set<string>()

  for (const event of events) {
    if (event.eventType === "agent_session:started") {
      const payload = event.payload as AgentSessionStartedPayload
      running.set(payload.sessionId, {
        sessionId: payload.sessionId,
        personaName: payload.personaName,
        triggerMessageId: payload.triggerMessageId,
        currentStepType: payload.currentStepType ?? null,
        stepCount: payload.stepCount,
        messageCount: payload.messageCount,
        startedAt: payload.startedAt,
      })
      continue
    }

    if (
      event.eventType === "agent_session:completed" ||
      event.eventType === "agent_session:failed" ||
      event.eventType === "agent_session:deleted"
    ) {
      const payload = event.payload as { sessionId: string }
      terminated.add(payload.sessionId)
    }
  }

  for (const sessionId of terminated) running.delete(sessionId)
  return { running, terminated }
}

export function isAgentSessionLifecycleEvent(event: StreamEvent): boolean {
  return (
    event.eventType === "agent_session:started" ||
    event.eventType === "agent_session:completed" ||
    event.eventType === "agent_session:failed" ||
    event.eventType === "agent_session:deleted"
  )
}
