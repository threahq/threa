import { Pool } from "pg"
import { withClient, withTransaction, type Querier } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository, applySparseRead, applySparseUnread, type ReadStateSnapshot } from "../streams"
import { ActivityRepository } from "../activity"
import { AttachmentRepository, toAttachmentSummary } from "../attachments"
import { LinkPreviewRepository, toLinkPreviewSummary } from "../link-previews"
import { MemoRepository } from "../memos"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields, type ConversationWithStaleness } from "./staleness"
import { resolveConversationDelivery } from "./conversation-delivery"
import { conversationFeedbackId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import {
  StreamTypes,
  type AttachmentSummary,
  type BoardLens,
  type BoardScopeStreamType,
  type ConversationStatus,
  type LinkPreviewSummary,
} from "@threa/types"

export { ConversationWithStaleness }

export interface ListConversationsOptions {
  status?: ConversationStatus
  limit?: number
}

export interface ListWorkspaceConversationsOptions extends ListConversationsOptions {
  /** Structural lens (`all` = no narrowing — the default home shows everything). */
  lens?: BoardLens
  /** Root-stream scope: only conversations under these streams. */
  scopeStreamIds?: string[]
  /** Root-stream TYPE scope: only conversations whose root is one of these types. */
  scopeStreamTypes?: string[]
  /** Keyset cursor from a prior page's `nextCursor` (the last row's activity + id). */
  cursor?: { lastActivityAt: string; id: string }
}

/**
 * Opening message of a board post (internal, Date-typed; serialized to the wire
 * `BoardPostMessage` by the handler). A lean projection of the full message —
 * the fields the post card renders.
 */
export interface BoardPostMessage {
  id: string
  /** The stream this message lives in. A conversation can span its root + the
   * root's threads (one root, board-view-design.md), so each message carries its
   * own origin — the client merges the rails of the streams its members span. */
  streamId: string
  authorId: string
  authorType: Message["authorType"]
  contentMarkdown: string
  reactions: Record<string, string[]>
  attachments: AttachmentSummary[]
  linkPreviews: LinkPreviewSummary[]
  createdAt: Date
  editedAt: Date | null
}

/** A conversation surfaced as a feed post: the grouping, its origin message, and the latest replies. */
export interface BoardPost {
  conversation: ConversationWithStaleness
  /** The post's origin: the conversation's first message, or — for a thread —
   * the parent message in the parent stream that the thread descends from. */
  openingMessage: BoardPostMessage | null
  /** The trailing reply messages (up to 3), chronological. */
  recentMessages: BoardPostMessage[]
  /** Total replies under the origin (excludes the origin). Drives the "N more" gap. */
  totalReplies: number
  /** Distinct streams this post's rendered messages span (opening + recent) — the
   * root and any threads the conversation reaches under it. The client subscribes
   * to each one's rail so a cross-stream member draws live (board-view-design.md). */
  streamIds: string[]
  /** Whether an active memo was captured from this conversation — the Decisions lens signal. */
  hasCapturedMemo: boolean
  /** Whether the requesting viewer authored/participates in or was @-mentioned in this conversation — the Mine lens signal. */
  isMine: boolean
  /** Effective root of the anchor (`COALESCE(root_stream_id, id)`) — the client's stream-scope filter matches on this. */
  rootStreamId: string
  /** That root's type (never `thread`) — the client's stream-type filter matches on this. */
  rootStreamType: BoardScopeStreamType | undefined
}

export interface ReassignMessageParams {
  workspaceId: string
  /** Target conversation that should become the message's primary home. */
  conversationId: string
  messageId: string
  /** The correcting user — recorded with the feedback row. */
  userId: string
}

export interface ReassignMessageResult {
  conversation: ConversationWithStaleness
  /** The conversation the message left, or null if it had no primary before. */
  previousConversation: ConversationWithStaleness | null
}

/**
 * Public interface for querying conversations.
 * Computes temporal staleness on read.
 */
export class ConversationService {
  constructor(private pool: Pool) {}

  async getById(conversationId: string): Promise<ConversationWithStaleness | null> {
    // Single query, INV-30
    const conversation = await ConversationRepository.findById(this.pool, conversationId)
    if (!conversation) return null
    return addStalenessFields(conversation)
  }

  async listByStream(streamId: string, options?: ListConversationsOptions): Promise<ConversationWithStaleness[]> {
    // Single query, INV-30
    const conversations = await ConversationRepository.findByStreamIncludingThreads(this.pool, streamId, options)
    return conversations.map(addStalenessFields)
  }

  /**
   * Cross-stream feed for the workspace board: conversations the viewer can read,
   * newest activity first, keyset-paginated. Access filtering happens in SQL
   * (INV-62), so `userId` is required here unlike the stream-scoped
   * {@link listByStream}. Returns `nextCursor` (opaque `"<iso>|<id>"`) when a full
   * page came back, so the board pages on instead of silently truncating.
   */
  async listByWorkspace(
    workspaceId: string,
    userId: string,
    options?: ListWorkspaceConversationsOptions
  ): Promise<{ posts: BoardPost[]; nextCursor: string | null }> {
    const limit = options?.limit ?? 50
    const rows = await ConversationRepository.findByWorkspaceForViewer(this.pool, workspaceId, userId, {
      ...options,
      limit,
    })
    const conversations = rows.map(addStalenessFields)

    const posts = await this.buildBoardPosts(workspaceId, conversations, userId)

    // A full page means there may be more; the last row's (activity, id) is the
    // next cursor — matching the repo's `(last_activity_at, id) DESC` order.
    const last = conversations.length === limit ? conversations[conversations.length - 1] : null
    const nextCursor = last ? `${last.lastActivityAt.toISOString()}|${last.id}` : null
    return { posts, nextCursor }
  }

  /**
   * The board post for a single conversation — the same projection
   * {@link listByWorkspace} builds per row, for the conversation panel
   * (Mechanism B, board-view-design.md). Access is the caller's responsibility
   * (the handler runs the single-root check, INV-62), matching
   * {@link getBoardMessages}. Returns `null` when the conversation is in another
   * workspace or has no messages (an emptied conversation is no longer a card,
   * mirroring the board feed's `cardinality(message_ids) > 0` filter).
   */
  async getBoardPostById(workspaceId: string, conversationId: string, userId: string): Promise<BoardPost | null> {
    const conversation = await ConversationRepository.findById(this.pool, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId || conversation.messageIds.length === 0) return null
    const [post] = await this.buildBoardPosts(workspaceId, [addStalenessFields(conversation)], userId)
    return post ?? null
  }

  /**
   * Project access-filtered conversations into board posts: resolve each one's
   * origin (a thread's opener lives in the parent stream, not the thread), pick
   * the recent reply window by `createdAt` (not `message_ids` insertion order — a
   * cross-stream attach interleaves the array out of time, board-view-design.md),
   * and hydrate the opening + window with attachments/link previews. Callers must
   * have already enforced access (SQL filter for the feed, single-root check for
   * the single fetch); this does no access work of its own.
   */
  private async buildBoardPosts(
    workspaceId: string,
    conversations: ConversationWithStaleness[],
    userId: string
  ): Promise<BoardPost[]> {
    if (conversations.length === 0) return []

    // Resolve each conversation's stream so a thread post can show its true
    // origin: a thread is its own stream, so its `messageIds` are the replies and
    // the originating message lives in the parent stream (`parentMessageId`),
    // never a member of the thread conversation.
    const streamIds = [...new Set(conversations.map((c) => c.streamId))]
    const streamById = new Map(
      (streamIds.length > 0 ? await StreamRepository.findByIds(this.pool, streamIds) : []).map((s) => [s.id, s])
    )
    // A thread anchor's ROOT row (for `rootStreamType`) isn't among the anchors —
    // fetch the missing roots in one extra batch (INV-56).
    const missingRootIds = [
      ...new Set(
        [...streamById.values()]
          .map((s) => s.rootStreamId)
          .filter((id): id is string => Boolean(id) && !streamById.has(id!))
      ),
    ]
    for (const root of missingRootIds.length > 0 ? await StreamRepository.findByIds(this.pool, missingRootIds) : []) {
      streamById.set(root.id, root)
    }

    // Fetch every member message row (opening + all replies) in one batch
    // (INV-56) so the recent window is chosen by `createdAt`, not by `message_ids`
    // insertion order — a cross-stream attach interleaves the array out of time
    // (board-view-design.md). The access filter already ran in the conversation
    // query, so these ids are viewer-readable. Rich hydration (attachments / link
    // previews) below is then limited to the opening + the chosen window.
    const memberIdsToFetch = new Set<string>()
    for (const conversation of conversations) {
      const stream = streamById.get(conversation.streamId)
      if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) memberIdsToFetch.add(stream.parentMessageId)
      for (const id of conversation.messageIds) memberIdsToFetch.add(id)
    }
    const memberIds = [...memberIdsToFetch]
    const messageById: Map<string, Message> =
      memberIds.length > 0 ? await MessageRepository.findByIds(this.pool, memberIds) : new Map()

    const planByConversation = new Map<
      string,
      { originId: string | undefined; recentIds: string[]; totalReplies: number }
    >()
    const hydrateIds = new Set<string>()
    for (const conversation of conversations) {
      const stream = streamById.get(conversation.streamId)
      let originId: string | undefined
      let replyIds: string[]
      if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
        originId = stream.parentMessageId
        replyIds = conversation.messageIds
      } else {
        originId = conversation.messageIds[0]
        replyIds = conversation.messageIds.slice(1)
      }
      // Chronological by `createdAt`; an id with no fetched row (deleted /
      // unreadable) sinks to the end so it can't claim a recent slot.
      const orderedReplyIds = [...replyIds].sort(
        (a, b) =>
          (messageById.get(a)?.createdAt.getTime() ?? Infinity) - (messageById.get(b)?.createdAt.getTime() ?? Infinity)
      )
      const recentIds = orderedReplyIds.slice(Math.max(0, orderedReplyIds.length - 3))
      planByConversation.set(conversation.id, { originId, recentIds, totalReplies: replyIds.length })
      if (originId) hydrateIds.add(originId)
      for (const id of recentIds) hydrateIds.add(id)
    }
    const hydratedById = await this.hydrateBoardMessages(
      workspaceId,
      [...hydrateIds].map((id) => messageById.get(id)).filter((m): m is Message => Boolean(m))
    )

    // The Decisions/Knowledge lens signal: which of these conversations produced a
    // captured memo. One batch presence read (INV-56); a board-level field, not on
    // the conversation aggregate the `conversation:*` events carry.
    const conversationIdsWithMemos = await MemoRepository.findConversationIdsWithMemos(
      this.pool,
      workspaceId,
      conversations.map((c) => c.id)
    )

    // The Mine lens signal: which of these conversations' primary messages
    // `@`-mentioned the viewer. Participation (`participant_ids`) is checked
    // in-memory below (zero query); only the mention set costs one batched read
    // (INV-56). Pinned to primary `message_ids` — the SAME set the SQL half
    // (`boardLensCondSql` mine branch) tests — so the seed boundary and the
    // rendered `isMine` can't disagree.
    const mentionedMessageIds = await ActivityRepository.findMentionedMessageIds(this.pool, workspaceId, userId, [
      ...new Set(conversations.flatMap((c) => c.messageIds)),
    ])

    const posts: BoardPost[] = conversations.map((conversation) => {
      const plan = planByConversation.get(conversation.id)!
      const opening = plan.originId ? hydratedById.get(plan.originId) : undefined
      const recentMessages = plan.recentIds
        .map((id) => hydratedById.get(id))
        .filter((m): m is BoardPostMessage => Boolean(m))
      // The streams this card's rendered messages span — the conversation's
      // anchor plus any thread an opening/recent message lives in. The client
      // merges these rails so a cross-stream member draws live; new threads added
      // after this snapshot arrive via `conversation:message_assigned`.
      const streamIds = [
        ...new Set([
          conversation.streamId,
          ...(opening ? [opening.streamId] : []),
          ...recentMessages.map((m) => m.streamId),
        ]),
      ]
      const rootStreamId = streamById.get(conversation.streamId)?.rootStreamId ?? conversation.streamId
      return {
        conversation,
        openingMessage: opening ?? null,
        recentMessages,
        totalReplies: plan.totalReplies,
        streamIds,
        hasCapturedMemo: conversationIdsWithMemos.has(conversation.id),
        isMine:
          conversation.participantIds.includes(userId) ||
          conversation.messageIds.some((id) => mentionedMessageIds.has(id)),
        // Effective root of the anchor (and its type) — the client's stream-scope
        // and stream-type filters match on these, mirroring the SQL
        // `COALESCE(root_stream_id, id)` rule.
        rootStreamId,
        // The root row's type is one of the scope grains by construction (a root
        // is never a thread); the cast narrows the broader StreamType.
        rootStreamType: streamById.get(rootStreamId)?.type as BoardScopeStreamType | undefined,
      }
    })

    return posts
  }

  /**
   * Enrich a set of messages with their attachments + completed link previews —
   * the rich content the message row doesn't carry. One batch read each (INV-56).
   * Shared by the board feed and the board's on-expand message fetch so both
   * render the same richness as the timeline.
   */
  private async hydrateBoardMessages(workspaceId: string, messages: Message[]): Promise<Map<string, BoardPostMessage>> {
    const byId = new Map<string, BoardPostMessage>()
    const ids = messages.map((m) => m.id)
    if (ids.length === 0) return byId
    const attachmentsByMessage = await AttachmentRepository.findByMessageIds(this.pool, ids)
    const linkPreviewsByMessage = await LinkPreviewRepository.findByMessageIds(this.pool, workspaceId, ids)
    for (const message of messages) {
      const attachments = (attachmentsByMessage.get(message.id) ?? []).map(toAttachmentSummary)
      const linkPreviews = (linkPreviewsByMessage.get(message.id) ?? [])
        .filter((p) => p.status === "completed")
        .map((p, i) => toLinkPreviewSummary(p, i))
      byId.set(message.id, toBoardPostMessage(message, attachments, linkPreviews))
    }
    return byId
  }

  /**
   * The full conversation as board post messages (enriched with attachments +
   * link previews), in message order — backs the board card's "N more" expand so
   * the revealed middle messages read exactly like the opening + recent run.
   */
  async getBoardMessages(workspaceId: string, conversationId: string): Promise<BoardPostMessage[]> {
    const conversation = await ConversationRepository.findById(this.pool, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId || conversation.messageIds.length === 0) return []
    const messagesMap = await MessageRepository.findByIds(this.pool, conversation.messageIds)
    const ordered = conversation.messageIds.map((id) => messagesMap.get(id)).filter((m): m is Message => Boolean(m))
    const hydratedById = await this.hydrateBoardMessages(workspaceId, ordered)
    // Flattened-chronological across the root + its threads (the conversation can
    // span streams under one root, board-view-design.md): `message_ids` is
    // insertion order, which a cross-stream attach interleaves out of time, so
    // sort by `createdAt` rather than trusting array position.
    return [...hydratedById.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  async listByMessage(workspaceId: string, messageId: string): Promise<ConversationWithStaleness[]> {
    // Single query, INV-30
    const conversations = await ConversationRepository.findByMessageId(this.pool, workspaceId, messageId)
    return conversations.map(addStalenessFields)
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return withClient(this.pool, async (client) => {
      const conversation = await ConversationRepository.findById(client, conversationId)
      if (!conversation || conversation.messageIds.length === 0) return []

      const messagesMap = await MessageRepository.findByIds(client, conversation.messageIds)

      return conversation.messageIds.map((id) => messagesMap.get(id)).filter((m): m is Message => m !== undefined)
    })
  }

  /**
   * User correction: move a message's primary membership to another
   * conversation in the same stream. Applies the move immediately (same
   * repository operations the boundary extractor uses) and records a
   * `conversation_feedback` row as ground truth for improving extraction.
   *
   * Mirrors the boundary extractor's persist phase: message row locked
   * FOR UPDATE before reading the current primary (INV-20), membership
   * arrays + feedback + outbox events all committed in one transaction
   * (INV-7), events delivered via the outbox (INV-4).
   */
  async reassignMessage(params: ReassignMessageParams): Promise<ReassignMessageResult> {
    const { workspaceId, conversationId, messageId, userId } = params

    return withTransaction(this.pool, async (client) => {
      const target = await ConversationRepository.findById(client, conversationId)
      if (!target || target.workspaceId !== workspaceId) {
        throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
      }

      // Lock-then-read in one statement (INV-20): the same row lock that
      // serializes us against concurrent boundary extractions also guarantees
      // the streamId/authorId we validate against can't be changed by a
      // concurrent message move between read and write.
      const message = await MessageRepository.findByIdForUpdate(client, messageId)
      if (!message) {
        throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }
      if (message.streamId !== target.streamId) {
        throw new HttpError("Message does not belong to the conversation's stream", {
          status: 400,
          code: "MESSAGE_NOT_IN_CONVERSATION_STREAM",
        })
      }

      const previous = await ConversationRepository.findPrimaryByMessageId(client, workspaceId, messageId)
      if (previous?.id === target.id) {
        // Already where the user wants it — report current state, record nothing.
        return { conversation: addStalenessFields(target), previousConversation: null }
      }

      if (previous) {
        await ConversationRepository.removePrimaryMessage(client, workspaceId, previous.id, messageId)
        // Moving a conversation's only message out leaves an empty shell that
        // would otherwise stay "active" forever; resolve it. Moving a message
        // back into it (the undo path) reactivates it below.
        await ConversationRepository.resolveIfEmpty(client, workspaceId, previous.id)
      }
      await ConversationRepository.addPrimaryMessage(client, workspaceId, target.id, messageId, message.authorId)
      // Deliberately unconditional, not just for the undo path: a user moving
      // a message into ANY resolved conversation is declaring it has activity
      // again, so it returns to the active lifecycle.
      await ConversationRepository.reactivateIfResolved(client, workspaceId, target.id)

      await ConversationFeedbackRepository.insert(client, {
        id: conversationFeedbackId(),
        workspaceId,
        streamId: message.streamId,
        messageId,
        fromConversationId: previous?.id ?? null,
        toConversationId: target.id,
        userId,
      })

      const touchedIds = previous ? [previous.id, target.id] : [target.id]
      await ConversationRepository.bumpActivityForIds(client, workspaceId, touchedIds)

      // One delivery resolution for every touched conversation is correct here
      // (unlike the boundary extractor, which spans streams): both `previous` and
      // `target` live in the message's stream — the guard above pins `target` to
      // it, and a primary membership is always in the message's own stream — so
      // they share one access-root visibility (INV-62). Routing `previous` by
      // `target`'s stream can't leak because they're the same stream.
      const stream = await StreamRepository.findById(client, target.streamId)
      const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)

      const touched = await ConversationRepository.findByIds(client, workspaceId, touchedIds)
      for (const conv of touched) {
        await OutboxRepository.insert(client, "conversation:updated", {
          workspaceId,
          streamId: conv.streamId,
          conversationId: conv.id,
          conversation: addStalenessFields(conv),
          parentStreamId,
          streamVisibility,
        })
      }

      if (previous) {
        await OutboxRepository.insert(client, "conversation:message_reassigned", {
          workspaceId,
          streamId: message.streamId,
          messageId,
          fromConversationId: previous.id,
          toConversationId: target.id,
          reason: "user_correction",
        })
      } else {
        await OutboxRepository.insert(client, "conversation:message_assigned", {
          workspaceId,
          streamId: message.streamId,
          parentStreamId,
          messageId,
          conversationId: target.id,
          isPrimary: true,
          reason: "user_correction",
        })
      }

      const findTouched = (id: string): Conversation | undefined => touched.find((c) => c.id === id)
      const updatedTarget = findTouched(target.id)
      if (!updatedTarget) {
        // The target row vanished mid-transaction despite the row lock — fail
        // loudly (INV-11) rather than returning stale membership.
        throw new Error(`Conversation ${target.id} disappeared during reassignment`)
      }
      const updatedPrevious = previous ? findTouched(previous.id) : undefined

      return {
        conversation: addStalenessFields(updatedTarget),
        previousConversation: updatedPrevious ? addStalenessFields(updatedPrevious) : null,
      }
    })
  }

  /**
   * Mark a conversation read through `throughMessageId` (inclusive). Read truth is
   * message-granular and stream-anchored (docs/sparse-read-overlay-design.md):
   * the conversation's member messages are snapshotted to concrete ids at write
   * time (immune to later re-clustering), grouped by each message's own stream (a
   * conversation spans root + threads), and applied as a sparse-read overlay per
   * stream — compacting into the watermark where contiguous. One transaction
   * (INV-6), one `stream:read_messages` per touched stream (INV-4/7).
   */
  async markRead(params: {
    workspaceId: string
    conversationId: string
    throughMessageId: string
    userId: string
  }): Promise<{ streams: ReadStateSnapshot[] }> {
    return withTransaction(this.pool, async (client) => {
      const groups = await this.resolveConversationReadTargets(
        client,
        params.workspaceId,
        params.conversationId,
        params.throughMessageId,
        "read"
      )
      const streams: ReadStateSnapshot[] = []
      for (const [streamId, messageIds] of groups) {
        streams.push(
          await applySparseRead(client, {
            workspaceId: params.workspaceId,
            streamId,
            memberId: params.userId,
            messageIds,
          })
        )
      }
      // Message-granular activity coupling: reading these messages clears their
      // activity rows (mention/reply badges) — and only theirs, so the stream's
      // other topics keep their badges. One batched update across all streams.
      await ActivityRepository.markMessagesAsRead(
        client,
        params.workspaceId,
        params.userId,
        groups.flatMap(([, messageIds]) => messageIds)
      )
      return { streams }
    })
  }

  /**
   * Mark a conversation unread from `fromMessageId` (inclusive). Per spanned
   * stream: drop the affected member ids from the overlay and regress the
   * watermark to just before the earliest affected message when it sits at/past
   * it (existing `stream:read_set` semantics, accepting collateral un-reading).
   */
  async markUnread(params: {
    workspaceId: string
    conversationId: string
    fromMessageId: string
    userId: string
  }): Promise<{ streams: ReadStateSnapshot[] }> {
    return withTransaction(this.pool, async (client) => {
      const groups = await this.resolveConversationReadTargets(
        client,
        params.workspaceId,
        params.conversationId,
        params.fromMessageId,
        "unread"
      )
      const streams: ReadStateSnapshot[] = []
      for (const [streamId, messageIds] of groups) {
        streams.push(
          await applySparseUnread(client, {
            workspaceId: params.workspaceId,
            streamId,
            memberId: params.userId,
            messageIds,
          })
        )
      }
      return { streams }
    })
  }

  /**
   * Resolve a conversation's member messages to the concrete ids to apply per
   * stream: `message_ids ∪ secondary_message_ids` plus the thread-anchored
   * opening's parent message, filtered by the target message's `createdAt`
   * (timestamps are the card's cross-stream merge key — sequences aren't
   * comparable across streams). Returns `[streamId, messageIds]` entries in
   * sorted stream-id order so two concurrent conversation-reads take the same
   * per-stream lock order and can't deadlock.
   */
  private async resolveConversationReadTargets(
    client: Querier,
    workspaceId: string,
    conversationId: string,
    targetMessageId: string,
    direction: "read" | "unread"
  ): Promise<Array<[string, string[]]>> {
    const conversation = await ConversationRepository.findById(client, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId) {
      throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
    }

    const memberSet = new Set<string>([...conversation.messageIds, ...conversation.secondaryMessageIds])
    const stream = await StreamRepository.findById(client, conversation.streamId)
    if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
      memberSet.add(stream.parentMessageId)
    }

    const fetchIds = new Set(memberSet)
    fetchIds.add(targetMessageId)
    const messagesMap = await MessageRepository.findByIds(client, [...fetchIds])

    const target = messagesMap.get(targetMessageId)
    if (!target) {
      throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
    }
    const cutoff = target.createdAt.getTime()

    const groups = new Map<string, string[]>()
    for (const id of memberSet) {
      const message = messagesMap.get(id)
      if (!message) continue
      const at = message.createdAt.getTime()
      const include = direction === "read" ? at <= cutoff : at >= cutoff
      if (!include) continue
      const list = groups.get(message.streamId)
      if (list) list.push(id)
      else groups.set(message.streamId, [id])
    }

    // Map keys are unique, so a strict less-than comparator totally orders them.
    return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  }
}

/** Project a full message + its hydrated rich content down to a board post message. */
function toBoardPostMessage(
  message: Message,
  attachments: AttachmentSummary[],
  linkPreviews: LinkPreviewSummary[]
): BoardPostMessage {
  return {
    id: message.id,
    streamId: message.streamId,
    authorId: message.authorId,
    authorType: message.authorType,
    contentMarkdown: message.contentMarkdown,
    reactions: message.reactions,
    attachments,
    linkPreviews,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
  }
}
