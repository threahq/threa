import { StreamTypes, type SubagentCreatedEventPayload } from "@threa/types"
import type { Querier } from "../../db"
import { StreamEventRepository, type Stream } from "../streams"

/**
 * The conversation a card-anchored thread branches FROM.
 *
 * Board nesting is derived from the stream graph, and that derivation only
 * reaches threads anchored on a member MESSAGE — a thread hanging off a card
 * event has no message to look up, so its conversation renders as a standalone
 * top-level card. A subagent's thread is exactly that shape, so its parent is
 * written down instead: `conversations.parent_conversation_id`, which the board
 * reads as a second source.
 *
 * The id comes off the card's own payload rather than the run row — the run does
 * not store it, and the payload is where the same value was already recorded at
 * create time.
 *
 * Scoped to `subagent:created` on purpose. Delegation result threads share the
 * standalone-card wart and the same column is their natural fix, but that is a
 * behavior change to an existing surface and stays out of this change.
 */
export async function resolveEventAnchoredParentConversationId(
  db: Querier,
  stream: Stream | null | undefined
): Promise<string | undefined> {
  if (!stream || stream.type !== StreamTypes.THREAD) return undefined
  const anchorId = stream.parentAnchorId
  if (!anchorId?.startsWith("event_")) return undefined

  const anchor = await StreamEventRepository.findById(db, anchorId)
  if (anchor?.eventType !== "subagent:created") return undefined
  return (anchor.payload as SubagentCreatedEventPayload).sourceConversationId ?? undefined
}
