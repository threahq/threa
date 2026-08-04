import { parseBoardDraftKey } from "@/lib/board/draft-keys"
import { boardPostLastActiveStreamId, planBoardReply } from "@/lib/board/reply-plan"

/**
 * Where sending a draft would put the message, and whether that is top level
 * (flat) in that stream. `unknown` is an explicit third state (INV-11): the
 * scope references a conversation this device hasn't cached, so nothing can be
 * claimed about its landing site and the caller decides.
 */
export type DraftLandingSite = { kind: "flat"; streamId: string } | { kind: "nested" } | { kind: "unknown" }

/** The cached board post fields a landing site is derived from. */
export interface LandingSiteBoardPost {
  conversation: { streamId: string; messageIds: string[] }
  openingMessage: { id: string } | null
  recentMessages?: { streamId: string }[]
}

export interface DraftLandingContext {
  /** Stream type (`channel` | `dm` | `thread` | `scratchpad`) by stream id; a missing entry is an uncached stream. */
  streamTypeById: ReadonlyMap<string, string | undefined>
  /** Cached board post by conversation id, for `board:reply:` / `board:branch-reply:` scopes. */
  boardPostByConversationId: ReadonlyMap<string, LandingSiteBoardPost>
}

/**
 * The single authority mapping a draft scope to its landing site. A board reply
 * consults {@link planBoardReply} with the same inputs the card's composer passes
 * at send time, so the lone-message channel/DM conversation — whose reply opens a
 * NEW THREAD off the opener — resolves `nested` rather than flat in the anchor.
 * Everything that lands inside a thread, branch or fork is `nested`; it never
 * shares a flat landing site with anything.
 */
export function resolveDraftLandingSite(scope: string, context: DraftLandingContext): DraftLandingSite {
  if (scope.startsWith("stream:")) {
    const streamId = scope.slice("stream:".length)
    return streamId ? { kind: "flat", streamId } : { kind: "unknown" }
  }
  if (scope.startsWith("thread:")) return { kind: "nested" }

  const board = parseBoardDraftKey(scope)
  if (!board) return { kind: "unknown" }
  if (board.kind === "subtopic" || board.kind === "branch-reply") return { kind: "nested" }

  const post = context.boardPostByConversationId.get(board.conversationId)
  if (!post) return { kind: "unknown" }

  const plan = planBoardReply({
    hostStreamType: context.streamTypeById.get(post.conversation.streamId),
    messageCount: post.conversation.messageIds?.length ?? 0,
    openingMessageId: post.openingMessage?.id ?? null,
  })
  if (plan.kind === "convertToThread") return { kind: "nested" }
  return { kind: "flat", streamId: boardPostLastActiveStreamId(post) }
}
