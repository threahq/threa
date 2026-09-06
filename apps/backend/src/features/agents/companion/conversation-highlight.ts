import type { Querier } from "../../../db"
import { ConversationStatuses } from "@threahq/types"
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

export interface ResolveEligibleConversationParams {
  workspaceId: string
  /** Prefer this message's own PRIMARY conversation when it passes `isEligible`. */
  preferMessageId: string
  /**
   * Recency-fallback window: when the preferred message isn't eligible, the
   * most recently active conversation overlapping these messages wins
   * (`findByMessageIds` orders by `last_activity_at DESC`).
   */
  windowMessageIds: string[]
  /**
   * Eligibility predicate. The shared prefer→fallback traversal is identical
   * across surfaces (agent-runtimes §2.8 Q8); only what makes a conversation
   * worth surfacing differs — the highlight needs a topic summary, the
   * cross-surface stitch needs member messages — so the caller supplies it.
   */
  isEligible: (conversation: Conversation) => boolean
}

/**
 * Shared resolver for the "which conversation is this turn part of?" question:
 * prefer the anchor message's own conversation, else fall back to the most
 * recently active conversation overlapping the window. Reused by the in-stream
 * highlight and the cross-surface stitch so the anchoring rule lives in one
 * place (INV-35).
 */
export async function resolveEligibleConversation(
  db: Querier,
  params: ResolveEligibleConversationParams
): Promise<Conversation | null> {
  const { workspaceId, preferMessageId, windowMessageIds, isEligible } = params

  // Prefer the anchor message's own conversation when the segmenter has already
  // classified it.
  const preferred = await ConversationRepository.findPrimaryByMessageId(db, workspaceId, preferMessageId)
  if (preferred && isEligible(preferred)) return preferred

  // Fallback: the most recently active conversation overlapping the window.
  // `findByMessageIds` returns overlapping conversations ordered by
  // last_activity_at DESC, so the first eligible one is the live topic.
  if (windowMessageIds.length === 0) return null
  const overlapping = await ConversationRepository.findByMessageIds(db, workspaceId, windowMessageIds)
  for (const conversation of overlapping) {
    if (isEligible(conversation)) return conversation
  }
  return null
}

export async function loadConversationHighlight(
  db: Querier,
  params: { workspaceId: string; triggerMessageId: string; windowMessageIds: string[] }
): Promise<string | null> {
  const conversation = await resolveEligibleConversation(db, {
    workspaceId: params.workspaceId,
    preferMessageId: params.triggerMessageId,
    windowMessageIds: params.windowMessageIds,
    isEligible: (c) => eligibleTopic(c) !== null,
  })
  return conversation ? eligibleTopic(conversation) : null
}
