import { botInvocationReactionMetadataSchema, type BotInvocationReactionEvent } from "@threahq/types"

/** Metadata the backend wrote itself: a shape mismatch is corruption, not an empty history. */
export function parseReactionEvents(metadata: Record<string, unknown>): BotInvocationReactionEvent[] {
  return botInvocationReactionMetadataSchema.parse(metadata).reaction.events
}

export function reactionMetadata(events: BotInvocationReactionEvent[]): Record<string, unknown> {
  return { reaction: { events } }
}

export interface ReactionChange {
  action: BotInvocationReactionEvent["action"]
  emoji: string
  reactorId: string
}

/**
 * Every outcome is exactly one repository write. `replace` keeps the pending
 * invocation's `retained` events and appends the change when `append` is set;
 * a withdrawn event replaces without appending.
 */
export type ReactionPlan =
  | { kind: "unchanged" }
  | { kind: "insert" }
  | { kind: "replace"; invocationId: string; retained: BotInvocationReactionEvent[]; append: boolean }
  | { kind: "cancel"; invocationId: string }

function sameReaction(event: BotInvocationReactionEvent, reactorId: string, emoji: string): boolean {
  return event.reactorId === reactorId && event.emoji === emoji
}

/** What the agent has been, or is about to be, told about this reaction: its latest event. */
function latestAction(
  events: BotInvocationReactionEvent[],
  change: ReactionChange
): BotInvocationReactionEvent["action"] | null {
  return events.findLast((event) => sameReaction(event, change.reactorId, change.emoji))?.action ?? null
}

/**
 * What a human's reaction change means for the agent: a change the agent's
 * history already reflects is dropped, a change that undoes an event it has not
 * yet received withdraws that event (cancelling the invocation when nothing is
 * left), and anything else is news that joins the pending invocation or starts one.
 * `delivered` holds the events of every invocation the runtime has taken, oldest
 * first.
 */
export function planReactionChange(
  delivered: BotInvocationReactionEvent[],
  pending: { id: string; events: BotInvocationReactionEvent[] } | null,
  change: ReactionChange
): ReactionPlan {
  const pendingEvents = pending?.events ?? []
  const latest = latestAction([...delivered, ...pendingEvents], change)
  const alreadyReflected = change.action === "added" ? latest === "added" : latest !== "added"
  if (alreadyReflected) return { kind: "unchanged" }
  if (!pending) return { kind: "insert" }

  if (latestAction(pendingEvents, change) !== null) {
    const index = pendingEvents.findLastIndex((event) => sameReaction(event, change.reactorId, change.emoji))
    const retained = pendingEvents.filter((_, position) => position !== index)
    return retained.length === 0
      ? { kind: "cancel", invocationId: pending.id }
      : { kind: "replace", invocationId: pending.id, retained, append: false }
  }
  return { kind: "replace", invocationId: pending.id, retained: pendingEvents, append: true }
}
