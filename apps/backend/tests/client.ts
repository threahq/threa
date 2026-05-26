/**
 * HTTP client for E2E tests with cookie jar support.
 * Black box testing - treats the API as an external service.
 */

import type { Socket } from "socket.io-client"
import { INTERNAL_API_KEY_HEADER } from "@threa/backend-common"
import {
  WORKSPACE_ROLE_SLUGS,
  type CommandInfo,
  type MoveMessagesToThreadResponse,
  type ValidateMoveMessagesToThreadResponse,
  type WorkspaceInvitableRole,
  type WorkspacePermissionSlug,
} from "@threa/types"

function getBaseUrl(): string {
  // Read at call time, not import time, so setup.ts can set it
  return process.env.TEST_BASE_URL || "http://localhost:3001"
}

function getInternalApiKey(): string {
  return process.env.TEST_INTERNAL_API_KEY || "test-internal-key"
}

export class TestClient {
  private cookies: Map<string, string> = new Map()

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const headers: Record<string, string> = { ...extraHeaders }

    if (body) {
      headers["Content-Type"] = "application/json"
    }

    if (this.cookies.size > 0) {
      headers["Cookie"] = Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    }

    const response = await fetch(`${getBaseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    // Parse Set-Cookie headers
    const setCookies = response.headers.getSetCookie?.() || []
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";")
      const [name, value] = pair.split("=")
      if (name && value) {
        this.cookies.set(name.trim(), value.trim())
      }
    }

    const data = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.text()

    return { status: response.status, data: data as T, headers: response.headers }
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path)
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body)
  }

  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body)
  }

  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body)
  }

  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path)
  }

  /**
   * Upload a file using multipart/form-data.
   */
  async uploadFile<T = unknown>(
    path: string,
    file: { content: string | Buffer; filename: string; mimeType: string }
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const formData = new FormData()
    const blobPart: BlobPart = typeof file.content === "string" ? file.content : Uint8Array.from(file.content)
    const blob = new Blob([blobPart], { type: file.mimeType })
    formData.append("file", blob, file.filename)

    const headers: Record<string, string> = {}
    if (this.cookies.size > 0) {
      headers["Cookie"] = Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    }

    const response = await fetch(`${getBaseUrl()}${path}`, {
      method: "POST",
      headers,
      body: formData,
    })

    // Parse Set-Cookie headers
    const setCookies = response.headers.getSetCookie?.() || []
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";")
      const [name, value] = pair.split("=")
      if (name && value) {
        this.cookies.set(name.trim(), value.trim())
      }
    }

    const data = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.text()

    return { status: response.status, data: data as T, headers: response.headers }
  }

  clearCookies() {
    this.cookies.clear()
  }

  /** Request with internal API key header for inter-service endpoints */
  internalRequest<T = unknown>(method: string, path: string, body?: unknown) {
    return this.request<T>(method, path, body, { [INTERNAL_API_KEY_HEADER]: getInternalApiKey() })
  }
}

// Helpers for common operations
export interface User {
  id: string
  email: string
  name: string
}

export interface Workspace {
  id: string
  name: string
  slug: string
}

export interface Stream {
  id: string
  type: string
  displayName: string | null
  slug: string | null
  description: string | null
  visibility: string
  companionMode: string
  workspaceId: string
}

export interface Message {
  id: string
  contentMarkdown: string
  sequence: string
  authorId: string
  reactions: Record<string, string[]>
  streamId: string
  editedAt: string | null
  createdAt: string
}

export interface StreamEvent {
  id: string
  streamId: string
  sequence: string
  eventType: string
  payload: unknown
  actorId: string | null
  actorType: string | null
  createdAt: string
}

export interface Attachment {
  id: string
  workspaceId: string
  streamId: string | null
  messageId: string | null
  uploadedBy: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  storageProvider: string
  processingStatus: string
  createdAt: string
}

export async function loginAs(client: TestClient, email: string, name: string): Promise<User> {
  const { status, data } = await client.post<{ user: User }>("/api/dev/login", {
    email,
    name,
  })
  if (status !== 200) {
    throw new Error(`Login failed: ${JSON.stringify(data)}`)
  }
  return data.user
}

export async function createWorkspace(client: TestClient, name: string): Promise<Workspace> {
  const { status, data } = await client.post<{ workspace: Workspace }>("/api/workspaces", { name })
  if (status !== 201) {
    throw new Error(`Create workspace failed: ${JSON.stringify(data)}`)
  }
  return data.workspace
}

export async function createStream(
  client: TestClient,
  workspaceId: string,
  type: "scratchpad" | "channel",
  options?: {
    slug?: string
    companionMode?: "off" | "on"
    visibility?: "public" | "private"
  }
): Promise<Stream> {
  const { status, data } = await client.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams`, {
    type,
    ...options,
  })
  if (status !== 201) {
    throw new Error(`Create stream failed: ${JSON.stringify(data)}`)
  }
  return data.stream
}

