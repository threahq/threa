import { ThreaApiError, type ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"
import { enrichConversation, enrichMessages, enrichStreamContext } from "./enrich"
import type { RefResolver } from "./resolver"
import type { SealedStreams } from "./sealed"
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
  return {
    principal: data,
    declaredPrincipal: config.principal ?? null,
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
  }
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
  /**
   * Opens the bodies of an end-to-end-encrypted stream. Without it the rows
   * come back as the server stores them: a `sealed` envelope beside an opaque
   * `content` placeholder.
   */
  sealed?: SealedStreams
}

interface SealedRow {
  sealed?: { ciphertext: string; envelope: { v: number; keyGeneration: number; iv: string; aad: string } }
}

/**
 * Replace each sealed row's placeholder with the body it stands for. The
 * `sealed` envelope is dropped once opened — what is left is the same shape a
 * plaintext row has, so one renderer serves both. A row whose generation no key
 * here is wrapped to keeps a null `content` and says why, which costs the
 * caller that row rather than the page.
 */
async function openSealedRows(sealed: SealedStreams, streamId: string, rows: unknown): Promise<unknown> {
  if (!Array.isArray(rows)) return rows
  const opened: unknown[] = []
  for (const row of rows) {
    const candidate = row as SealedRow & Record<string, unknown>
    if (!row || typeof row !== "object" || !candidate.sealed) {
      opened.push(row)
      continue
    }
    const { sealed: envelope, ...rest } = candidate
    const body = await sealed.open(streamId, envelope)
    opened.push({
      ...rest,
      content: body.contentMarkdown,
      ...(body.attachmentRefs.length > 0 ? { sealedAttachmentRefs: body.attachmentRefs } : {}),
      ...(body.unreadableReason === undefined ? {} : { unreadableReason: body.unreadableReason }),
    })
  }
  return opened
}

