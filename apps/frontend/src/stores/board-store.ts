import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedBoardPost } from "@/db"
import type { AttachmentSummary, BoardPost, BoardScopeStreamType, ConversationWithStaleness } from "@threa/types"

/**
 * How many trailing replies a board card previews. Mirrors the backend's
 * `listByWorkspace` projection (service.ts), so an optimistic append caps the
 * same way a refetch would. The single source for this cap — the board card's
 * collapsed slice imports it too.
 */
export const RECENT_PREVIEW_CAP = 3

function lastActivityMs(conversation: { lastActivityAt: string }): number {
  const ms = Date.parse(conversation.lastActivityAt)
  return Number.isNaN(ms) ? 0 : ms
}

function toCached(workspaceId: string, post: BoardPost, status?: "pending"): CachedBoardPost {
  return {
    ...post,
    id: post.conversation.id,
    workspaceId,
    _lastActivityMs: lastActivityMs(post.conversation),
    _cachedAt: Date.now(),
    _status: status,
  }
}

/**
 * Reactive board feed for a workspace, newest activity first — the board's read
 * authority, mirroring how the timeline reads `events` from IDB. A live
 * `conversation:*` merge or an optimistic write re-sorts the feed in place
 * without a refetch. Returns `undefined` until the first IDB read resolves
 * (loading), `[]` when the store is genuinely empty.
 */
export function useBoardPosts(workspaceId: string): CachedBoardPost[] | undefined {
  return useLiveQuery(
    () =>
      db.conversations
        .where("[workspaceId+_lastActivityMs]")
        .between([workspaceId, Dexie.minKey], [workspaceId, Dexie.maxKey])
        .reverse()
        .toArray(),
    [workspaceId]
  )
}

/**
 * One board post from the reactive store, by conversation id — the conversation
 * panel's static projection (opening/recent/streamIds), live-merged in place as
 * the feed reconciles. `undefined` until the first IDB read resolves (loading),
 * `null` once it resolves to no such row (the panel then fetches it by id).
 */
export function useBoardPost(conversationId: string | null): CachedBoardPost | null | undefined {
  return useLiveQuery(async () => {
    if (!conversationId) return null
    return (await db.conversations.get(conversationId)) ?? null
  }, [conversationId])
}

/**
 * Seed the board store from a bootstrap/page fetch (subscribe-then-fetch,
 * INV-53). `bulkPut` upserts the fetched cards without touching rows the page
 * didn't return, so optimistic-pending rows not yet visible to the server
 * survive, and a card the server now returns is reconciled (its `_status`
 * cleared) over any optimistic copy.
 */
export async function seedBoardPosts(workspaceId: string, posts: BoardPost[]): Promise<void> {
  if (posts.length === 0) return
  await db.conversations.bulkPut(posts.map((post) => toCached(workspaceId, post)))
}

/** The known facts about a board post the instant the send returns — enough to
 *  render its card before the `conversation:*` echo carries the full aggregate. */
export interface OptimisticBoardPostInput {
  /** The conversation the backend minted for this post, returned on the send. */
  conversationId: string
  /** The opening message's server id (from the send response). */
  messageId: string
  /** The stream the post was authored into (a channel or DM). */
  streamId: string
  /** The author — the current user. */
  authorId: string
  /** The post body, already serialized to markdown for the card preview. */
  contentMarkdown: string
  /** The stream's effective root (a channel/DM is its own root). */
  rootStreamId: string
  rootStreamType: BoardScopeStreamType
  /** ISO timestamp used for the opening message and the card's activity sort. */
  createdAt: string
  /** The post's uploaded attachments, so the card renders them immediately
   *  instead of popping the thumbnail in when the board-head refetch reconciles. */
  attachments?: AttachmentSummary[]
}

/**
 * Slot an authored board post into the reactive feed, keyed by the conversation
 * id — client-minted up front for a new scratchpad (so the card lands the instant
 * the composer clears, before the promote+send round-trips) or the real id for an
 * existing-stream post (surfaced on the send response). Written `_status:
 * "pending"`; the `conversation:*` echo (`mergeBoardConversation`) and the
 * board-head refetch (`seedBoardPosts`) reconcile it in place by the same id,
 * clearing `_status` with no card swap or flash.
 *
 * Re-callable for the SAME id while pending: the composer-clear seed writes a stub
 * under the draft stream id, then the queue drain calls again post-promotion with
 * the real stream/message ids and server-resolved markdown — both `_status:
 * "pending"`, so the second call refines the first. Only a row the server already
 * reconciled (`_status` cleared) is left untouched, so a live aggregate is never
 * regressed to a pending stub.
 */
