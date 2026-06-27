import { Pool } from "pg"
import { withClient, withTransaction } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import { AttachmentRepository, toAttachmentSummary } from "../attachments"
import { LinkPreviewRepository, toLinkPreviewSummary } from "../link-previews"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields, type ConversationWithStaleness } from "./staleness"
import { conversationFeedbackId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import { StreamTypes, type AttachmentSummary, type ConversationStatus, type LinkPreviewSummary } from "@threa/types"

export { ConversationWithStaleness }

export interface ListConversationsOptions {
  status?: ConversationStatus
  limit?: number
}

export interface ListWorkspaceConversationsOptions extends ListConversationsOptions {
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
  authorId: string
  authorType: Message["authorType"]
  contentMarkdown: string
  reactions: Record<string, string[]>
  attachments: AttachmentSummary[]
  linkPreviews: LinkPreviewSummary[]
  createdAt: Date
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

    // Resolve each conversation's stream so a thread post can show its true
    // origin: a thread is its own stream, so its `messageIds` are the replies and
    // the originating message lives in the parent stream (`parentMessageId`),
    // never a member of the thread conversation.
    const streamIds = [...new Set(conversations.map((c) => c.streamId))]
    const streamById = new Map(
      (streamIds.length > 0 ? await StreamRepository.findByIds(this.pool, streamIds) : []).map((s) => [s.id, s])
    )

    // Hydrate each post's origin message plus its last few replies so the board
    // renders real post content + reactions, not just a topic line. One batch
    // read over the union of needed ids (INV-56); the access filter already ran
    // in the conversation query, so these ids are all viewer-readable.
    const planByConversation = new Map<
      string,
      { originId: string | undefined; recentIds: string[]; totalReplies: number }
    >()
    const idsToFetch = new Set<string>()
    for (const conversation of conversations) {
      const stream = streamById.get(conversation.streamId)
      const ids = conversation.messageIds
      let originId: string | undefined
      let replyIds: string[]
      if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
        originId = stream.parentMessageId
        replyIds = ids
      } else {
        originId = ids[0]
        replyIds = ids.slice(1)
      }
      const recentIds = replyIds.slice(Math.max(0, replyIds.length - 3))
      planByConversation.set(conversation.id, { originId, recentIds, totalReplies: replyIds.length })
      if (originId) idsToFetch.add(originId)
      for (const id of recentIds) idsToFetch.add(id)
    }
    const ids = [...idsToFetch]
    const messageById: Map<string, Message> =
      ids.length > 0 ? await MessageRepository.findByIds(this.pool, ids) : new Map()
    const hydratedById = await this.hydrateBoardMessages(workspaceId, [...messageById.values()])

    const posts: BoardPost[] = conversations.map((conversation) => {
      const plan = planByConversation.get(conversation.id)!
      const opening = plan.originId ? hydratedById.get(plan.originId) : undefined
      const recentMessages = plan.recentIds
        .map((id) => hydratedById.get(id))
        .filter((m): m is BoardPostMessage => Boolean(m))
      return {
        conversation,
        openingMessage: opening ?? null,
        recentMessages,
        totalReplies: plan.totalReplies,
      }
    })

    // A full page means there may be more; the last row's (activity, id) is the
    // next cursor — matching the repo's `(last_activity_at, id) DESC` order.
    const last = conversations.length === limit ? conversations[conversations.length - 1] : null
    const nextCursor = last ? `${last.lastActivityAt.toISOString()}|${last.id}` : null
    return { posts, nextCursor }
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
    return conversation.messageIds.map((id) => hydratedById.get(id)).filter((m): m is BoardPostMessage => Boolean(m))
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

      // Thread conversations also fan out to the parent channel's subscribers,
      // matching the boundary extractor's event routing; the access-root stream's
      // visibility (INV-62) gates workspace-wide board delivery of the aggregate.
      let parentStreamId: string | undefined
      const stream = await StreamRepository.findById(client, target.streamId)
      let rootStream = stream
      if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
        const parentMessage = await MessageRepository.findById(client, stream.parentMessageId)
        parentStreamId = parentMessage?.streamId
        rootStream = parentMessage ? await StreamRepository.findById(client, parentMessage.streamId) : stream
      }
      const streamVisibility = rootStream?.visibility

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
}

/** Project a full message + its hydrated rich content down to a board post message. */
function toBoardPostMessage(
  message: Message,
  attachments: AttachmentSummary[],
  linkPreviews: LinkPreviewSummary[]
): BoardPostMessage {
  return {
    id: message.id,
    authorId: message.authorId,
    authorType: message.authorType,
    contentMarkdown: message.contentMarkdown,
    reactions: message.reactions,
    attachments,
    linkPreviews,
    createdAt: message.createdAt,
  }
}
