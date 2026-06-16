import type { Conversation } from "./repository"

export interface ConversationWithStaleness extends Conversation {
  temporalStaleness: number
  effectiveCompleteness: number
}

/** Staleness from time since last activity, on a 0 (fresh) to 4 (very stale) scale. */
export function computeTemporalStaleness(lastActivityAt: Date): number {
  const hours = (Date.now() - lastActivityAt.getTime()) / (1000 * 60 * 60)
  if (hours < 1) return 0
  if (hours < 4) return 1
  if (hours < 12) return 2
  if (hours < 24) return 3
  return 4
}

/** Combine content completeness with temporal staleness, capped at 7. */
export function computeEffectiveCompleteness(contentScore: number, staleness: number): number {
  return Math.min(7, contentScore + staleness)
}

export function addStalenessFields(conversation: Conversation): ConversationWithStaleness {
  const temporalStaleness = computeTemporalStaleness(conversation.lastActivityAt)
  return {
    ...conversation,
    temporalStaleness,
    effectiveCompleteness: computeEffectiveCompleteness(conversation.completenessScore, temporalStaleness),
  }
}