export async function putOptimisticBoardPost(workspaceId: string, input: OptimisticBoardPostInput): Promise<void> {
  const conversation: ConversationWithStaleness = {
    id: input.conversationId,
    streamId: input.streamId,
    workspaceId,
    messageIds: [input.messageId],
    participantIds: [input.authorId],
    secondaryMessageIds: [],
    topicSummary: null,
    summary: null,
    completenessScore: 1,
    confidence: 1,
    status: "active",
    parentConversationId: null,
    lastActivityAt: input.createdAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    temporalStaleness: 0,
    effectiveCompleteness: 1,
  }
  const post: BoardPost = {
    conversation,
    openingMessage: {
      id: input.messageId,
      streamId: input.streamId,
      authorId: input.authorId,
      authorType: "user",
      contentMarkdown: input.contentMarkdown,
      reactions: {},
      attachments: input.attachments ?? [],
      linkPreviews: [],
      createdAt: input.createdAt,
      editedAt: null,
    },
    recentMessages: [],
    totalReplies: 0,
    streamIds: [input.streamId],
    hasCapturedMemo: false,
    // The author's own post is trivially theirs — shows on the Mine lens at once.
    isMine: true,
    rootStreamId: input.rootStreamId,
    rootStreamType: input.rootStreamType,
    rootArchived: false,
  }
  await db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(input.conversationId)
    // A row the echo/refetch already reconciled (`_status` cleared) — or any
    // non-pending row — is authoritative; don't regress it. A still-pending stub
    // (our own composer-clear seed) is refined by the drain's post-promotion call.
    if (existing && existing._status !== "pending") return
    await db.conversations.put(toCached(workspaceId, post, "pending"))
  })
}

/**
 * Drop a still-pending optimistic board card — the composer-clear stub of a new
 * scratchpad post whose queued send the user cancelled/deleted before it landed,
 * so the card doesn't linger as a phantom that will never reconcile. Guarded on
 * `_status: "pending"`: a card the send already committed (server-reconciled, or
 * even mid-flight) is never removed by a stale cancel.
 */
export async function deleteOptimisticBoardPost(conversationId: string): Promise<void> {
  await db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(conversationId)
    if (existing?._status === "pending") await db.conversations.delete(conversationId)
  })
}

/**
 * Record a stream a conversation now reaches, from a `conversation:message_assigned`
 * event, onto its board row's `streamIds`. A conversation can span its root + the
 * root's threads (one root — board-view-design.md); the card subscribes to each
 * stream's rail, and a convert-to-thread / cross-stream reply lands in a stream
 * the snapshot didn't list yet. Adding it here lets the card draw that member live
 * without a board refetch. No-op when the card isn't cached or already lists the
 * stream; never creates a row (a card we don't have can't be rendered from this
 * event alone).
 */
export async function addBoardConversationStream(conversationId: string, streamId: string): Promise<void> {
  await db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(conversationId)
    if (!existing) return
    const streamIds = existing.streamIds ?? []
    if (streamIds.includes(streamId)) return
    await db.conversations.put({ ...existing, streamIds: [...streamIds, streamId] })
  })
}

/**
 * Apply a conversation aggregate from a `conversation:*` event onto the board's
 * IDB row: merge the new aggregate (re-sorting on `lastActivityAt`) while
 * keeping the cached preview messages — the event carries the aggregate, not the
 * message bodies. Returns `false` when no row exists yet, so the caller can
 * hydrate a card it cannot render from the event alone.
 */
export async function mergeBoardConversation(
  conversationId: string,
  conversation: ConversationWithStaleness
): Promise<boolean> {
  // Read-modify-write in one rw transaction so a concurrent optimistic write or
  // a second echo can't merge over a stale read of this row.
  return db.transaction("rw", db.conversations, async () => {
    // An emptied conversation is no longer a board card — it mirrors the server's
    // `cardinality(message_ids) > 0` board filter, so a conversation whose last
    // message was reassigned or threaded off (the source of a `threadFromMessage`
    // reply) drops here rather than lingering as a stale card. Report it handled
    // even with no row so the caller doesn't hydrate a card that shouldn't exist.
    // Guard on an EXPLICIT empty array: a payload that omits `messageIds` (a
    // partial/aggregate-only event) is not "known empty" — fall through to upsert.
    if (Array.isArray(conversation.messageIds) && conversation.messageIds.length === 0) {
      await db.conversations.delete(conversationId)
      return true
    }
    const existing = await db.conversations.get(conversationId)
    if (!existing) return false
    await db.conversations.put({
      ...existing,
      conversation,
      _lastActivityMs: lastActivityMs(conversation),
      _cachedAt: Date.now(),
      _status: undefined,
    })
    return true
  })
}
