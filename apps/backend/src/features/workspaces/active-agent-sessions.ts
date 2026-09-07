import type { ActiveAgentSession, AgentStepType } from "@threahq/types"

/** A running session as returned by `AgentSessionRepository.listRunningByWorkspace`. */
export interface RunningSessionRow {
  sessionId: string
  streamId: string
  rootStreamId: string
  parentAnchorId: string | null
  triggerMessageId: string
  personaId: string
  startedAt: Date
  currentStepType: AgentStepType | null
}

/**
 * Project workspace-wide running sessions into the bootstrap's
 * `activeAgentSessions`, dropping any whose sidebar root the viewer can't access
 * (INV-62). `accessibleRootIds` is the viewer's already-access-resolved sidebar
 * stream set, so a session in a private stream / thread of a private stream the
 * viewer isn't a member of is filtered out — its root never appears here.
 * `agentNameById` resolves the persona OR bot display name (the session's
 * `personaId` is one or the other); unknown ids fall back to "Agent".
 */
export function projectActiveAgentSessions(
  runningSessions: RunningSessionRow[],
  accessibleRootIds: ReadonlySet<string>,
  agentNameById: ReadonlyMap<string, string>
): ActiveAgentSession[] {
  return runningSessions
    .filter((session) => accessibleRootIds.has(session.rootStreamId))
    .map((session) => ({
      sessionId: session.sessionId,
      streamId: session.streamId,
      rootStreamId: session.rootStreamId,
      parentAnchorId: session.parentAnchorId,
      triggerMessageId: session.triggerMessageId,
      personaName: agentNameById.get(session.personaId) ?? "Agent",
      startedAt: session.startedAt.toISOString(),
      currentStepType: session.currentStepType,
    }))
}
