import { parseBoardDraftKey } from "@/lib/board/draft-keys"

/** The cached board post fields a home stream is derived from. */
export interface HomeStreamBoardPost {
  conversation: { streamId: string }
}

/** The cached stream fields the pile reads: its root, and (for a thread) the anchor it hangs off. */
export interface HomeStreamRow {
  rootStreamId?: string | null
  parentAnchorId?: string | null
  parentMessageId?: string | null
}

export interface DraftHomeContext {
  /** Cached stream row by id. A missing id is its own root (a scratchpad has no row). */
  streamById: ReadonlyMap<string, HomeStreamRow>
  /** Cached board post by conversation id, for `board:reply:` / `board:branch-reply:` scopes. */
  boardPostByConversationId: ReadonlyMap<string, HomeStreamBoardPost>
  /** Thread anchor id → the stream holding the anchored message, for `thread:` scopes. */
  threadAnchorStreamById: ReadonlyMap<string, { streamId: string }>
}

/** {@link DraftHomeContext} plus what a scope's conversation is resolved from. */
export interface DraftPileContext extends DraftHomeContext {
  /** Message/anchor id → the conversation that contains it. */
  conversationIdByMessageId: ReadonlyMap<string, string>
  /** Branch conversation id → the conversation whose message the branch forks off. */
  parentConversationIdByBranchId: ReadonlyMap<string, string>
}

/**
 * The root stream a draft's message would land under — its "home". Deliberately
 * coarse: everything under one root (the root itself, its threads, the
 * conversations anchored in it) shares a home, and {@link isDraftInHostPile}
 * does the finer work of deciding which of them may see each other. Origin
 * labels read {@link resolveDraftConversation}; adopt-vs-move reads the row's
 * `StashedDraftSource`.
 *
 * `null` means unresolvable — an uncached conversation or an uncached thread
 * anchor — and is never membership (INV-11).
 */
export function resolveDraftHomeStream(scope: string, context: DraftHomeContext): string | null {
  const root = (streamId: string): string => context.streamById.get(streamId)?.rootStreamId ?? streamId

  if (scope.startsWith("stream:")) {
    const streamId = scope.slice("stream:".length)
    return streamId ? root(streamId) : null
  }
  if (scope.startsWith("thread:")) {
    const anchorId = scope.slice("thread:".length)
    const info = anchorId ? context.threadAnchorStreamById.get(anchorId) : undefined
    return info ? root(info.streamId) : null
  }

  const board = parseBoardDraftKey(scope)
  if (!board) return null
  if (board.kind === "subtopic") return root(board.streamId)

  const post = context.boardPostByConversationId.get(board.conversationId)
  return post ? root(post.conversation.streamId) : null
}

/**
 * The conversation a scope's message would belong to, or `null` when it belongs
 * to none (a top-level scope) or the owner isn't cached. Two `null`s are two
 * unknowns, never a match (INV-11) — callers compare only non-null ids.
 *
 * A branch resolves to its PARENT conversation (a branch of C is part of C),
 * falling back to the branch itself so a branch whose parent isn't cached still
 * pairs with its own composer rather than with everything.
 */
export function resolveDraftConversation(scope: string, context: DraftPileContext): string | null {
  if (scope.startsWith("thread:")) {
    const anchorId = scope.slice("thread:".length)
    return anchorId ? (context.conversationIdByMessageId.get(anchorId) ?? null) : null
  }
  if (scope.startsWith("stream:")) {
    const streamId = scope.slice("stream:".length)
    if (!streamId) return null
    const row = context.streamById.get(streamId)
    const anchorId = row?.parentAnchorId ?? row?.parentMessageId
    return anchorId ? (context.conversationIdByMessageId.get(anchorId) ?? null) : null
  }

  const board = parseBoardDraftKey(scope)
  if (!board) return null
  if (board.kind === "reply") return board.conversationId
  if (board.kind === "branch-reply") {
    return context.parentConversationIdByBranchId.get(board.conversationId) ?? board.conversationId
  }
  return context.conversationIdByMessageId.get(board.messageId) ?? null
}

/**
 * Whether writing in this scope is a top-level act in its stream: the root
 * stream's own composer, or a reply to a conversation (which the user could just
 * as well have written top level, including a conversation that has drifted into
 * a thread).
 */
export function isTopLevelDraftScope(scope: string, context: DraftHomeContext): boolean {
  if (scope.startsWith("stream:")) {
    const streamId = scope.slice("stream:".length)
    if (!streamId) return false
    return !context.streamById.get(streamId)?.rootStreamId
  }
  return parseBoardDraftKey(scope)?.kind === "reply"
}

/**
 * Whether draft `d` belongs in host `H`'s pile — "could I have written this
 * here". Same root stream throughout, then any of four membership routes:
 *
 * - **own** — the same scope.
 * - **same conversation** — both resolve to one conversation. Two conversations
 *   never share a pile, which is why the equality is returned rather than
 *   falling through to the routes below.
 * - **top-level draft** — a root-stream or conversation-reply draft is a
 *   plausible alternative from anywhere in the root, threads included.
 * - **top-level host** — the channel composer offers every draft owned by a
 *   conversation in this root (a thread, branch or sub-topic of it included), so
 *   it surfaces there labelled with its conversation.
 *
 * The one thing left out: a draft that belongs to no conversation and is not top
 * level — a draft in a thread that is part of no conversation. It stays in its
 * own scope's pile.
 */
export function isDraftInHostPile(hostScope: string, draftScope: string, context: DraftPileContext): boolean {
  if (draftScope === hostScope) return true

  const home = resolveDraftHomeStream(hostScope, context)
  if (!home || resolveDraftHomeStream(draftScope, context) !== home) return false

  const hostConversationId = resolveDraftConversation(hostScope, context)
  const draftConversationId = resolveDraftConversation(draftScope, context)
  if (hostConversationId && draftConversationId) return hostConversationId === draftConversationId
  if (isTopLevelDraftScope(draftScope, context)) return true
  if (draftConversationId) return isTopLevelDraftScope(hostScope, context)
  return false
}
