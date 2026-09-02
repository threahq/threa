// Agent outcomes wire contract — the cross-stream read over the three tables
// that hold agent-owned work: `agent_follow_ups`, `delegated_tasks` and
// `subagent_runs`. Separate from
// `StreamContextItem` because outcomes sort on when the work *matters*
// (`occursAt`: a follow-up's firing time, possibly in the future; a delegation's
// last transition), and because the read is authoritative over the tables rather
// than over the projection. No display text crosses the wire (INV-46).

import type { DelegationStatus, FollowUpStatus, SubagentStatus } from "./constants"

export const AGENT_OUTCOME_KINDS = ["follow_up", "delegation", "subagent"] as const
export type AgentOutcomeKind = (typeof AGENT_OUTCOME_KINDS)[number]

export const AGENT_OUTCOME_STATES = ["outstanding", "settled", "all"] as const
export type AgentOutcomeState = (typeof AGENT_OUTCOME_STATES)[number]

/** How a `streams=` scope reads: `tree` also matches each stream's threads, `stream` matches it exactly. */
export const AGENT_OUTCOME_SCOPES = ["stream", "tree"] as const
export type AgentOutcomeScope = (typeof AGENT_OUTCOME_SCOPES)[number]

interface AgentOutcomeBase {
  id: string
  streamId: string
  /** The delegation's or subagent's title, or the follow-up's note. */
  title: string
  /** ISO — the firing time for a follow-up, null otherwise. */
  scheduledFor: string | null
  claimedByLabel: string | null
  statusNote: string | null
  resultMessageId: string | null
  actorType: string
  actorId: string
  createdAt: string
  statusChangedAt: string
  /** ISO sort key: `scheduledFor` for a follow-up, `statusChangedAt` otherwise. */
  occursAt: string
  /** The card event to deep-link: `delegation:created`, `agent:follow_up_scheduled` or `subagent:created`. */
  anchorEventId: string | null
}

export interface FollowUpOutcomeSummary extends AgentOutcomeBase {
  kind: "follow_up"
  status: FollowUpStatus
}

export interface DelegationOutcomeSummary extends AgentOutcomeBase {
  kind: "delegation"
  status: DelegationStatus
}

/**
 * A delegated model run. `statusNote` is a `SubagentFailureReason` CODE, not
 * prose — the client formats it (INV-46).
 */
export interface SubagentOutcomeSummary extends AgentOutcomeBase {
  kind: "subagent"
  status: SubagentStatus
  /**
   * When the delegated model last posted in its thread, from the run's latest
   * status patch. The one fact that separates "working" from "waiting for you",
   * and it lives on the timeline event rather than the run row.
   */
  lastAgentMessageAt: string | null
}

export type AgentOutcomeSummary = FollowUpOutcomeSummary | DelegationOutcomeSummary | SubagentOutcomeSummary

export interface ListAgentOutcomesResponse {
  items: AgentOutcomeSummary[]
  nextCursor: string | null
  /** Whole-scope outstanding total; null when a cursor was supplied or `withCount` was not requested. */
  outstandingCount: number | null
}