export async function createScratchpad(
  client: TestClient,
  workspaceId: string,
  companionMode: "off" | "on" = "on"
): Promise<Stream> {
  return createStream(client, workspaceId, "scratchpad", { companionMode })
}

export async function createChannel(
  client: TestClient,
  workspaceId: string,
  slug: string,
  visibility: "public" | "private" = "private"
): Promise<Stream> {
  return createStream(client, workspaceId, "channel", { slug, visibility })
}

export async function listStreams(client: TestClient, workspaceId: string, types?: string[]): Promise<Stream[]> {
  const params = new URLSearchParams()
  if (types) {
    types.forEach((t) => params.append("stream_type", t))
  }
  const query = params.toString() ? `?${params.toString()}` : ""

  const { status, data } = await client.get<{ streams: Stream[] }>(`/api/workspaces/${workspaceId}/streams${query}`)
  if (status !== 200) {
    throw new Error(`List streams failed: ${JSON.stringify(data)}`)
  }
  return data.streams
}

export async function sendMessage(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  content: string
): Promise<Message> {
  const { status, data } = await client.post<{ message: Message }>(`/api/workspaces/${workspaceId}/messages`, {
    streamId,
    content,
  })
  if (status !== 201) {
    throw new Error(`Send message failed: ${JSON.stringify(data)}`)
  }
  return data.message
}

export async function listEvents(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  types?: string[]
): Promise<StreamEvent[]> {
  const params = new URLSearchParams()
  if (types) {
    types.forEach((t) => params.append("type", t))
  }
  const query = params.toString() ? `?${params.toString()}` : ""

  const { status, data } = await client.get<{ events: StreamEvent[] }>(
    `/api/workspaces/${workspaceId}/streams/${streamId}/events${query}`
  )
  if (status !== 200) {
    throw new Error(`List events failed: ${JSON.stringify(data)}`)
  }
  return data.events
}

export async function addReaction(
  client: TestClient,
  workspaceId: string,
  messageId: string,
  emoji: string
): Promise<Message> {
  const { status, data } = await client.post<{ message: Message }>(
    `/api/workspaces/${workspaceId}/messages/${messageId}/reactions`,
    { emoji }
  )
  if (status !== 200) {
    throw new Error(`Add reaction failed: ${JSON.stringify(data)}`)
  }
  return data.message
}

export async function removeReaction(
  client: TestClient,
  workspaceId: string,
  messageId: string,
  emoji: string
): Promise<Message> {
  const { status, data } = await client.delete<{ message: Message }>(
    `/api/workspaces/${workspaceId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
  )
  if (status !== 200) {
    throw new Error(`Remove reaction failed: ${JSON.stringify(data)}`)
  }
  return data.message
}

export async function getStream(client: TestClient, workspaceId: string, streamId: string): Promise<Stream> {
  const { status, data } = await client.get<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams/${streamId}`)
  if (status !== 200) {
    throw new Error(`Get stream failed: ${JSON.stringify(data)}`)
  }
  return data.stream
}

