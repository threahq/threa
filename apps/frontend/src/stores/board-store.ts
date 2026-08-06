import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedBoardPost } from "@/db"
import { deleteConversationMessages, pruneConversationMessagesToMembership } from "./conversation-messages-store"
import type { AttachmentSummary, BoardPost, BoardScopeStreamType, ConversationWithStaleness } from "@threa/types"
import { mergeConversationByTitleRevision } from "@/lib/title-merge"

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
export function useBoardPosts(workspaceId: string, opts?: { enabled?: boolean }): CachedBoardPost[] | undefined {
  const enabled = opts?.enabled ?? true
  return useLiveQuery(
    // A disabled querier touches no table, so it registers no Dexie
    // subscription and never re-fires on board writes — callers that read the
    // feed conditionally (per-card sibling pickers) pay nothing when off.
    () =>
      enabled
        ? db.conversations
            .where("[workspaceId+_lastActivityMs]")
            .between([workspaceId, Dexie.minKey], [workspaceId, Dexie.maxKey])
            .reverse()
            .toArray()
        : [],
    [workspaceId, enabled]
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

/** Build the `BoardPost` projection an authored post renders from before its
 *  aggregate echoes — shared by the seed and the post-promotion reconcile. */
function buildOptimisticPost(workspaceId: string, input: OptimisticBoardPostInput): BoardPost {
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
  return {
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
    // An authored post is the author's own declaration — never provisional.
    settlingMessageIds: [],
    // The author's own post is trivially theirs — shows on the Mine lens at once.
    isMine: true,
    rootStreamId: input.rootStreamId,
    rootStreamType: input.rootStreamType,
    rootArchived: false,
  }
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
 * Insert-if-absent: it never overwrites an existing row (the echo/refetch won the
 * race, or a new scratchpad's composer-clear stub is already down). The drain's
 * post-promotion refine goes through {@link reconcileOptimisticBoardPost}, which is
 * the only writer allowed to rewrite an existing card's draft ids with the real
 * ones.
 */
export async function putOptimisticBoardPost(workspaceId: string, input: OptimisticBoardPostInput): Promise<void> {
  const post = buildOptimisticPost(workspaceId, input)
  await db.transaction("rw", db.conversations, async () => {
    if (await db.conversations.get(input.conversationId)) return
    await db.conversations.put(toCached(workspaceId, post, "pending"))
  })
}

/**
 * Rewrite a new-scratchpad post's card with its real ids once the send promotes
 * the draft and returns the server message. The composer-clear stub
 * ({@link putOptimisticBoardPost}) carried the DRAFT stream id and the client temp
 * message id; this lands the real stream/message ids + server-resolved markdown so
 * the card deep-links correctly and `openingId === messageIds[0]` (else the flat
 * projection renders the post twice — the stub as opening, the real row as a reply).
 *
 * Three cases, so it's correct under any echo↔drain ordering:
 *  - **No row** — the user cancelled the post mid-send (its card + queued message
 *    were deleted). Do NOT resurrect it.
 *  - **Still pending** — the drain beat the `conversation:created` echo; the stub's
 *    aggregate is synthetic, so replace the card wholesale with the real projection
 *    (still pending; the echo/refetch clears `_status`).
 *  - **Already reconciled** — the echo cleared `_status` first but `mergeBoardConversation`
 *    kept the stub's stale opening. Patch only the authoritative opening + stream
 *    onto it; never regress the echo's real aggregate/recentMessages back to a stub.
 */
export async function reconcileOptimisticBoardPost(
  workspaceId: string,
  input: OptimisticBoardPostInput
): Promise<void> {
  const post = buildOptimisticPost(workspaceId, input)
  await db.transaction("rw", db.conversations, async () => {
    const existing = await db.conversations.get(input.conversationId)
    if (!existing) return
    if (existing._status === "pending") {
      await db.conversations.put(toCached(workspaceId, post, "pending"))
      return
    }
    await db.conversations.put({
      ...existing,
      openingMessage: post.openingMessage,
      rootStreamId: input.rootStreamId,
      rootStreamType: input.rootStreamType,
      conversation: { ...existing.conversation, streamId: input.streamId },
    })
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
  conversation: ConversationWithStaleness,
  /** The event's board-level settling set. `settlingMessageIds` is a BoardPost
   *  field, not part of the aggregate, so it is carried explicitly; `undefined`
   *  (an emitter that doesn't report it) keeps the cached value. */
  settlingMessageIds?: string[]
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
      // A separate table, so it can't join this transaction's scope — run it
      // outside the zone rather than letting Dexie reject a foreign-table write.
      Dexie.ignoreTransaction(() => void deleteConversationMessages(conversationId))
      return true
    }
    const existing = await db.conversations.get(conversationId)
    if (!existing) return false
    // The aggregate names the members but carries no bodies, so the projection
    // snapshots must be reconciled here: a message re-filed OUT of this
    // conversation (`reassignMessage`) must leave `recentMessages`, or a card
    // whose rail hasn't synced keeps rendering the moved row off the stale
    // snapshot until the next board refetch. Removal only — a message re-filed
    // IN has no body in the event; its row fills from the rail or the refetch.
    const memberIds = Array.isArray(conversation.messageIds) ? new Set(conversation.messageIds) : null
    const recentMessages = memberIds
      ? existing.recentMessages.filter((m) => memberIds.has(m.id))
      : existing.recentMessages
    // The backfill store is the other snapshot of these bodies, and the merged
    // view unions it with the rail — prune it on the same event or a re-filed
    // message keeps rendering off a fetch nothing else would ever correct.
    if (memberIds) Dexie.ignoreTransaction(() => void pruneConversationMessagesToMembership(conversationId, memberIds))
    // An opening that moved away can't be patched in place (its replacement's
    // body isn't in the event): merge what's known but report unhandled, so the
    // caller refetches the board head and re-seeds the card with its real new
    // opener — the row stays put meanwhile (no vanish-and-return motion).
    const openingMoved =
      memberIds !== null && existing.openingMessage !== null && !memberIds.has(existing.openingMessage.id)
    const mergedConversation = mergeConversationByTitleRevision(existing.conversation, conversation)
    await db.conversations.put({
      ...existing,
      conversation: mergedConversation,
      recentMessages,
      // A kept cached set is still pruned to the new membership: an event that
      // omits the field but moves a message out must not leave it marked.
      settlingMessageIds:
        settlingMessageIds ??
        (memberIds
          ? (existing.settlingMessageIds ?? []).filter((id) => memberIds.has(id))
          : (existing.settlingMessageIds ?? [])),
      _lastActivityMs: lastActivityMs(conversation),
      _cachedAt: Date.now(),
      _status: undefined,
    })
    return !openingMoved
  })
}

/** Rows of this workspace whose anchor OR effective root is `streamId` — the
 *  anchor-or-root rule the board's own scope filters use. */
async function boardRowsForStream(workspaceId: string, streamId: string): Promise<CachedBoardPost[]> {
  const rows = await db.conversations.where("workspaceId").equals(workspaceId).toArray()
  return rows.filter(
    (row) => (row.rootStreamId ?? row.conversation.streamId) === streamId || row.conversation.streamId === streamId
  )
}

/**
 * Carry a stream's archive state onto the board rows it covers, so archiving a
 * channel drops its cards from the feed (and unarchiving restores them) without
 * waiting for a board refetch. `rootArchived` is the server's per-card verdict
 * the read-side filter gates on.
 */
export async function setBoardRootArchived(workspaceId: string, streamId: string, archived: boolean): Promise<void> {
  await db.transaction("rw", db.conversations, async () => {
    const rows = await boardRowsForStream(workspaceId, streamId)
    const changed = rows.filter((row) => (row.rootArchived === true) !== archived)
    if (changed.length === 0) return
    await db.conversations.bulkPut(changed.map((row) => ({ ...row, rootArchived: archived })))
  })
}

/**
 * Drop the board rows a stream contributes — the viewer lost read access to it,
 * so its cards must not keep rendering off the cache.
 */
export async function removeBoardConversationsForStream(workspaceId: string, streamId: string): Promise<void> {
  await db.transaction("rw", db.conversations, async () => {
    const rows = await boardRowsForStream(workspaceId, streamId)
    if (rows.length === 0) return
    await db.conversations.bulkDelete(rows.map((row) => row.id))
  })
}
