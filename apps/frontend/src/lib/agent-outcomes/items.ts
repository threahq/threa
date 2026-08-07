import type { AgentOutcomeKind, AgentOutcomeSummary } from "@threa/types"
import { DELEGATION_STATUS_LABEL, DELEGATION_TERMINAL, delegationStatusPillClass } from "@/lib/delegation-display"
import { FOLLOW_UP_STATUS_LABEL, FOLLOW_UP_TERMINAL, followUpStatusPillClass } from "@/lib/follow-up-display"

/**
 * The render shape both outcome kinds collapse to. The wire carries no display
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
}

export function outcomeAnchorPath(workspaceId: string, outcome: AgentOutcomeSummary): string | null {
  if (!outcome.anchorEventId) return null
  return `/w/${workspaceId}/s/${outcome.streamId}?m=${outcome.anchorEventId}`
}

export function toOutcomeItem(workspaceId: string, outcome: AgentOutcomeSummary): OutcomeItem {
  const settled =
    outcome.kind === "follow_up" ? FOLLOW_UP_TERMINAL.has(outcome.status) : DELEGATION_TERMINAL.has(outcome.status)

  return {
    id: outcome.id,
    kind: outcome.kind,
    streamId: outcome.streamId,
    title: outcome.title,
    statusLabel:
      outcome.kind === "follow_up" ? FOLLOW_UP_STATUS_LABEL[outcome.status] : DELEGATION_STATUS_LABEL[outcome.status],
    statusPillClass:
      outcome.kind === "follow_up"
        ? followUpStatusPillClass(outcome.status)
        : delegationStatusPillClass(outcome.status),
    isSettled: settled,
    occursAt: outcome.occursAt,
    scheduledFor: outcome.scheduledFor,
    claimedByLabel: outcome.claimedByLabel,
    statusNote: outcome.statusNote,
    createdAt: outcome.createdAt,
    statusChangedAt: outcome.statusChangedAt,
    anchorPath: outcomeAnchorPath(workspaceId, outcome),
    canCancel: !settled,
    canRequeue: outcome.kind === "delegation" && outcome.status === "expired",
    canMarkDone: outcome.kind === "delegation" && !settled,
  }
}

export function toOutcomeItems(workspaceId: string, outcomes: AgentOutcomeSummary[]): OutcomeItem[] {
  return outcomes.map((outcome) => toOutcomeItem(workspaceId, outcome))
}