export async function archiveStream(client: TestClient, workspaceId: string, streamId: string): Promise<Stream> {
  const { status, data } = await client.post<{ stream: Stream }>(
    `/api/workspaces/${workspaceId}/streams/${streamId}/archive`
  )
  if (status !== 200) {
    throw new Error(`Archive stream failed: ${JSON.stringify(data)}`)
  }
  return data.stream
}

export async function unarchiveStream(client: TestClient, workspaceId: string, streamId: string): Promise<Stream> {
  const { status, data } = await client.post<{ stream: Stream }>(
    `/api/workspaces/${workspaceId}/streams/${streamId}/unarchive`
  )
  if (status !== 200) {
    throw new Error(`Unarchive stream failed: ${JSON.stringify(data)}`)
  }
  return data.stream
}

export async function updateCompanionMode(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  companionMode: "off" | "on"
): Promise<Stream> {
  const { status, data } = await client.patch<{ stream: Stream }>(
    `/api/workspaces/${workspaceId}/streams/${streamId}/companion`,
    { companionMode }
  )
  if (status !== 200) {
    throw new Error(`Update companion mode failed: ${JSON.stringify(data)}`)
  }
  return data.stream
}

export async function updateMessage(
  client: TestClient,
  workspaceId: string,
  messageId: string,
  content: string
): Promise<Message> {
  const { status, data } = await client.patch<{ message: Message }>(
    `/api/workspaces/${workspaceId}/messages/${messageId}`,
    { content }
  )
  if (status !== 200) {
    throw new Error(`Update message failed: ${JSON.stringify(data)}`)
  }
  return data.message
}

export async function deleteMessage(client: TestClient, workspaceId: string, messageId: string): Promise<void> {
  const { status } = await client.delete(`/api/workspaces/${workspaceId}/messages/${messageId}`)
  if (status !== 204) {
    throw new Error(`Delete message failed with status ${status}`)
  }
}

export async function moveMessagesToThread(
  client: TestClient,
  workspaceId: string,
  sourceStreamId: string,
  targetMessageId: string,
  messageIds: string[]
): Promise<MoveMessagesToThreadResponse> {
  const validation = await validateMoveMessagesToThread(
    client,
    workspaceId,
    sourceStreamId,
    targetMessageId,
    messageIds
  )
  if (validation.status !== 200) {
    throw new Error(`Validate move messages failed: ${JSON.stringify(validation.data)}`)
  }

  const { status, data } = await client.post<MoveMessagesToThreadResponse>(
    `/api/workspaces/${workspaceId}/messages/move-to-thread`,
    {
      sourceStreamId,
      targetMessageId,
      messageIds,
      leaseKey: validation.data.leaseKey,
    }
  )
  if (status !== 200) {
    throw new Error(`Move messages failed: ${JSON.stringify(data)}`)
  }
  return data
}

export async function validateMoveMessagesToThread<T = ValidateMoveMessagesToThreadResponse>(
  client: TestClient,
  workspaceId: string,
  sourceStreamId: string,
  targetMessageId: string,
  messageIds: string[]
): Promise<{ status: number; data: T; headers: Headers }> {
  return client.post<T>(`/api/workspaces/${workspaceId}/messages/move-to-thread/validate`, {
    sourceStreamId,
    targetMessageId,
    messageIds,
  })
}

export async function uploadAttachment(
  client: TestClient,
  workspaceId: string,
  file: { content: string | Buffer; filename: string; mimeType: string }
): Promise<Attachment> {
  const { status, data } = await client.uploadFile<{ attachment: Attachment }>(
    `/api/workspaces/${workspaceId}/attachments`,
    file
  )
  if (status !== 201) {
    throw new Error(`Upload attachment failed: ${JSON.stringify(data)}`)
  }
  return data.attachment
}

