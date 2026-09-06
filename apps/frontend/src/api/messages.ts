import { api } from "./client"
import type {
  Message,
  MessageVersion,
  CreateMessageInput,
  CreateDmMessageInput,
  UpdateMessageInput,
  MoveMessagesToThreadInput,
  MoveMessagesToThreadResponse,
  ValidateMoveMessagesToThreadInput,
  ValidateMoveMessagesToThreadResponse,
} from "@threahq/types"

export type { CreateMessageInput, CreateDmMessageInput, UpdateMessageInput, MoveMessagesToThreadInput }

export const messageKeys = {
  versions: (workspaceId: string, messageId: string) => ["messageVersions", workspaceId, messageId] as const,
}

export const messagesApi = {
  /**
   * Send a message. Returns the created `message` and — when the send declared a
   * conversation directive (a board post's `intent: "new"`) — the `conversationId`
   * the backend assigned it synchronously, so the board composer can slot an
   * optimistic card keyed by the real id (reconciled by the `conversation:*` echo).
   */
  async create(
    workspaceId: string,
    streamId: string,
    data: CreateMessageInput
  ): Promise<{ message: Message; conversationId?: string }> {
    return api.post<{ message: Message; conversationId?: string }>(`/api/workspaces/${workspaceId}/messages`, {
      ...data,
      streamId,
    })
  },

  async createDm(workspaceId: string, dmUserId: string, data: CreateDmMessageInput): Promise<Message> {
    const res = await api.post<{ message: Message }>(`/api/workspaces/${workspaceId}/messages`, {
      ...data,
      dmUserId,
    })
    return res.message
  },

  async update(workspaceId: string, messageId: string, data: UpdateMessageInput): Promise<Message> {
    const res = await api.patch<{ message: Message }>(`/api/workspaces/${workspaceId}/messages/${messageId}`, data)
    return res.message
  },

  delete(workspaceId: string, messageId: string): Promise<void> {
    return api.delete(`/api/workspaces/${workspaceId}/messages/${messageId}`)
  },

  moveToThread(workspaceId: string, data: MoveMessagesToThreadInput): Promise<MoveMessagesToThreadResponse> {
    return api.post(`/api/workspaces/${workspaceId}/messages/move-to-thread`, data)
  },

  validateMoveToThread(
    workspaceId: string,
    data: ValidateMoveMessagesToThreadInput
  ): Promise<ValidateMoveMessagesToThreadResponse> {
    return api.post(`/api/workspaces/${workspaceId}/messages/move-to-thread/validate`, data)
  },

  addReaction(workspaceId: string, messageId: string, emoji: string): Promise<void> {
    return api.post(`/api/workspaces/${workspaceId}/messages/${messageId}/reactions`, { emoji })
  },

  removeReaction(workspaceId: string, messageId: string, emoji: string): Promise<void> {
    return api.delete(`/api/workspaces/${workspaceId}/messages/${messageId}/reactions/${emoji}`)
  },

  async getVersions(workspaceId: string, messageId: string): Promise<MessageVersion[]> {
    const res = await api.get<{ versions: MessageVersion[] }>(
      `/api/workspaces/${workspaceId}/messages/${messageId}/versions`
    )
    return res.versions
  },
}
