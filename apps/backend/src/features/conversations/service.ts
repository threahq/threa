import { Pool } from "pg"
import { sql, withClient, withTransaction } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields, type ConversationWithStaleness } from "./staleness"
import { conversationFeedbackId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import { StreamTypes, type ConversationStatus } from "@threa/types"

export { ConversationWithStaleness }

export interface ListConversationsOptions {
  status?: ConversationStatus
  limit?: number
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

      // Return messages in the order they appear in the conversation
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

      const message = await MessageRepository.findById(client, messageId)
      if (!message) {
        throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }
      if (message.streamId !== target.streamId) {
        throw new HttpError("Message does not belong to the conversation's stream", {
          status: 400,
          code: "MESSAGE_NOT_IN_CONVERSATION_STREAM",
        })
      }

      // INV-20: serialize with concurrent boundary extractions, which lock the
      // same message row before rewriting its membership.
      await client.query(sql`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`)

      const previous = await ConversationRepository.findPrimaryByMessageId(client, workspaceId, messageId)
      if (previous?.id === target.id) {
        // Already where the user wants it — report current state, record nothing.
        return { conversation: addStalenessFields(target), previousConversation: null }
      }

      if (previous) {
        await ConversationRepository.removePrimaryMessage(client, workspaceId, previous.id, messageId)
      }
      await ConversationRepository.addPrimaryMessage(client, workspaceId, target.id, messageId, message.authorId)

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
