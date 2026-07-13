/**
 * Draft-scope keys for the board's inline composers (INV-33: one source of
 * truth). Three surfaces persist drafts under `board:*` scopes, and the drafts
 * explorer parses them back to a location — builders and parser live together
 * so a key format change can't strand rows.
 */

/** Common prefix of every board draft scope — bounds the shared board-drafts
 *  registry's IDB range query (use-scope-draft-preview.ts). */
export const BOARD_DRAFT_SCOPE_PREFIX = "board:"

const REPLY_PREFIX = "board:reply:"
const BRANCH_REPLY_PREFIX = "board:branch-reply:"
const SUBTOPIC_PREFIX = "board:subtopic:"

/** The card/panel bottom "Write a reply…" composer, per conversation. */
export function boardReplyDraftKey(conversationId: string): string {
  return `${REPLY_PREFIX}${conversationId}`
}

/** A nested branch's tail reply composer, per branch conversation. */
export function boardBranchReplyDraftKey(conversationId: string): string {
  return `${BRANCH_REPLY_PREFIX}${conversationId}`
}

/** The "new sub-topic" gesture under a message row. */
export function boardSubtopicDraftKey(streamId: string, messageId: string): string {
  return `${SUBTOPIC_PREFIX}${streamId}:${messageId}`
}

export type ParsedBoardDraftKey =
  | { kind: "reply"; conversationId: string }
  | { kind: "branch-reply"; conversationId: string }
  | { kind: "subtopic"; streamId: string; messageId: string }

export function parseBoardDraftKey(key: string): ParsedBoardDraftKey | null {
  if (key.startsWith(REPLY_PREFIX)) {
    const conversationId = key.slice(REPLY_PREFIX.length)
    return conversationId ? { kind: "reply", conversationId } : null
  }
  if (key.startsWith(BRANCH_REPLY_PREFIX)) {
    const conversationId = key.slice(BRANCH_REPLY_PREFIX.length)
    return conversationId ? { kind: "branch-reply", conversationId } : null
  }
  if (key.startsWith(SUBTOPIC_PREFIX)) {
    const rest = key.slice(SUBTOPIC_PREFIX.length)
    const sep = rest.indexOf(":")
    if (sep <= 0 || sep >= rest.length - 1) return null
    return { kind: "subtopic", streamId: rest.slice(0, sep), messageId: rest.slice(sep + 1) }
  }
  return null
}