export async function getAttachmentDownloadUrl(
  client: TestClient,
  workspaceId: string,
  attachmentId: string
): Promise<string> {
  const { status, data } = await client.get<{ url: string; expiresIn: number }>(
    `/api/workspaces/${workspaceId}/attachments/${attachmentId}/url`
  )
  if (status !== 200) {
    throw new Error(`Get attachment URL failed: ${JSON.stringify(data)}`)
  }
  return data.url
}

export async function deleteAttachment(client: TestClient, workspaceId: string, attachmentId: string): Promise<void> {
  const { status } = await client.delete(`/api/workspaces/${workspaceId}/attachments/${attachmentId}`)
  if (status !== 204) {
    throw new Error(`Delete attachment failed with status ${status}`)
  }
}

export interface Thread extends Stream {
  parentStreamId: string
  parentMessageId: string
}

export async function createThread(
  client: TestClient,
  workspaceId: string,
  parentStreamId: string,
  parentMessageId: string
): Promise<Thread> {
  const { status, data } = await client.post<{ stream: Thread }>(`/api/workspaces/${workspaceId}/streams`, {
    type: "thread",
    parentStreamId,
    parentMessageId,
  })
  if (status !== 201) {
    throw new Error(`Create thread failed: ${JSON.stringify(data)}`)
  }
  return data.stream
}

export interface BootstrapData {
  stream: Stream
  events: StreamEvent[]
  members: StreamMember[]
  membership: { streamId: string; memberId: string; pinned: boolean; notificationLevel: string | null } | null
  latestSequence: string
  hasOlderEvents: boolean
  syncMode: "append" | "replace"
  unreadCount: number
  mentionCount: number
  activityCount: number
  commands?: CommandInfo[]
}

export async function getBootstrap(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  params?: { after?: string }
): Promise<BootstrapData> {
  const searchParams = new URLSearchParams()
  if (params?.after) searchParams.set("after", params.after)
  const { status, data } = await client.get<{ data: BootstrapData }>(
    `/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap${searchParams.toString() ? `?${searchParams}` : ""}`
  )
  if (status !== 200) {
    throw new Error(`Get bootstrap failed: ${JSON.stringify(data)}`)
  }
  return data.data
}

export async function sendMessageWithAttachments(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  content: string,
  attachmentIds: string[]
): Promise<Message> {
  const { status, data } = await client.post<{ message: Message }>(`/api/workspaces/${workspaceId}/messages`, {
    streamId,
    content,
    attachmentIds,
  })
  if (status !== 201) {
    throw new Error(`Send message failed: ${JSON.stringify(data)}`)
  }
  return data.message
}

export interface WorkspaceUser {
  id: string
  workspaceId: string
  workosUserId: string
  email: string
  slug: string
  name: string
  role: string
}

export interface StreamMember {
  streamId: string
  memberId: string
}

export async function joinWorkspace(
  client: TestClient,
  workspaceId: string,
  role: WorkspaceInvitableRole = WORKSPACE_ROLE_SLUGS.MEMBER
): Promise<WorkspaceUser> {
  const { status, data } = await client.post<{ user: WorkspaceUser }>(`/api/dev/workspaces/${workspaceId}/join`, {
    role,
  })
  if (status !== 200) {
    throw new Error(`Join workspace failed: ${JSON.stringify(data)}`)
  }
  if (!data.user) {
    throw new Error(`Join workspace returned no user payload: ${JSON.stringify(data)}`)
  }
  return data.user
}

export async function joinStream(client: TestClient, workspaceId: string, streamId: string): Promise<StreamMember> {
  const { status, data } = await client.post<{ member: StreamMember }>(
    `/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`
  )
  if (status !== 200) {
    throw new Error(`Join stream failed: ${JSON.stringify(data)}`)
  }
  return data.member
}

export interface SearchResult {
  id: string
  streamId: string
  content: string
  authorId: string
  authorType: string
  createdAt: string
  rank: number
}