export async function readStream(client: ThreaApiClient, resolver: RefResolver, p: ReadStreamParams): Promise<unknown> {
  const streamId = await resolver.resolveStream(p.streamId)
  const id = encodeURIComponent(streamId)
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

  const enriched = await enrichMessages(messagesResp.data, resolver)
  const messages = p.sealed ? await openSealedRows(p.sealed, streamId, enriched) : enriched
  const result: Record<string, unknown> = {
    stream: streamResp.data,
    messages: { data: messages, hasMore: messagesResp.hasMore ?? false },
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

export async function setStreamArchived(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: { streamRef: string; archived: boolean }
): Promise<unknown> {
  const id = encodeURIComponent(await resolver.resolveStream(p.streamRef))
  return client.post(`/streams/${id}/${p.archived ? "archive" : "unarchive"}`)
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
  includeArchived?: boolean
}

export async function listConversations(
  client: ThreaApiClient,
  resolver: RefResolver,
  p: ListConversationsParams
): Promise<unknown> {
  const streamId = p.streamRef ? await resolver.resolveStream(p.streamRef) : undefined
  const response = await client.get<PagedEnvelope<unknown>>(
    `/conversations${buildQuery({
      streamId,
      status: p.status,
      after: p.cursor,
      limit: p.limit,
      includeArchived: p.includeArchived ? "true" : undefined,
    })}`
  )
  const withParticipants = await Promise.all(response.data.map((c) => enrichConversation(c, resolver)))
  return { ...response, data: await enrichStreamContext(withParticipants, resolver) }
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
  const [conversation] = (await enrichStreamContext(
    [await enrichConversation(conversationResp.data, resolver)],
    resolver
  )) as unknown[]
  return {
    conversation,
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

export function recallMemos(client: ThreaApiClient, query: string): Promise<unknown> {
  return client.post("/memos/recall", { query })
}

export function getAttachment(client: ThreaApiClient, attachmentId: string): Promise<unknown> {
  return client.get(`/attachments/${encodeURIComponent(attachmentId)}`)
}

export function getAttachmentDownloadUrl(client: ThreaApiClient, attachmentId: string): Promise<unknown> {
  return client.get(`/attachments/${encodeURIComponent(attachmentId)}/url`)
}

export function getAttachmentContent(client: ThreaApiClient, attachmentId: string): Promise<Response> {
  return client.getRaw(`/attachments/${encodeURIComponent(attachmentId)}/content`)
}

export function uploadAttachment(client: ThreaApiClient, file: Blob, filename: string): Promise<unknown> {
  const form = new FormData()
  form.append("file", file, filename)
  return client.postForm("/attachments", form, file.size)
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
  if (what === "messages" && (query === undefined || query.trim() === "")) {
    throw new ToolInputError(
      "INVALID_ARGUMENT",
      `search what="messages" requires a non-empty query. Omitting the query (recent-first browse) is only ` +
        `supported for what="memos" and what="attachments".`
    )
  }
  if (what === "attachments" && query !== undefined && query.trim() === "") {
    throw new ToolInputError(
      "INVALID_ARGUMENT",
      `search what="attachments" got a blank query. Pass a non-empty query, or omit it entirely to browse the most recent attachments.`
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
    const data = await enrichStreamContext(await enrichMessages(response.data, resolver), resolver)
    return { ...response, data }
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
  const response = await client.post<PagedEnvelope<unknown>>("/attachments/search", {
    query,
    streams,
    contentTypes: args.content_types,
    limit: args.limit,
  })
  return { ...response, data: await enrichStreamContext(response.data, resolver) }
}

export interface SendMessageParams {
  streamRef: string
  content: string
  clientMessageId?: string
  metadata?: Record<string, string>
  conversationId?: string
  startConversation?: boolean
  /**
   * Seals the body when the target stream is encrypted. Supplying it also buys
   * the check that decides: without knowing first, the only way to learn is to
   * post the plaintext and be rejected, which is one trip too late.
   */
  sealed?: SealedStreams
}

/** Everything a sealed body cannot carry — refused rather than dropped. */
function sealedSendArgError(p: SendMessageParams): string | undefined {
  if (p.metadata) return "An end-to-end-encrypted stream takes no metadata: it would travel in the clear."
  if (p.conversationId || p.startConversation) {
    return "Conversations are not available in an end-to-end-encrypted stream."
  }
  return undefined
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

function effectiveClientMessageId(id?: string): string {
  return id ?? `mcp-${crypto.randomUUID()}`
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
  const streamId = await resolver.resolveStream(p.streamRef)
  if (p.sealed) {
    const stream = await client.get<Envelope<{ e2eEnabled?: boolean }>>(`/streams/${encodeURIComponent(streamId)}`)
    if (stream.data.e2eEnabled === true) {
      const sealedArgError = sealedSendArgError(p)
      if (sealedArgError) throw new ToolInputError("INVALID_ARGUMENT", sealedArgError)
      const sent = await p.sealed.send(streamId, p.content, {
        ...(p.clientMessageId === undefined ? {} : { clientMessageId: p.clientMessageId }),
      })
      return { data: { id: sent.messageId }, clientMessageId: sent.clientMessageId, sealed: true }
    }
  }
  const clientMessageId = effectiveClientMessageId(p.clientMessageId)
  const body: Record<string, unknown> = { content: p.content, clientMessageId }
  if (p.metadata) body.metadata = p.metadata
  if (p.conversationId) body.conversation = { intent: "existing", conversationId: p.conversationId }
  else if (p.startConversation) body.conversation = { intent: "new" }
  const response = await client.post<{ data: unknown; conversationId?: string }>(
    `/streams/${encodeURIComponent(streamId)}/messages`,
    body
  )
  return { ...response, clientMessageId, ...(p.sealed ? { sealed: false } : {}) }
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

export interface ListDocsParams {
  streamRef?: string
  query?: string
  includeArchived?: boolean
  after?: string
  limit?: number
}

export async function listDocs(client: ThreaApiClient, resolver: RefResolver, p: ListDocsParams): Promise<unknown> {
  const streamId = p.streamRef ? await resolver.resolveStream(p.streamRef) : undefined
  return client.get(
    `/docs${buildQuery({
      streamId,
      query: p.query,
      after: p.after,
      limit: p.limit,
      includeArchived: p.includeArchived ? "true" : undefined,
    })}`
  )
}

export function readDoc(client: ThreaApiClient, docId: string): Promise<unknown> {
  return client.get(`/docs/${encodeURIComponent(docId)}`)
}

export interface DocEditInput {
  blockId?: string
  old: string
  new: string
}

export function editDoc(
  client: ThreaApiClient,
  p: { docId: string; reason: string; edits: DocEditInput[] }
): Promise<unknown> {
  return client.post(`/docs/${encodeURIComponent(p.docId)}/edits`, { reason: p.reason, edits: p.edits })
}

const DOC_MARKER = /^<!--\s*(blk_\w+)\s*-->[ \t]*\n?/gm
const TASK_LINE = /^(\s*[-*+] \[)( |x|X)(\] )(.*)$/

/** Splits `docs read` markdown back into blocks; `renderWithMarkers` joins them with a blank line. */
function docBlocks(markdown: string): { blockId: string; markdown: string }[] {
  const markers = [...markdown.matchAll(DOC_MARKER)]
  return markers.map((marker, i) => {
    const start = marker.index + marker[0].length
    const next = markers[i + 1]
    const body = markdown.slice(start, next ? next.index : markdown.length)
    return { blockId: marker[1]!, markdown: next ? body.replace(/\n\n$/, "") : body }
  })
}

interface TaskMatch {
  blockId: string
  nth: number
  line: string
  lineIndex: number
  blockMarkdown: string
  checked: boolean
}

function findTasks(markdown: string, item: string, blockId?: string): TaskMatch[] {
  const wanted = item.trimEnd()
  const matches: TaskMatch[] = []
  for (const block of docBlocks(markdown)) {
    if (blockId && block.blockId !== blockId) continue
    block.markdown.split("\n").forEach((line, lineIndex) => {
      const task = TASK_LINE.exec(line)
      if (!task || task[4]!.trimEnd() !== wanted) return
      matches.push({
        blockId: block.blockId,
        nth: matches.length + 1,
        line,
        lineIndex,
        blockMarkdown: block.markdown,
        checked: task[2] !== " ",
      })
    })
  }
  return matches
}

function pickTask(matches: TaskMatch[], p: { item: string; nth?: number }): TaskMatch {
  const listed = matches.map(({ blockId, nth, line }) => ({ blockId, nth, line }))
  if (matches.length === 0) {
    throw new ToolInputError("DOC_TASK_NOT_FOUND", `no task item reads exactly "${p.item}"`, {
      hint: "Read the doc and copy the item text after `[ ] ` verbatim; --block narrows to one block.",
    })
  }
  if (p.nth !== undefined) {
    const picked = matches[p.nth - 1]
    if (!picked) {
      throw new ToolInputError("DOC_TASK_NOT_FOUND", `only ${matches.length} task(s) read "${p.item}", no #${p.nth}`, {
        details: { matches: listed },
      })
    }
    return picked
  }
  if (matches.length > 1) {
    throw new ToolInputError("DOC_TASK_AMBIGUOUS", `${matches.length} task items read "${p.item}"`, {
      hint: "Pick one with --nth N (1-based, document order) or narrow with --block.",
      details: { matches: listed },
    })
  }
  return matches[0]!
}

export interface CheckDocTaskParams {
  docId: string
  item: string
  checked: boolean
  reason: string
  blockId?: string
  nth?: number
}

/** Ticks one task item by rewriting its whole block, so a shorter item never matches inside a longer one. */
export async function checkDocTask(client: ThreaApiClient, p: CheckDocTaskParams): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const doc = await client.get<{ data: { markdown: string } }>(`/docs/${encodeURIComponent(p.docId)}`)
    const task = pickTask(findTasks(doc.data.markdown, p.item, p.blockId), p)
    const result = { blockId: task.blockId, nth: task.nth, checked: p.checked }
    if (task.checked === p.checked) return { data: { changed: false, ...result, line: task.line } }

    const lines = task.blockMarkdown.split("\n")
    const line = task.line.replace(
      TASK_LINE,
      (_, head, _mark, tail, text) => `${head}${p.checked ? "x" : " "}${tail}${text}`
    )
    lines[task.lineIndex] = line
    try {
      const edited = await client.post<{ data: Record<string, unknown> }>(
        `/docs/${encodeURIComponent(p.docId)}/edits`,
        { reason: p.reason, edits: [{ blockId: task.blockId, old: task.blockMarkdown, new: lines.join("\n") }] }
      )
      return { data: { ...edited.data, changed: true, ...result, line } }
    } catch (error) {
      const moved = error instanceof ThreaApiError && error.status === 409 && error.code === "DOC_EDIT_TEXT_NOT_FOUND"
      if (!moved || attempt > 0) throw error
    }
  }
}

export async function commentOnDoc(
  client: ThreaApiClient,
  p: { docId: string; blockId: string; content: string; clientMessageId?: string }
): Promise<unknown> {
  const clientMessageId = effectiveClientMessageId(p.clientMessageId)
  const response = await client.post<{ data: { threadId: string; message: unknown } }>(
    `/docs/${encodeURIComponent(p.docId)}/sections/${encodeURIComponent(p.blockId)}/comments`,
    { content: p.content, clientMessageId }
  )
  return { ...response, clientMessageId }
}

export interface CreateDocParams {
  streamRef: string
  title?: string
  markdown?: string
  reason?: string
}

export async function createDoc(client: ThreaApiClient, resolver: RefResolver, p: CreateDocParams): Promise<unknown> {
  return client.post("/docs", {
    streamId: await resolver.resolveStream(p.streamRef),
    title: p.title,
    markdown: p.markdown,
    reason: p.reason,
  })
}

export interface ListDelegationsParams {
  status?: "open"
  since?: string
}

export function listDelegations(client: ThreaApiClient, p: ListDelegationsParams): Promise<unknown> {
  return client.get(`/delegations${buildQuery({ status: p.status, since: p.since })}`)
}

export function getDelegation(client: ThreaApiClient, delegationId: string): Promise<unknown> {
  return client.get(`/delegations/${encodeURIComponent(delegationId)}`)
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

export interface ReleaseDelegationParams {
  delegationId: string
  claimToken?: string
}

export async function releaseDelegation(
  client: ThreaApiClient,
  store: TokenStore,
  workspaceId: string,
  p: ReleaseDelegationParams
): Promise<unknown> {
  const token = resolveDelegationToken(store, workspaceId, p.delegationId, p.claimToken)
  const headers = { [CALLBACK_TOKEN_HEADER]: token }
  const response = await client.post(`/delegations/${encodeURIComponent(p.delegationId)}/release`, undefined, headers)
  store.deleteIfMatches(workspaceId, p.delegationId, token)
  return response
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
