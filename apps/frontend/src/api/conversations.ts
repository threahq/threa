import { api } from "./client"
import type { ConversationWithStaleness, ConversationStatus, Message, BoardPost, BoardPostMessage } from "@threa/types"

export interface ListConversationsParams {
  status?: ConversationStatus
  limit?: number
}

export interface ListWorkspaceConversationsParams extends ListConversationsParams {
  /** Opaque keyset cursor from a prior page's `nextCursor`. */
  cursor?: string
}

export interface WorkspaceConversationsPage {
  posts: BoardPost[]
  nextCursor: string | null
}

export const conversationsApi = {
  /**
   * Cross-stream feed for the workspace board: conversations the viewer can read,
   * newest activity first, keyset-paginated. Access is enforced server-side
   * (INV-62). A non-null `nextCursor` means there's another page.
   */
  async listByWorkspace(
    workspaceId: string,
    params?: ListWorkspaceConversationsParams
  ): Promise<WorkspaceConversationsPage> {
    const searchParams = new URLSearchParams()
    if (params?.status) searchParams.set("status", params.status)
    if (params?.limit) searchParams.set("limit", params.limit.toString())
    if (params?.cursor) searchParams.set("cursor", params.cursor)
    const query = searchParams.toString()
    return api.get<WorkspaceConversationsPage>(
      `/api/workspaces/${workspaceId}/conversations${query ? `?${query}` : ""}`
    )
  },

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
   * The board card's "N more" expand: the full conversation as enriched board
   * post messages (attachments + link previews), so revealed messages render
   * with the same richness as the opening + recent run.
   */
  async getBoardMessages(workspaceId: string, conversationId: string): Promise<BoardPostMessage[]> {
    const res = await api.get<{ messages: BoardPostMessage[] }>(
      `/api/workspaces/${workspaceId}/conversations/${conversationId}/board-messages`
    )
    return res.messages
  },

  /**
   * The board post for a single conversation — backs the conversation side panel
   * (Mechanism B). Used when the panel is opened by id without the board feed
   * having seeded the post (a /s/:id deep-link, or the in-stream conversation
   * list). Board-gated server-side (404 without the flag); 404 when the
   * conversation is gone/empty/cross-workspace.
   */
  async getBoardPost(workspaceId: string, conversationId: string): Promise<BoardPost> {
    const res = await api.get<{ post: BoardPost }>(
      `/api/workspaces/${workspaceId}/conversations/${conversationId}/board-post`
    )
    return res.post
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