export interface SearchParams {
  query?: string
  from?: string // Single author ID
  with?: string[] // User IDs (AND logic)
  in?: string[] // Stream IDs
  type?: ("scratchpad" | "channel" | "dm" | "thread")[] // Stream types (OR logic)
  status?: ("active" | "archived")[] // Archive status filter
  before?: string // Exclusive (<)
  after?: string // Inclusive (>=)
  limit?: number
}

export async function search(client: TestClient, workspaceId: string, params: SearchParams): Promise<SearchResult[]> {
  const { status, data } = await client.post<{ results: SearchResult[]; total: number }>(
    `/api/workspaces/${workspaceId}/search`,
    params
  )
  if (status !== 200) {
    throw new Error(`Search failed: ${JSON.stringify(data)}`)
  }
  return data.results
}

export interface Persona {
  id: string
  workspaceId: string | null
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  managedBy: "system" | "workspace"
  status: string
}

export interface EmojiEntry {
  shortcode: string
  emoji: string
  type: "native" | "custom"
  group: string
  order: number
  aliases: string[]
}

export interface WorkspaceBootstrapData {
  workspace: Workspace
  users: WorkspaceUser[]
  streams: Stream[]
  streamMemberships: StreamMember[]
  personas: Persona[]
  emojis: EmojiEntry[]
  emojiWeights: Record<string, number>
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  activityCounts: Record<string, number>
  unreadActivityCount: number
  viewerPermissions: WorkspacePermissionSlug[]
}

export async function getWorkspaceBootstrap(client: TestClient, workspaceId: string): Promise<WorkspaceBootstrapData> {
  const { status, data } = await client.get<{ data: WorkspaceBootstrapData }>(
    `/api/workspaces/${workspaceId}/bootstrap`
  )
  if (status !== 200) {
    throw new Error(`Get workspace bootstrap failed: ${JSON.stringify(data)}`)
  }
  return data.data
}

/**
 * Get the current user's workspace user ID in a workspace.
 * Fetches workspace bootstrap and finds the user matching the given WorkOS user ID.
 */
export async function getUserId(client: TestClient, workspaceId: string, workosUserId: string): Promise<string> {
  const bootstrap = await getWorkspaceBootstrap(client, workspaceId)
  const workspaceUser = bootstrap.users.find((u) => u.workosUserId === workosUserId)
  if (!workspaceUser) {
    throw new Error(`User not found for WorkOS user ${workosUserId} in workspace ${workspaceId}`)
  }
  return workspaceUser.id
}

export interface Conversation {
  id: string
  streamId: string
  workspaceId: string
  messageIds: string[]
  participantIds: string[]
  topicSummary: string | null
  completenessScore: number
  confidence: number
  status: string
  parentConversationId: string | null
  lastActivityAt: string
  createdAt: string
  updatedAt: string
  temporalStaleness: number
  effectiveCompleteness: number
}

export async function listConversations(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  options?: { status?: string; limit?: number }
): Promise<Conversation[]> {
  const params = new URLSearchParams()
  if (options?.status) params.set("status", options.status)
  if (options?.limit) params.set("limit", String(options.limit))
  const query = params.toString() ? `?${params.toString()}` : ""

  const { status, data } = await client.get<{ conversations: Conversation[] }>(
    `/api/workspaces/${workspaceId}/streams/${streamId}/conversations${query}`
  )
  if (status !== 200) {
    throw new Error(`List conversations failed: ${JSON.stringify(data)}`)
  }
  return data.conversations
}

export async function getConversation(
  client: TestClient,
  workspaceId: string,
  conversationId: string
): Promise<Conversation> {
  const { status, data } = await client.get<{ conversation: Conversation }>(
    `/api/workspaces/${workspaceId}/conversations/${conversationId}`
  )
  if (status !== 200) {
    throw new Error(`Get conversation failed: ${JSON.stringify(data)}`)
  }
  return data.conversation
}

