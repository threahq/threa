import type { DelegationSummary } from "@threahq/types"
import type { DelegationContextItem, DerivedStreamContext } from "./types"

/**
 * Map the authoritative delegation list onto panel items. Unlike every other
 * category this is NOT derived from the loaded timeline window: a delegation's
 * status lives in `delegation:status_changed` patch events, so a window-derived
 * view freezes out-of-window delegations on stale status — the list endpoint is
 * the authority (`useStreamDelegations`). `sourceMessageId` carries the
 * `delegation:created` event id: the row's jump lands on the card itself.
 */
export function delegationContextItems(delegations: readonly DelegationSummary[]): DelegationContextItem[] {
  return delegations.map((delegation) => ({
    key: `delegation:${delegation.id}`,
    category: "delegation" as const,
    createdAt: delegation.createdAt,
    sourceMessageId: delegation.createdEventId,
    snippet: "",
    delegationId: delegation.id,
    title: delegation.title,
    status: delegation.status,
    claimedByLabel: delegation.claimedByLabel,
    statusNote: delegation.statusNote,
    resultMessageId: delegation.resultMessageId,
  }))
}

/**
 * Fold the delegation items into the window-derived context, preserving the
 * newest-first interleaving and the per-category counts the chips read.
 */
export function withDelegations(
  derived: DerivedStreamContext,
  delegationItems: DelegationContextItem[]
): DerivedStreamContext {
  if (delegationItems.length === 0) return derived
  const items = [...derived.items, ...delegationItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return {
    items,
    counts: { ...derived.counts, delegation: delegationItems.length },
    total: derived.total + delegationItems.length,
  }
}
