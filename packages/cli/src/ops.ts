import type { ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"
import { enrichConversation, enrichMessages } from "./enrich"
import type { RefResolver } from "./resolver"
import type { TokenStore } from "./token-store"
import {
  CALLBACK_TOKEN_HEADER,
  EXTRACTION_CONTENT_TYPES,
  KNOWLEDGE_TYPES,
  MEMO_SCOPES,
  MEMO_TYPES,
  STREAM_TYPES,
} from "./tools/constants"
import { buildQuery, ToolInputError, type Envelope, type PagedEnvelope } from "./tools/result"

interface Principal {
  kind: string
  [key: string]: unknown
}

export async function whoami(client: ThreaApiClient, config: ThreaConfig): Promise<unknown> {
  const { data } = await client.get<{ data: Principal }>("/me")
  return { principal: data, baseUrl: config.baseUrl, workspaceId: config.workspaceId }
}

export interface ListStreamsParams {
  type?: string[]
  query?: string
  after?: string
  limit?: number
  includeArchived?: boolean
}

export function listStreams(client: ThreaApiClient, p: ListStreamsParams): Promise<unknown> {
  return client.get(
    `/streams${buildQuery({
      type: p.type,
      query: p.query,
      after: p.after,
      limit: p.limit,
      includeArchived: p.includeArchived ? "true" : undefined,
    })}`
  )
}

export interface ReadStreamParams {
  streamId: string
  includeMembers?: boolean
  before?: string
  after?: string
  limit?: number
}

export async function readStream(client: ThreaApiClient, resolver: RefResolver, p: ReadStreamParams): Promise<unknown> {
  const id = encodeURIComponent(await resolver.resolveStream(p.streamId))
  const streamReq = client.get<Envelope<unknown>>(`/streams/${id}`)
  const messagesReq = client.get<PagedEnvelope<unknown>>(
    `/streams/${id}/messages${buildQuery({ before: p.before, after: p.after, limit: p.limit })}`
  )
  const membersReq = p.includeMembers ? client.get<PagedEnvelope<unknown>>(`/streams/${id}/members`) : undefined

  const [streamResp, messagesResp, membersResp] = await Promise.all([
    streamReq,
    messagesReq,
    membersReq ?? Promise.resolve(undefined),
  ])

  const result: Record<string, unknown> = {
    stream: streamResp.data,
    messages: { data: await enrichMessages(messagesResp.data, resolver), hasMore: messagesResp.hasMore ?? false },
  }
  if (membersResp) {
    result.members = {
      data: membersResp.data,
      hasMore: membersResp.hasMore ?? false,
      cursor: membersResp.cursor ?? null,
    }
  }
  return result
}

export interface ListUsersParams {
  query?: string
  after?: string
  limit?: number
}

export function listUsers(client: ThreaApiClient, p: ListUsersParams): Promise<unknown> {
  return client.get(`/users${buildQuery({ query: p.query, after: p.after, limit: p.limit })}`)
}

export interface FindByMetadataParams {
  metadata: Record<string, string>
  streamRef?: string
  limit?: number
}

export async function findMessagesByMetadata(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: FindByMetadataParams
): Promise<unknown> {
  const streamId = p.streamRef ? await resolver.resolveStream(p.streamRef) : undefined
  const response = await client.post<PagedEnvelope<unknown>>("/messages/find-by-metadata", {
    metadata: p.metadata,
    streamId,
    limit: p.limit,
  })
  return { ...response, data: await enrichMessages(response.data, resolver) }
}

export interface ListConversationsParams {
  streamRef?: string
  status?: string
  cursor?: string
  limit?: number
}

export async function listConversations(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: ListConversationsParams
): Promise<unknown> {
  const streamId = p.streamRef ? await resolver.resolveStream(p.streamRef) : undefined
  const response = await client.get<PagedEnvelope<unknown>>(
    `/conversations${buildQuery({ streamId, status: p.status, after: p.cursor, limit: p.limit })}`
  )
  const data = await Promise.all(response.data.map((c) => enrichConversation(c, resolver)))
  return { ...response, data }
}

export interface ReadConversationParams {
  conversationId: string
  cursor?: string
  limit?: number
}

export async function readConversation(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: ReadConversationParams
): Promise<unknown> {
  const id = encodeURIComponent(p.conversationId)
  const [conversationResp, messagesResp] = await Promise.all([
    client.get<Envelope<unknown>>(`/conversations/${id}`),
    client.get<PagedEnvelope<unknown>>(
      `/conversations/${id}/messages${buildQuery({ after: p.cursor, limit: p.limit })}`
    ),
  ])
  return {
    conversation: await enrichConversation(conversationResp.data, resolver),
    messages: {
      data: await enrichMessages(messagesResp.data, resolver),
      hasMore: messagesResp.hasMore ?? false,
      cursor: messagesResp.cursor ?? null,
    },
  }
}

export function getMemo(client: ThreaApiClient, memoId: string): Promise<unknown> {
  return client.get(`/memos/${encodeURIComponent(memoId)}`)
}

export function getAttachment(client: ThreaApiClient, attachmentId: string): Promise<unknown> {
  return client.get(`/attachments/${encodeURIComponent(attachmentId)}`)
}

export function getAttachmentDownloadUrl(client: ThreaApiClient, attachmentId: string): Promise<unknown> {
  return client.get(`/attachments/${encodeURIComponent(attachmentId)}/url`)
}

export const SEARCH_WHATS = ["messages", "memos", "attachments"] as const
export type SearchWhat = (typeof SEARCH_WHATS)[number]

const ALLOWED_FILTERS: Record<SearchWhat, readonly string[]> = {
  messages: ["query", "semantic", "exact", "stream_ids", "type", "before", "after", "limit"],
  memos: ["query", "exact", "stream_ids", "memo_type", "knowledge_type", "tags", "scope", "before", "after", "limit"],
  attachments: ["query", "stream_ids", "content_types", "limit"],
}

const FILTER_KEYS = [
  "query",
  "semantic",
  "exact",
  "stream_ids",
  "type",
  "memo_type",
  "knowledge_type",
  "tags",
  "scope",
  "content_types",
  "before",
  "after",
  "limit",
] as const

export interface SearchArgs {
  what: SearchWhat
  query?: string
  semantic?: boolean
  exact?: boolean
  stream_ids?: string[]
  type?: (typeof STREAM_TYPES)[number][]
  memo_type?: (typeof MEMO_TYPES)[number][]
  knowledge_type?: (typeof KNOWLEDGE_TYPES)[number][]
  tags?: string[]
  scope?: (typeof MEMO_SCOPES)[number]
  content_types?: (typeof EXTRACTION_CONTENT_TYPES)[number][]
  before?: string
  after?: string
  limit?: number
}

/**
 * Validates the search args against the chosen `what`, then routes to the right
 * endpoint. Throws ToolInputError (mapped to an isError tool result / exit-1 CLI
 * error) for an unsupported filter, an empty required query, or an over-cap limit —
 * before any HTTP call.
 */
export async function search(client: ThreaApiClient, resolver: RefResolver, args: SearchArgs): Promise<unknown> {
  const { what } = args
  const allowed = ALLOWED_FILTERS[what]
  const raw = args as unknown as Record<string, unknown>
  const offending = FILTER_KEYS.filter((key) => raw[key] !== undefined && !allowed.includes(key))
  if (offending.length > 0) {
    const validList = allowed.filter((f) => f !== "query" && f !== "limit").join(", ")
    throw new ToolInputError(
      "UNSUPPORTED_FILTER",
      `search what="${what}" does not support: ${offending.join(", ")}. ` +
        `Valid filters for "${what}": ${validList || "none"} (plus query, limit).`
    )
  }

  const query = args.query
  if ((what === "messages" || what === "attachments") && (query === undefined || query.trim() === "")) {
    throw new ToolInputError(
      "INVALID_ARGUMENT",
      `search what="${what}" requires a non-empty query. Only what="memos" allows an empty query (recent-first browse).`
    )
  }

  if (what !== "memos" && args.limit !== undefined && args.limit > 50) {
    throw new ToolInputError(
      "INVALID_ARGUMENT",
      `search what="${what}" caps limit at 50 (only what="memos" allows up to 100).`
    )
  }

  if (what === "messages") {
    const streams = args.stream_ids ? await resolver.resolveStreams(args.stream_ids) : undefined
    const response = await client.post<PagedEnvelope<unknown>>("/messages/search", {
      query,
      semantic: args.semantic,
      exact: args.exact,
      streams,
      type: args.type,
      before: args.before,
      after: args.after,
      limit: args.limit,
    })
    return { ...response, data: await enrichMessages(response.data, resolver) }
  }
  if (what === "memos") {
    const streams = args.stream_ids ? await resolver.resolveStreams(args.stream_ids) : undefined
    return client.post("/memos/search", {
      query,
      exact: args.exact,
      streams,
      memoType: args.memo_type,
      knowledgeType: args.knowledge_type,
      tags: args.tags,
      scope: args.scope,
      before: args.before,
      after: args.after,
      limit: args.limit,
    })
  }
  const streams = args.stream_ids ? await resolver.resolveStreams(args.stream_ids) : undefined
  return client.post("/attachments/search", {
    query,
    streams,
    contentTypes: args.content_types,
    limit: args.limit,
  })
}

export interface SendMessageParams {
  streamRef: string
  content: string
  clientMessageId?: string
  metadata?: Record<string, string>
  conversationId?: string
  startConversation?: boolean
}

export function sendConversationArgError(p: {
  conversationId?: string
  startConversation?: boolean
}): string | undefined {
  if (p.conversationId && p.startConversation) {
    return "Pass either conversation_id (resume an existing conversation) or start_conversation (open a new one), not both."
  }
  return undefined
}

export async function sendMessage(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: SendMessageParams
): Promise<unknown> {
  const argError = sendConversationArgError(p)
  if (argError) {
    throw new ToolInputError("INVALID_ARGUMENT", argError)
  }
  const clientMessageId = p.clientMessageId ?? `mcp-${crypto.randomUUID()}`
  const body: Record<string, unknown> = { content: p.content, clientMessageId }
  if (p.metadata) body.metadata = p.metadata
  if (p.conversationId) body.conversation = { intent: "existing", conversationId: p.conversationId }
  else if (p.startConversation) body.conversation = { intent: "new" }
  const streamId = await resolver.resolveStream(p.streamRef)
  const response = await client.post<{ data: unknown; conversationId?: string }>(
    `/streams/${encodeURIComponent(streamId)}/messages`,
    body
  )
  return { ...response, clientMessageId }
}

export function updateMessage(client: ThreaApiClient, messageId: string, content: string): Promise<unknown> {
  return client.patch(`/messages/${encodeURIComponent(messageId)}`, { content })
}

export async function deleteMessage(client: ThreaApiClient, messageId: string): Promise<unknown> {
  await client.delete(`/messages/${encodeURIComponent(messageId)}`)
  return { deleted: true, message_id: messageId }
}

export function listLabels(client: ThreaApiClient): Promise<unknown> {
  return client.get("/labels")
}

export interface ApplyLabelParams {
  name: string
  streamRef: string
  color?: string
  emoji?: string
  description?: string
}

export async function applyLabel(client: ThreaApiClient, resolver: RefResolver, p: ApplyLabelParams): Promise<unknown> {
  return client.post("/labels/assignments", {
    name: p.name,
    color: p.color,
    emoji: p.emoji,
    description: p.description,
    resourceType: "stream",
    resourceId: await resolver.resolveStream(p.streamRef),
  })
}

export async function removeLabel(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: { name: string; streamRef: string }
): Promise<unknown> {
  const resourceId = await resolver.resolveStream(p.streamRef)
  await client.delete(`/labels/assignments${buildQuery({ name: p.name, resourceType: "stream", resourceId })}`)
  return { removed: true, name: p.name, stream_id: resourceId }
}

export interface ListDelegationsParams {
  status?: "open"
  since?: string
}

export function listDelegations(client: ThreaApiClient, p: ListDelegationsParams): Promise<unknown> {
  return client.get(`/delegations${buildQuery({ status: p.status, since: p.since })}`)
}

export interface ClaimDelegationParams {
  delegationId: string
  claimedByLabel: string
  idempotencyKey?: string
}

export async function claimDelegation(
  client: ThreaApiClient,
  store: TokenStore,
  workspaceId: string,
  p: ClaimDelegationParams
): Promise<unknown> {
  const response = await client.post<{ data: { claimToken?: string } }>(
    `/delegations/${encodeURIComponent(p.delegationId)}/claim`,
    { claimedByLabel: p.claimedByLabel, idempotencyKey: p.idempotencyKey }
  )
  const token = response.data?.claimToken
  if (token) store.set(workspaceId, p.delegationId, token)
  return response
}

function resolveDelegationToken(
  store: TokenStore,
  workspaceId: string,
  delegationId: string,
  explicit: string | undefined
): string {
  const token = explicit ?? store.get(workspaceId, delegationId)
  if (!token) {
    throw new ToolInputError(
      "MISSING_CLAIM_TOKEN",
      "No claim token for this delegation. Pass claim_token — the value the claim returned once. The persistent " +
        "store has no token for this id (you never claimed it, or the claim was already finished and cleared)."
    )
  }
  return token
}

export interface UpdateDelegationParams {
  delegationId: string
  statusNote?: string
  claimToken?: string
}

export function updateDelegation(
  client: ThreaApiClient,
  store: TokenStore,
  workspaceId: string,
  p: UpdateDelegationParams
): Promise<unknown> {
  const headers = { [CALLBACK_TOKEN_HEADER]: resolveDelegationToken(store, workspaceId, p.delegationId, p.claimToken) }
  const id = encodeURIComponent(p.delegationId)
  return p.statusNote
    ? client.post(`/delegations/${id}/status`, { statusNote: p.statusNote }, headers)
    : client.post(`/delegations/${id}/heartbeat`, undefined, headers)
}

export interface FinishDelegationParams {
  delegationId: string
  outcome: "complete" | "fail"
  resultMarkdown?: string
  metadata?: Record<string, string>
  errorMessage?: string
  claimToken?: string
}

export function finishDelegationArgError(p: FinishDelegationParams): string | undefined {
  if (p.outcome === "fail") {
    if (!p.errorMessage) return "outcome=fail requires error_message."
    const misplaced: string[] = []
    if (p.resultMarkdown !== undefined) misplaced.push("result_markdown")
    if (p.metadata !== undefined) misplaced.push("metadata")
    if (misplaced.length > 0) {
      return `outcome=fail does not accept ${misplaced.join(", ")} — those belong to outcome=complete.`
    }
    return undefined
  }
  if (p.errorMessage !== undefined) {
    return "outcome=complete does not accept error_message — that belongs to outcome=fail."
  }
  return undefined
}

export async function finishDelegation(
  client: ThreaApiClient,
  store: TokenStore,
  workspaceId: string,
  p: FinishDelegationParams
): Promise<unknown> {
  const argError = finishDelegationArgError(p)
  if (argError) throw new ToolInputError("INVALID_ARGUMENT", argError)
  const headers = { [CALLBACK_TOKEN_HEADER]: resolveDelegationToken(store, workspaceId, p.delegationId, p.claimToken) }
  const id = encodeURIComponent(p.delegationId)
  const body: Record<string, unknown> = {}
  let path: string
  if (p.outcome === "fail") {
    path = `/delegations/${id}/fail`
    body.errorMessage = p.errorMessage
  } else {
    path = `/delegations/${id}/complete`
    if (p.resultMarkdown) body.resultMarkdown = p.resultMarkdown
    if (p.metadata) body.metadata = p.metadata
  }
  const response = await client.post(path, body, headers)
  store.delete(workspaceId, p.delegationId)
  return response
}

export function requestDelegationAccess(client: ThreaApiClient, delegationId: string): Promise<unknown> {
  return client.post(`/delegations/${encodeURIComponent(delegationId)}/request-access`, {})
}
