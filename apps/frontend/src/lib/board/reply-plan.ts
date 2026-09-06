import { StreamTypes } from "@threahq/types"

/**
 * The conversation's most-recently-active stream from its board projection: the
 * newest recent-message's own stream (a thread under the root — recency-biased
 * continuation), falling back to the conversation anchor.
 * `recentMessages` is optional-chained because older cached `conversations` IDB
 * rows predate the field. This is the projection-derived answer used where the
 * live message rail isn't loaded (the timeline composer); the conversation panel
 * refines it from its live merged `displayedReplies` once the rail is present.
 */
export function boardPostLastActiveStreamId(post: {
  recentMessages?: readonly { streamId: string }[]
  conversation: { streamId: string }
}): string {
  return post.recentMessages?.at(-1)?.streamId ?? post.conversation.streamId
}

/**
 * Where a board reply lands. Replying from the board joins the conversation, but
 * a conversation that is still a lone message (a fresh post, no back-and-forth)
 * in a channel or DM has no established shape — so the reply converts it into a
 * thread, keeping the parent stream's top level clean (one opener, the exchange
 * underneath) instead of sprouting interleaved flat replies (user ruling):
 *
 *  - **lone message in a channel or DM** (≤1 message, has an opening id) →
 *    `convertToThread`: thread off the opener (it stays in the parent stream as
 *    the thread's root). The reply joins the SAME conversation as a cross-stream
 *    member (root opener + thread reply, one root), so the
 *    board keeps showing one card and the reply renders in place; no card swap.
 *  - **everything else** → flat into the conversation's most-recently-active
 *    stream via the `existing` directive: an established channel/DM conversation
 *    stays where it is, a thread card replies into its thread, a scratchpad stays
 *    flat. A deleted opener (no id) can't be threaded, so it stays flat too.
 */
export type BoardReplyPlan = { kind: "convertToThread"; parentMessageId: string } | { kind: "intoConversation" }

export function planBoardReply(input: {
  hostStreamType: string | undefined
  messageCount: number
  openingMessageId: string | null
}): BoardReplyPlan {
  const threadable = input.hostStreamType === StreamTypes.CHANNEL || input.hostStreamType === StreamTypes.DM
  if (threadable && input.messageCount <= 1 && input.openingMessageId) {
    return { kind: "convertToThread", parentMessageId: input.openingMessageId }
  }
  return { kind: "intoConversation" }
}
