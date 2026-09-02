import type { AgentOutcomeKind, AgentOutcomeSummary } from "@threa/types"
import { DELEGATION_STATUS_LABEL, DELEGATION_TERMINAL, delegationStatusPillClass } from "@/lib/delegation-display"
import { FOLLOW_UP_STATUS_LABEL, FOLLOW_UP_TERMINAL, followUpStatusPillClass } from "@/lib/follow-up-display"
import {
  resolveSubagentCardState,
  subagentFailureLabel,
  subagentStatePillClass,
  SUBAGENT_STATE_LABEL,
  SUBAGENT_TERMINAL,
} from "@/lib/subagent-display"

/**
 * The render shape every outcome kind collapses to. The wire carries no display
 * text (INV-46), so the labels and pill classes come from the two display
 * modules the panel and the timeline cards already share.
 */
export interface OutcomeItem {
  id: string
  kind: AgentOutcomeKind
  streamId: string
  title: string
  statusLabel: string
  statusPillClass: string
  /** Ended one way or another — drives the Outstanding/Settled split and the muted styling. */
  isSettled: boolean
  occursAt: string
  scheduledFor: string | null
  claimedByLabel: string | null
  statusNote: string | null
  createdAt: string
  statusChangedAt: string
  /**
   * Router path to the anchoring timeline card, or null when the join came back
   * empty. Null renders inert — the delegation precedent in `stream-context-row.tsx`
   * (`cardTarget`): a focusable control whose click silently no-ops is worse than
   * plain text.
   */
  anchorPath: string | null
  canCancel: boolean
  canRequeue: boolean
  /** Only a delegation can be closed out by hand; a follow-up has no such affordance. */
  canMarkDone: boolean
}

export const OUTCOME_KIND_LABEL: Record<AgentOutcomeKind, string> = {
  follow_up: "Follow-up",
  delegation: "Delegation",
  subagent: "Subagent",
}

/** The same nouns, plural — filter chips and empty-state copy read this one map. */
export const OUTCOME_KIND_PLURAL: Record<AgentOutcomeKind, string> = {
  follow_up: "Follow-ups",
  delegation: "Delegations",
  subagent: "Subagents",
}

export function outcomeAnchorPath(workspaceId: string, outcome: AgentOutcomeSummary): string | null {
  if (!outcome.anchorEventId) return null
  return `/w/${workspaceId}/s/${outcome.streamId}?m=${outcome.anchorEventId}`
}

/** Status label, pill and settled-ness, per kind. Every kind reads its own display module. */
function statusFace(outcome: AgentOutcomeSummary): { label: string; pillClass: string; settled: boolean } {
  switch (outcome.kind) {
    case "follow_up":
      return {
        label: FOLLOW_UP_STATUS_LABEL[outcome.status],
        pillClass: followUpStatusPillClass(outcome.status),
        settled: FOLLOW_UP_TERMINAL.has(outcome.status),
      }
    case "delegation":
      return {
        label: DELEGATION_STATUS_LABEL[outcome.status],
        pillClass: delegationStatusPillClass(outcome.status),
        settled: DELEGATION_TERMINAL.has(outcome.status),
      }
    case "subagent": {
      // This read carries no live-session signal, so an active run can only
      // resolve to `waiting` (the subagent spoke last) or `starting` — never the
      // animated `working`, which needs a session behind it.
      const state = resolveSubagentCardState({
        status: outcome.status,
        hasLiveSession: false,
        lastAgentMessageAt: outcome.lastAgentMessageAt,
      })
      return {
        label: SUBAGENT_STATE_LABEL[state],
        pillClass: subagentStatePillClass(state),
        settled: SUBAGENT_TERMINAL.has(outcome.status),
      }
    }
  }
}

export function toOutcomeItem(workspaceId: string, outcome: AgentOutcomeSummary): OutcomeItem {
  const face = statusFace(outcome)

  return {
    id: outcome.id,
    kind: outcome.kind,
    streamId: outcome.streamId,
    title: outcome.title,
    statusLabel: face.label,
    statusPillClass: face.pillClass,
    isSettled: face.settled,
    occursAt: outcome.occursAt,
    scheduledFor: outcome.scheduledFor,
    claimedByLabel: outcome.claimedByLabel,
    // A subagent's note is a reason CODE on the wire (INV-46) — words happen here.
    statusNote: outcome.kind === "subagent" ? subagentFailureLabel(outcome.statusNote) : outcome.statusNote,
    createdAt: outcome.createdAt,
    statusChangedAt: outcome.statusChangedAt,
    anchorPath: outcomeAnchorPath(workspaceId, outcome),
    // A subagent's cancel/restart live on its timeline card, which "Open in
    // stream" reaches; wiring a second caller for the same two endpoints here
    // would be a parallel path (INV-37).
    canCancel: outcome.kind !== "subagent" && !face.settled,
    canRequeue: outcome.kind === "delegation" && outcome.status === "expired",
    canMarkDone: outcome.kind === "delegation" && !face.settled,
  }
}

export function toOutcomeItems(workspaceId: string, outcomes: AgentOutcomeSummary[]): OutcomeItem[] {
  return outcomes.map((outcome) => toOutcomeItem(workspaceId, outcome))
}
