import type { Querier } from "../../../db"
import { ConversationStatuses } from "@threa/types"
import { ConversationRepository, type Conversation } from "../../conversations"

/**
 * Resolve the "Current Topic" highlight for a companion turn (agent-runtimes
 * §2.8 Q8): the topic the `conversations` segmenter has placed this turn in,
 * surfaced as best-effort orientation over the contiguous window.
 *
 * Best-effort, never awaited: the segmenter classifies messages asynchronously
 * (debounced, off `message:created`), so this reads only what has been
 * classified SO FAR and degrades to `null` when extraction is behind — it never
 * blocks the turn on it. Plaintext-only by construction: the segmenter
 * short-circuits E2E streams, so an E2E turn always resolves to `null`.
 *
 * Anchoring (Fork 1): prefer the trigger message's own conversation, then fall
 * back to the most recently active topic overlapping the window. The trigger is
 * usually not classified on the turn it fires (extraction lags), so the
 * fallback is the common path; the trigger preference makes the highlight exact
 * once the segmenter catches up.
 */

/** A conversation highlights only while it is unresolved and carries a topic summary. */
function eligibleTopic(conversation: Conversation): string | null {
  if (conversation.status === ConversationStatuses.RESOLVED) return null
  const topic = conversation.topicSummary?.trim()
  return topic ? topic : null
}

export async function loadConversationHighlight(
  db: Querier,
  params: { workspaceId: string; triggerMessageId: string; windowMessageIds: string[] }
): Promise<string | null> {
  const { workspaceId, triggerMessageId, windowMessageIds } = params

  // Prefer the trigger's own conversation when the segmenter has already
  // classified it — exact, but rare on the turn the trigger fires.
  const triggerConversation = await ConversationRepository.findPrimaryByMessageId(db, workspaceId, triggerMessageId)
  if (triggerConversation) {
    const topic = eligibleTopic(triggerConversation)
    if (topic) return topic
  }

  // Fallback: the most recently active topic overlapping the window.
  // `findByMessageIds` returns overlapping conversations ordered by
  // last_activity_at DESC, so the first eligible one is the live topic the
  // window is sitting in.
  if (windowMessageIds.length === 0) return null
  const overlapping = await ConversationRepository.findByMessageIds(db, workspaceId, windowMessageIds)
  for (const conversation of overlapping) {
    const topic = eligibleTopic(conversation)
    if (topic) return topic
  }
  return null
}
