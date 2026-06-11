import { api } from "./client"
import type { ConversationWithStaleness, ConversationStatus, Message } from "@threa/types"

export interface ListConversationsParams {
  status?: ConversationStatus
  limit?: number
}

export const conversationsApi = {
  async listByStream(
    workspaceId: string,
    streamId: string,
    params?: ListConversationsParams
  ): Promise<ConversationWithStaleness[]> {
    const searchParams = new URLSearchParams()
    if (params?.status) searchParams.set("status", params.status)
    if (params?.limit) searchParams.set("limit", params.limit.toString())
    const query = searchParams.toString()
    const res = await api.get<{ conversations: ConversationWithStaleness[] }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/conversations${query ? `?${query}` : ""}`
    )
    return res.conversations
  },

  async getById(workspaceId: string, conversationId: string): Promise<ConversationWithStaleness> {
    const res = await api.get<{ conversation: ConversationWithStaleness }>(
      `/api/workspaces/${workspaceId}/conversations/${conversationId}`
    )
    return res.conversation
  },

  async getMessages(workspaceId: string, conversationId: string): Promise<Message[]> {
    const res = await api.get<{ messages: Message[] }>(
      `/api/workspaces/${workspaceId}/conversations/${conversationId}/messages`
    )
    return res.messages
  },

  /**
   * User correction: make `conversationId` the message's primary conversation.
   * The backend applies the move and records it as boundary-extraction feedback.
   */
  async reassignMessage(
    workspaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<{ conversation: ConversationWithStaleness; previousConversation: ConversationWithStaleness | null }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages/${messageId}/reassign`)
  },
}
