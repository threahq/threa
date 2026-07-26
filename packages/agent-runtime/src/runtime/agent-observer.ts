import type { AgentEvent } from "./agent-events"

/**
 * Observes agent runtime events without coupling tracking to execution.
 * Implementations handle DB persistence, analytics, etc.
 */
export interface AgentObserver {
  handle(event: AgentEvent): Promise<void>
  cleanup?(): Promise<void>
}
