import type { AgentOutcomeSummary, FollowUpOutcomeSummary } from "@threahq/types"
import type { DerivedStreamContext, FollowUpContextItem } from "./types"

/**
 * Map the authoritative outcomes read onto panel items. Like delegations this is
 * NOT derived from the loaded window: a follow-up's status lives in the row and
 * firing emits no event at all, so a window-derived view would show `pending`
 * forever. `sourceMessageId` carries the `agent:follow_up_scheduled` event id so
 * the row's jump lands on the card.
 */
export function followUpContextItems(outcomes: readonly AgentOutcomeSummary[]): FollowUpContextItem[] {
  return outcomes
    .filter((outcome): outcome is FollowUpOutcomeSummary => outcome.kind === "follow_up")
    .map((outcome) => ({
      key: `follow_up:${outcome.id}`,
      category: "follow_up" as const,
      createdAt: outcome.createdAt,
      sourceMessageId: outcome.anchorEventId,
      snippet: "",
      followUpId: outcome.id,
      note: outcome.title,
      status: outcome.status,
      scheduledFor: outcome.scheduledFor,
    }))
}

/**
 * Fold the follow-up items into the window-derived context, preserving the
 * newest-first interleaving and the per-category counts the chips read.
 */
export function withFollowUps(
  derived: DerivedStreamContext,
  followUpItems: FollowUpContextItem[]
): DerivedStreamContext {
  if (followUpItems.length === 0) return derived
  const items = [...derived.items, ...followUpItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return {
    items,
    counts: { ...derived.counts, follow_up: followUpItems.length },
    total: derived.total + followUpItems.length,
  }
}
