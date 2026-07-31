import type { Memo, MemoEmbedSummary } from "@threa/types"

/**
 * The card content to stamp onto a `memoEmbed` node at insert time — the same
 * shape the server puts on the message payload, so the card reads one type
 * whichever source it came from.
 *
 * One mapping, shared by the picker and the paste write-back: they insert the
 * same node and a difference between them would show up as a card that changes
 * when the message round-trips.
 */
export function memoEmbedSummary(memo: Memo): MemoEmbedSummary {
  return {
    memoId: memo.id,
    title: memo.title,
    knowledgeType: memo.knowledgeType,
    memoType: memo.memoType,
    tags: memo.tags,
    updatedAt: memo.updatedAt,
  }
}

/**
 * Same mapping from a resolved embed source (which carries no id of its own —
 * the caller holds it). Kept beside {@link memoEmbedSummary} so the shape has
 * one home, not one per caller.
 */
export function memoEmbedSummaryFromResolved(
  memoId: string,
  resolved: {
    title: string
    knowledgeType: Memo["knowledgeType"]
    memoType: Memo["memoType"]
    tags: string[]
    updatedAt: string
  }
): MemoEmbedSummary {
  return {
    memoId,
    title: resolved.title,
    knowledgeType: resolved.knowledgeType,
    memoType: resolved.memoType,
    tags: resolved.tags,
    updatedAt: resolved.updatedAt,
  }
}