export interface DispatchCommandResponse {
  success: boolean
  commandId: string
  command: string
  args: string
  event: StreamEvent
}

export interface CommandDispatchedResponse {
  command: {
    id: string
    name: string
    args: string
    status: string
  }
  event: StreamEvent
}

export async function dispatchCommand(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  command: string
): Promise<DispatchCommandResponse> {
  const { status, data } = await client.post<DispatchCommandResponse>(
    `/api/workspaces/${workspaceId}/commands/dispatch`,
    { command, streamId }
  )
  if (status !== 202) {
    throw new Error(`Dispatch command failed: ${JSON.stringify(data)}`)
  }
  return data
}

export interface BotSummary {
  id: string
  workspaceId: string
  type: "personal" | "shared"
  slug: string | null
  name: string
  ownerUserId: string | null
}

export async function createBot(
  client: TestClient,
  workspaceId: string,
  body: {
    type: "personal" | "shared"
    name: string
    slug?: string
    traits?: string[]
    description?: string | null
    avatarEmoji?: string | null
  }
): Promise<BotSummary> {
  const { status, data } = await client.post<{ data: BotSummary }>(`/api/workspaces/${workspaceId}/bots`, body)
  if (status !== 201) {
    throw new Error(`Create bot failed: ${JSON.stringify(data)}`)
  }
  return data.data
}

export async function createBotKey(
  client: TestClient,
  workspaceId: string,
  botId: string,
  scopes: string[],
  name = "runtime-test"
): Promise<string> {
  const { status, data } = await client.post<{ value: string }>(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, {
    name,
    scopes,
  })
  if (status !== 201) {
    throw new Error(`Create bot key failed: ${JSON.stringify(data)}`)
  }
  return data.value
}

export function botApiPost<T = unknown>(
  client: TestClient,
  workspaceId: string,
  path: string,
  apiKey: string,
  body: unknown
) {
  return client.request<T>("POST", `/api/v1/workspaces/${workspaceId}${path}`, body, {
    Authorization: `Bearer ${apiKey}`,
  })
}

export async function getEmojis(client: TestClient, workspaceId: string): Promise<EmojiEntry[]> {
  const { status, data } = await client.get<{ emojis: EmojiEntry[] }>(`/api/workspaces/${workspaceId}/emojis`)
  if (status !== 200) {
    throw new Error(`Get emojis failed: ${JSON.stringify(data)}`)
  }
  return data.emojis
}

// Raw helpers that return { status, data } for asserting on errors

export function updateStream(client: TestClient, workspaceId: string, streamId: string, body: Record<string, unknown>) {
  return client.patch<unknown>(`/api/workspaces/${workspaceId}/streams/${streamId}`, body)
}

export function addStreamMember(client: TestClient, workspaceId: string, streamId: string, memberId: string) {
  return client.post<unknown>(`/api/workspaces/${workspaceId}/streams/${streamId}/members`, { memberId })
}

export function removeStreamMember(client: TestClient, workspaceId: string, streamId: string, memberId: string) {
  return client.delete<unknown>(`/api/workspaces/${workspaceId}/streams/${streamId}/members/${memberId}`)
}

export function checkSlugAvailable(client: TestClient, workspaceId: string, slug: string, exclude?: string) {
  const params = new URLSearchParams({ slug })
  if (exclude) params.set("exclude", exclude)
  return client.get<{ available: boolean }>(`/api/workspaces/${workspaceId}/streams/slug-available?${params}`)
}

/**
 * Joins a socket.io room with acknowledgment callback.
 * Waits for the server to confirm the join succeeded.
 */
export async function joinRoom(socket: Socket, room: string, timeoutMs: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Socket join timeout for room: ${room}`))
    }, timeoutMs)

    socket.emit("join", room, (result?: { ok?: boolean; error?: string }) => {
      clearTimeout(timeout)
      if (result?.ok) {
        resolve()
        return
      }
      reject(new Error(result?.error || `Failed to join room: ${room}`))
    })
  })
}
