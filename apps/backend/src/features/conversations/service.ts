import { Pool } from "pg"
import { withClient } from "../../db"
import { ConversationRepository } from "./repository"
import { MessageRepository, type Message } from "../messaging"
import { addStalenessFields, type ConversationWithStaleness } from "./staleness"
import type { ConversationStatus } from "@threa/types"

export { ConversationWithStaleness }

export interface ListConversationsOptions {
  status?: ConversationStatus
  limit?: number
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
}
