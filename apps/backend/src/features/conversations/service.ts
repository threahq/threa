import { Pool } from "pg"
import { withClient, withTransaction } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import { AttachmentRepository, toAttachmentSummary, type Attachment } from "../attachments"
import { LinkPreviewRepository, toLinkPreviewSummary, type LinkPreview } from "../link-previews"
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

/** A conversation surfaced as a feed post: the grouping, its opening message, and the latest replies. */
export interface BoardPost {
  conversation: ConversationWithStaleness
  openingMessage: BoardPostMessage | null
  recentMessages: BoardPostMessage[]
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

    // Hydrate each post's opening message plus its last few replies so the board
    // renders real post content + reactions, not just a topic line. One batch
    // read over the union of needed ids (INV-56); the access filter already ran
    // in the conversation query, so these ids are all viewer-readable.
    // `findByIds` carries reactions with each message.
    const planByConversation = new Map<string, { openingId: string | undefined; recentIds: string[] }>()
    const idsToFetch = new Set<string>()
    for (const conversation of conversations) {
      const ids = conversation.messageIds
      const openingId = ids[0]
      // Last 3, never including the opening at index 0.
      const recentIds = ids.length > 1 ? ids.slice(Math.max(1, ids.length - 3)) : []
      planByConversation.set(conversation.id, { openingId, recentIds })
      if (openingId) idsToFetch.add(openingId)
      for (const id of recentIds) idsToFetch.add(id)
    }
    const ids = [...idsToFetch]
    const messageById: Map<string, Message> =
      ids.length > 0 ? await MessageRepository.findByIds(this.pool, ids) : new Map()
    // Rich content the message row doesn't carry — attachments (images, files,
    // gallery/download) and completed link previews — keyed by message id so the
    // board renders posts with the same richness as the timeline.
    const attachmentsByMessage: Map<string, Attachment[]> =
      ids.length > 0 ? await AttachmentRepository.findByMessageIds(this.pool, ids) : new Map()
    const linkPreviewsByMessage: Map<string, LinkPreview[]> =
      ids.length > 0 ? await LinkPreviewRepository.findByMessageIds(this.pool, workspaceId, ids) : new Map()

    const buildPostMessage = (message: Message): BoardPostMessage => {
      const attachments = (attachmentsByMessage.get(message.id) ?? []).map(toAttachmentSummary)
      const linkPreviews = (linkPreviewsByMessage.get(message.id) ?? [])
        .filter((p) => p.status === "completed")
        .map((p, i) => toLinkPreviewSummary(p, i))
      return toBoardPostMessage(message, attachments, linkPreviews)
    }

    const posts: BoardPost[] = conversations.map((conversation) => {
      const plan = planByConversation.get(conversation.id)!
      const opening = plan.openingId ? messageById.get(plan.openingId) : undefined
      const recentMessages = plan.recentIds
        .map((id) => messageById.get(id))
        .filter((m): m is Message => Boolean(m))
        .map(buildPostMessage)
      return { conversation, openingMessage: opening ? buildPostMessage(opening) : null, recentMessages }
    })

    // A full page means there may be more; the last row's (activity, id) is the
    // next cursor — matching the repo's `(last_activity_at, id) DESC` order.
    const last = conversations.length === limit ? conversations[conversations.length - 1] : null
    const nextCursor = last ? `${last.lastActivityAt.toISOString()}|${last.id}` : null
    return { posts, nextCursor }
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
      // matching the boundary extractor's event routing.
      let parentStreamId: string | undefined
      const stream = await StreamRepository.findById(client, target.streamId)
      if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
        const parentMessage = await MessageRepository.findById(client, stream.parentMessageId)
        parentStreamId = parentMessage?.streamId
      }

      const touched = await ConversationRepository.findByIds(client, workspaceId, touchedIds)
      for (const conv of touched) {
        await OutboxRepository.insert(client, "conversation:updated", {
          workspaceId,
          streamId: conv.streamId,
          conversationId: conv.id,
          conversation: addStalenessFields(conv),
          parentStreamId,
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
