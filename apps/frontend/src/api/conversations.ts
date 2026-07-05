import { api } from "./client"
import type {
  ConversationWithStaleness,
  ConversationStatus,
  BoardLens,
  BoardScopeStreamType,
  Message,
  BoardPost,
  BoardPostMessage,
} from "@threa/types"
import type { ReadStateSnapshot } from "@/sync/read-state"

export interface ListConversationsParams {
  status?: ConversationStatus
  limit?: number
}

export interface ListWorkspaceConversationsParams extends ListConversationsParams {
  /** Structural lens to filter the feed by (`all` = no narrowing; omitted on the wire). */
  lens?: BoardLens
  /** Root-stream scope: only conversations under these streams. */
  streams?: string[]
  /** Root-stream TYPE scope: only conversations whose root is one of these types. */
  types?: BoardScopeStreamType[]
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
    // `all` is the server default — keep the wire clean rather than sending a no-op.
    if (params?.lens && params.lens !== "all") searchParams.set("lens", params.lens)
    if (params?.streams && params.streams.length > 0) searchParams.set("streams", params.streams.join(","))
    if (params?.types && params.types.length > 0) searchParams.set("types", params.types.join(","))
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
   * Mark the conversation read through `throughMessageId` (inclusive). The
   * server expands the cutoff to concrete member-message ids per spanned stream
   * (snapshot semantics — immune to re-clustering) and returns the absolute
   * post-write read state for each touched stream. See
   * docs/sparse-read-overlay-design.md.
   */
  async markRead(
    workspaceId: string,
    conversationId: string,
    throughMessageId: string
  ): Promise<{ streams: ReadStateSnapshot[] }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/read`, { throughMessageId })
  },

  /**
   * Mark the conversation unread from `fromMessageId` (inclusive) onward — the
   * asymmetric inverse of {@link markRead}. Above the watermark this deletes
   * overlay rows; below it the server regresses the watermark. Returns the
   * absolute post-write read state per touched stream.
   */
  async markUnread(
    workspaceId: string,
    conversationId: string,
    fromMessageId: string
  ): Promise<{ streams: ReadStateSnapshot[] }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/unread`, { fromMessageId })
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
