import { AGENT_SESSION_EVENT_TYPES, type AgentSessionEventType, type AgentSessionStartedPayload } from "@threa/types"
import type { StreamEvent } from "@threa/types"

/**
 * Agent-session grouping primitives, shared by the timeline (`event-list.tsx`) and
 * the board/conversation projection (`lib/board/board-event-rows.ts`). One
 * definition so the two views group a session the same way — the drift these live
 * in a shared module to avoid. Works on any {@link StreamEvent}-shaped row (the
 * board passes IDB `CachedEvent`s, a structural superset).
 */

export function isAgentSessionEvent(event: Pick<StreamEvent, "eventType">): boolean {
  return AGENT_SESSION_EVENT_TYPES.includes(event.eventType as AgentSessionEventType)
}

export function getSessionId(event: Pick<StreamEvent, "eventType" | "payload">): string | null {
  if (!isAgentSessionEvent(event)) return null
  return (event.payload as { sessionId?: string })?.sessionId ?? null
}

/** Only `agent_session:started` carries the invoking message id. */
export function getTriggerMessageId(event: Pick<StreamEvent, "eventType" | "payload">): string | null {
  if (event.eventType !== "agent_session:started") return null
  return (event.payload as AgentSessionStartedPayload).triggerMessageId ?? null
}

/**
 * A stable key for the row-slot a session occupies. Keyed on the trigger message
 * when known (so a re-run against the same invoking message reuses the slot),
 * else the session id.
 */
export function getSessionSlotKey(sessionId: string, triggerMessageId: string | null): string {
  return triggerMessageId ? `trigger:${triggerMessageId}` : `session:${sessionId}`
}
