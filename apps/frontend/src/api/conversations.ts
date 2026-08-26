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

/** One proposed topic group from an AI split (see {@link conversationsApi.proposeSplit}). */
export interface SplitGroup {
  title: string
  summary?: string | null
  messageIds: string[]
}

/** A proposed split of one conversation. `groups` is ordered most-central-first
 *  and partitions the conversation; a single group means "no split suggested". */
export interface SplitProposal {
  conversationId: string
  groups: SplitGroup[]
  confidence: number
  reasoning: string | null
}

/** A confirmed group sent back to apply the split. */
export interface SplitGroupInput {
  title: string
  summary?: string
  messageIds: string[]
}

export interface ListWorkspaceConversationsParams extends ListConversationsParams {
  /** Structural lens to filter the feed by (`all` = no narrowing; omitted on the wire). */
  lens?: BoardLens
  /** Root-stream scope: only conversations under these streams. */
  streams?: string[]
  /** Root-stream TYPE scope: only conversations whose root is one of these types. */
  types?: BoardScopeStreamType[]
  /** Stream veto: drop conversations whose anchor or effective root is named. */
  excludeStreams?: string[]
  /** Root-stream TYPE veto. */
  excludeTypes?: BoardScopeStreamType[]
  /** Label scope: only conversations whose anchor/root carries one of the viewer's labels. */
  labels?: string[]
  /** Label veto. */
  excludeLabels?: string[]
  /** Include conversations under archived streams; omitted on the wire when false. */
  showArchived?: boolean
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
    if (params?.excludeStreams && params.excludeStreams.length > 0)
      searchParams.set("excludeStreams", params.excludeStreams.join(","))
    if (params?.excludeTypes && params.excludeTypes.length > 0)
      searchParams.set("excludeTypes", params.excludeTypes.join(","))
    if (params?.labels && params.labels.length > 0) searchParams.set("labels", params.labels.join(","))
    if (params?.excludeLabels && params.excludeLabels.length > 0)
      searchParams.set("excludeLabels", params.excludeLabels.join(","))
    // Hide-archived is the server default — only the opt-in rides the wire.
    if (params?.showArchived) searchParams.set("archived", "true")
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
  async getBoardMessages(
    workspaceId: string,
    conversationId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<BoardPostMessage[]> {
    const res = await api.get<{ messages: BoardPostMessage[] }>(
      `/api/workspaces/${workspaceId}/conversations/${conversationId}/board-messages`,
      options
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
   * post-write read state for each touched stream.
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

  /**
   * "Keep here": confirm a provisionally-placed message belongs in
   * `conversationId`. Settles the row and records the confirmation as
   * extraction feedback; the response carries the conversation's remaining
   * settling set so the mark can fade without waiting for the socket echo.
   */
  async settleMessage(
    workspaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<{
    conversation: ConversationWithStaleness
    previousConversation: null
    settlingMessageIds: string[]
  }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages/${messageId}/settle`)
  },

  /**
   * User correction: reassign a set of selected messages to another conversation.
   * A `targetConversationId` reassigns into that existing conversation; omit it to
   * mint a new one (the split gesture). The backend applies every move in one
   * transaction and records each as boundary-extraction feedback; the response
   * carries the destination and every source that lost messages, so the overlay
   * recolors immediately (the follow-up socket events are idempotent overwrites).
   */
  async reassignMessages(
    workspaceId: string,
    body: { streamId: string; messageIds: string[]; targetConversationId?: string | null }
  ): Promise<{ conversation: ConversationWithStaleness; sourceConversations: ConversationWithStaleness[] }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/reassign-messages`, body)
  },

  /**
   * Ask the clustering model how a conversation should be split into smaller
   * topics. Read-only — returns a proposal for the user to confirm. A single-group
   * proposal means the model judged the conversation focused (no split suggested).
   */
  async proposeSplit(workspaceId: string, conversationId: string): Promise<SplitProposal> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/split-proposal`)
  },

  /**
   * Apply a user-confirmed split: `groups[0]` stays in the source conversation
   * (re-titled), the rest are minted as new titled conversations. The response
   * carries the re-titled source and every minted conversation, so the caches
   * recolor immediately (the follow-up `conversation:*` socket events are
   * idempotent overwrites).
   */
  async applySplit(
    workspaceId: string,
    conversationId: string,
    groups: SplitGroupInput[]
  ): Promise<{ conversation: ConversationWithStaleness; newConversations: ConversationWithStaleness[] }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/split`, { groups })
  },

  /**
   * User edit of a conversation from the board card / panel: rename the topic
   * (`topicSummary`) and/or mark it resolved/reopened (`status`). At least one
   * field required; `status` is limited to `active`/`resolved`.
   */
  async updateConversation(
    workspaceId: string,
    conversationId: string,
    body: { topicSummary?: string; status?: "active" | "resolved" }
  ): Promise<{ conversation: ConversationWithStaleness }> {
    return api.patch(`/api/workspaces/${workspaceId}/conversations/${conversationId}`, body)
  },

  async regenerateTitle(
    workspaceId: string,
    conversationId: string
  ): Promise<{ conversation: ConversationWithStaleness; deferred: false }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/regenerate-title`)
  },

  // Per-viewer board exclusions.
  async hideConversation(workspaceId: string, conversationId: string): Promise<{ hiddenAt: string }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/hide`)
  },

  async unhideConversation(workspaceId: string, conversationId: string): Promise<{ ok: true }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/unhide`)
  },

  async muteStream(workspaceId: string, streamId: string): Promise<{ ok: true }> {
    return api.post(`/api/workspaces/${workspaceId}/streams/${streamId}/board-mute`)
  },

  async unmuteStream(workspaceId: string, streamId: string): Promise<{ ok: true }> {
    return api.post(`/api/workspaces/${workspaceId}/streams/${streamId}/board-unmute`)
  },

  async getBoardExclusions(
    workspaceId: string
  ): Promise<{ hiddenConversations: { conversationId: string; hiddenAt: string }[]; mutedStreamIds: string[] }> {
    return api.get(`/api/workspaces/${workspaceId}/board/exclusions`)
  },

  /**
   * Split a soft thread out of a conversation into its own topic — the board
   * gesture that heals a sub-topic that outgrew its parent. The backend moves the
   * thread's member messages (and any deeper sub-topics') to a freshly minted
   * conversation anchored to the thread and records the correction as
   * boundary-extraction feedback.
   */
  async splitThread(
    workspaceId: string,
    conversationId: string,
    threadStreamId: string
  ): Promise<{ conversation: ConversationWithStaleness; sourceConversation: ConversationWithStaleness }> {
    return api.post(`/api/workspaces/${workspaceId}/conversations/${conversationId}/split-thread`, { threadStreamId })
  },
}
