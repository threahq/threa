import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool, PoolClient } from "pg"
import type { Server } from "socket.io"
import type { SearchFilters, SearchService } from "../search"
import type { FeatureFlagService } from "../feature-flags"
import { setAuditSubjects } from "../access-log"
import { serializeSearchResult, resolveUserAccessibleStreamIds, SearchRepository } from "../search"
import { BotChannelAccessRepository, type BotChannelService } from "../api-keys"
import { MessageRepository, type EventService, type Message } from "../messaging"
import {
  resolveDeliveryVerdict,
  TrustTiers,
  type DeliveryVerdict,
  type ExternalContextHandle,
} from "@threa/agent-runtime"
import {
  StreamRepository,
  StreamEventRepository,
  StreamMemberRepository,
  getEffectiveDisplayName,
  assertStreamWritable,
  assertViewerStreamWritable,
  resolveLockedStreamAuthorities,
  type Stream,
  type DisplayNameContext,
  type StreamService,
} from "../streams"
import { UserRepository } from "../workspaces"
import { ConversationRepository, ConversationService, type Conversation } from "../conversations"
import {
  E2eStreamActorsRepository,
  E2eStreamsRepository,
  StreamE2eKeyWrapsRepository,
  resolveSealingContext,
} from "../e2e-streams"
import { UserE2eKeysRepository } from "../user-e2e-keys"
import { failSessionWithLifecycleInTransaction, PersonaRepository } from "../agents"
import { type Memo, type MemoExplorerService, type MemoExplorerDetail, type MemoExplorerResult } from "../memos"
import {
  AttachmentExtractionRepository,
  AttachmentRepository,
  buildUploadParams,
  parseE2eUploadFlag,
  type Attachment,
  type AttachmentExtraction,
  type AttachmentWithExtraction,
  type AttachmentService,
  toAttachmentSummary,
} from "../attachments"
import type { LabelService, LabelAssignmentService } from "../labels"
import { BotRepository, serializeBot, type Bot } from "./bot-repository"
import {
  AgentSessionStatuses,
  AttachmentSafetyStatuses,
  AuthorTypes,
  LabelActorTypes,
  type Label,
  type LabelActor,
  type LabelAssignment,
  BotInvocationCapabilities,
  BotInvocationTriggers,
  MemoryModes,
  StreamTypes,
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  THREA_CALLBACK_TOKEN_HEADER,
  sentViaApiKey,
  type AuthorType,
  type JSONContent,
  type SealedTurnContext,
} from "@threa/types"
import {
  BotRuntimeService,
  BotRuntimeInstanceRepository,
  assertManifestAllows,
  type BotInvocation,
  type BotRuntimeSessionLink,
  type BotRuntimeWriteOps,
} from "../bot-runtimes"
import {
  insertCommandCompletedEvent,
  insertCommandFailedEvent,
  parseRuntimeCommandInvocationMetadata,
} from "../commands"
import { HttpError, isUniqueViolation } from "@threa/backend-common"
import { invocationClaimNotFound, invocationInputStale } from "./errors"
import { validateRequest } from "../../lib/validation"
import { normalizeMessage, toEmoji } from "../emoji"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threa/prosemirror"
import { randomUUID } from "crypto"
import { botId, eventId } from "../../lib/id"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import {
  AgentSessionRepository,
  hashCallbackToken,
  assertSessionRunning,
  assertSessionRunningOrCompleted,
  assertSessionRunningOrFailed,
  verifyCallbackToken,
  assertReplyKeyGeneration,
  type AgentSession,
  type AgentSessionStep,
} from "../agents"
import { buildSealedTurnContext } from "./sealed-turn-context"
import { authorizeSealedCallback, emitBotSealedProgress } from "./sealed-callbacks"
import { resolvePublicMessageSlots } from "./message-slots"
import { encodeCursor, decodeCursor } from "./cursor"
import { serializeTraceStep, synthesizeReplyOnlyBotTrace } from "./trace-steps"
import { createBotRuntimeWriteOps } from "./runtime-write-ops"
import { listMyBotsSchema } from "./schemas"
import type {
  WireStream,
  WireMessage,
  WireConversation,
  WireSearchResult,
  WireUser,
  WireMember,
  WirePrincipal,
  WireMemoSearchResult,
  WireMemoDetail,
  WireAttachmentSearchResult,
  WireAttachmentDetails,
  WireAttachmentUrl,
  WireAttachmentUpload,
  WireLabel,
  WireLabelAssignment,
  WireSlotMap,
} from "./routes"
import { API_VERSIONS, CURRENT_API_VERSION } from "./versions"
import {
  publicSearchSchema,
  listStreamsSchema,
  listMessagesSchema,
  listConversationsSchema,
  listConversationMessagesSchema,
  sendMessageSchema,
  updateMessageSchema,
  updateStreamSchema,
  listMembersSchema,
  listUsersSchema,
  searchMemosSchema,
  searchAttachmentsSchema,
  findMessagesByMetadataSchema,
  upsertPresenceSchema,
  createRuntimeSessionSchema,
  renameRuntimeSessionSchema,
  rebindRuntimeSessionSchema,
  endRuntimeSessionSchema,
  briefRuntimeSessionSchema,
  claimInvocationSchema,
  renewInvocationClaimSchema,
  completeInvocationSchema,
  failInvocationSchema,
  recordInvocationStepSchema,
  recordSealedInvocationStepSchema,
  startSealedInvocationStepSchema,
  sendInvocationMessageSchema,
  sendSealedInvocationMessageSchema,
  completeSealedInvocationSchema,
  provisionSessionKeyWrapsSchema,
  createLabelSchema,
  updateLabelSchema,
  assignLabelByNameSchema,
  unassignLabelByNameSchema,
  labelIdParamSchema,
} from "./schemas"

// Same opaque placeholder the enclave reply path and the user-send path store for
// E2E rows (INV-E1: the canonical payload is the ciphertext; plaintext consumers
// see this). Mirrors the local const in the enclave session-handlers.
const E2E_PLACEHOLDER_CONTENT_JSON: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: E2E_PLACEHOLDER_CONTENT_MARKDOWN }] }],
}

function serializeStream(stream: Stream, context?: DisplayNameContext): WireStream {
  const effective = getEffectiveDisplayName(stream, context)
  const displayName = stream.type === "channel" ? `#${effective.displayName}` : effective.displayName
  const anchorId = stream.parentAnchorId

  return {
    id: stream.id,
    type: stream.type,
    displayName,
    ...(stream.slug != null && { slug: stream.slug }),
    ...(stream.description != null && { description: stream.description }),
    visibility: stream.visibility,
    memoryMode: stream.memoryMode ?? MemoryModes.AUTO,
    ...(stream.parentStreamId != null && { parentStreamId: stream.parentStreamId }),
    ...(stream.rootStreamId != null && { rootStreamId: stream.rootStreamId }),
    ...(anchorId != null && { anchorId }),
    createdAt: stream.createdAt.toISOString(),
    ...(stream.archivedAt != null && { archivedAt: stream.archivedAt.toISOString() }),
  }
}

function serializeMessage(
  message: {
    id: string
    streamId: string
    sequence: bigint
    authorId: string
    authorType: AuthorType
    contentMarkdown: string
    replyCount: number
    clientMessageId?: string | null
    sentVia?: string | null
    metadata?: Record<string, string>
    revision: number
    editedAt: Date | null
    createdAt: Date
  },
  opts?: { authorDisplayName?: string | null; threadStreamId?: string | null; attachments?: Attachment[] }
): WireMessage {
  return {
    id: message.id,
    streamId: message.streamId,
    sequence: message.sequence.toString(),
    authorId: message.authorId,
    authorType: message.authorType,
    ...(opts?.authorDisplayName != null && { authorDisplayName: opts.authorDisplayName }),
    content: message.contentMarkdown,
    replyCount: message.replyCount,
    ...(opts?.threadStreamId != null && { threadStreamId: opts.threadStreamId }),
    ...(message.clientMessageId != null && { clientMessageId: message.clientMessageId }),
    ...(message.sentVia != null && { sentVia: message.sentVia }),
    // Always present (possibly empty) so consumers can rely on the shape.
    metadata: message.metadata ?? {},
    ...(opts?.attachments &&
      opts.attachments.length > 0 && { attachments: opts.attachments.map((a) => toAttachmentSummary(a)) }),
    revision: message.revision,
    ...(message.editedAt != null && { editedAt: message.editedAt.toISOString() }),
    createdAt: message.createdAt.toISOString(),
  }
}

function serializeConversation(conversation: Conversation, stream: Stream | undefined): WireConversation {
  const rootStreamId = stream?.rootStreamId ?? stream?.id ?? conversation.streamId
  let topicSummary = conversation.topicSummary
  if (stream?.type === StreamTypes.SCRATCHPAD) {
    topicSummary = stream.e2eEnabled ? null : stream.displayName
  }
  return {
    id: conversation.id,
    streamId: conversation.streamId,
    rootStreamId,
    topicSummary,
    summary: conversation.summary,
    status: conversation.status,
    messageCount: conversation.messageIds.length,
    participantIds: conversation.participantIds,
    lastActivityAt: conversation.lastActivityAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  }
}

/**
 * Map each conversation's anchor stream to its effective root
 * (`COALESCE(root_stream_id, id)`, INV-62) for the wire `rootStreamId`.
 */
async function resolveConversationStreams(pool: Pool, conversations: Conversation[]): Promise<Map<string, Stream>> {
  const streamIds = [...new Set(conversations.map((c) => c.streamId))]
  if (streamIds.length === 0) return new Map()
  const streams = await StreamRepository.findByIds(pool, streamIds)
  return new Map(streams.map((stream) => [stream.id, stream]))
}

// Label domain dates are already ISO strings on the wire shape; the only
// translation is exposing the actor with explicit `actorType`/`actorId` field
// names (the persisted column carries the actor id under the legacy `userId`).
function serializeLabel(label: Label): WireLabel {
  return {
    id: label.id,
    workspaceId: label.workspaceId,
    creatorActorType: label.creatorActorType,
    creatorActorId: label.creatorUserId,
    name: label.name,
    slug: label.slug,
    color: label.color,
    emoji: label.emoji,
    description: label.description,
    createdAt: label.createdAt,
    updatedAt: label.updatedAt,
    archivedAt: label.archivedAt,
  }
}

function serializeLabelAssignment(assignment: LabelAssignment): WireLabelAssignment {
  return {
    labelId: assignment.labelId,
    resourceType: assignment.resourceType,
    resourceId: assignment.resourceId,
    actorType: assignment.actorType,
    actorId: assignment.userId,
    workspaceId: assignment.workspaceId,
    assignedAt: assignment.assignedAt,
  }
}

/**
 * The label actor behind the request: the owning user for a user-scoped key, or
 * the bot for a bot-scoped key. Labels created/applied this way are attributed
 * to that actor (a shared bot has no owning user, so it can't be reduced to a
 * UserId — INV-50).
 */
/**
 * The user who owns labels for this request. A user key owns its own labels; a
 * personal bot key (the Pi-remote path) owns labels *for its owner* — a bot
 * never owns labels itself, so the human always sees what the bot tags, and a
 * personal bot can only ever label for its owner (it has no way to name anyone
 * else). Mirrors the runtime-session flow, which likewise requires a personal
 * bot and acts as `ownerUserId`. Shared bots have no owner, so they can't apply
 * labels.
 */
async function resolveLabelActor(req: Request, pool: Pool): Promise<LabelActor> {
  if (req.userApiKey) return { type: LabelActorTypes.USER, id: req.user!.id }
  if (req.botApiKey) {
    const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
    if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
    if (bot.type !== "personal") {
      throw new HttpError("A personal bot is required to manage labels", {
        status: 400,
        code: "PERSONAL_BOT_REQUIRED",
      })
    }
    return { type: LabelActorTypes.USER, id: bot.ownerUserId }
  }
  throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
}

export { serializeBot } from "./bot-repository"

function serializeUser(user: {
  id: string
  name: string
  slug: string
  email: string
  avatarUrl: string | null
  role: string
}): WireUser {
  return {
    id: user.id,
    name: user.name,
    slug: user.slug,
    email: user.email,
    ...(user.avatarUrl != null && { avatarUrl: user.avatarUrl }),
    role: user.role,
  }
}

function normalizeMemoSearchMode(query: string, exact?: boolean): { query: string; exact: boolean } {
  const trimmed = query.trim()

  const isQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
  const unquoted = isQuoted ? trimmed.slice(1, -1).trim() : trimmed

  if (exact) {
    return { query: unquoted, exact: unquoted.length > 0 }
  }

  if (!isQuoted) {
    return { query: trimmed, exact: false }
  }

  return { query: unquoted, exact: unquoted.length > 0 }
}

function serializeMemo(memo: Memo) {
  return {
    ...memo,
    createdAt: memo.createdAt.toISOString(),
    updatedAt: memo.updatedAt.toISOString(),
    archivedAt: memo.archivedAt?.toISOString() ?? null,
  }
}

function serializeMemoSearchResult(result: MemoExplorerResult): WireMemoSearchResult {
  return {
    memo: serializeMemo(result.memo),
    distance: result.distance,
    sourceStream: result.sourceStream,
    rootStream: result.rootStream,
  }
}

function serializeMemoDetail(detail: MemoExplorerDetail): WireMemoDetail {
  return {
    ...serializeMemoSearchResult(detail),
    successorMemoId: detail.successorMemoId,
    capturedByPersonaName: detail.capturedByPersonaName,
    sourceMessages: detail.sourceMessages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  }
}

function serializeAttachmentSearchResult(result: AttachmentWithExtraction): WireAttachmentSearchResult {
  return {
    id: result.id,
    filename: result.filename,
    mimeType: result.mimeType,
    contentType: result.extraction?.contentType ?? null,
    summary: result.extraction?.summary ?? null,
    ...(result.streamId != null && { streamId: result.streamId }),
    ...(result.messageId != null && { messageId: result.messageId }),
    createdAt: result.createdAt.toISOString(),
  }
}

function serializeAttachmentUpload(attachment: Attachment): WireAttachmentUpload {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    processingStatus: attachment.processingStatus,
    createdAt: attachment.createdAt.toISOString(),
  }
}

function serializeAttachmentDetail(
  attachment: Attachment,
  extraction: AttachmentExtraction | null
): WireAttachmentDetails {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    processingStatus: attachment.processingStatus,
    createdAt: attachment.createdAt.toISOString(),
    extraction: extraction
      ? {
          contentType: extraction.contentType,
          summary: extraction.summary,
          fullText: extraction.fullText,
          structuredData: extraction.structuredData,
          ...(extraction.pdfMetadata != null && { pdfMetadata: extraction.pdfMetadata }),
          ...(extraction.textMetadata != null && { textMetadata: extraction.textMetadata }),
          ...(extraction.wordMetadata != null && { wordMetadata: extraction.wordMetadata }),
          ...(extraction.excelMetadata != null && { excelMetadata: extraction.excelMetadata }),
        }
      : null,
  }
}

/**
 * Batch-fetch parent streams for threads that need display name context.
 * Only fetches when there are unnamed threads in the result set.
 */
async function resolveParentStreams(pool: Pool, streams: Stream[]): Promise<Map<string, Stream>> {
  const parentIds = [
    ...new Set(
      streams
        .filter((s) => s.type === "thread" && s.displayName === null && s.parentStreamId)
        .map((s) => s.parentStreamId!)
    ),
  ]
  if (parentIds.length === 0) return new Map()
  const parents = await StreamRepository.findByIds(pool, parentIds)
  return new Map(parents.map((p) => [p.id, p]))
}

async function resolveAuthorDisplayNames(
  pool: Pool,
  workspaceId: string,
  messages: { authorId: string; authorType: string }[]
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>()
  const byType = { user: new Set<string>(), bot: new Set<string>(), persona: new Set<string>() }

  for (const m of messages) {
    if (m.authorType === "user") byType.user.add(m.authorId)
    else if (m.authorType === "bot") byType.bot.add(m.authorId)
    else if (m.authorType === "persona") byType.persona.add(m.authorId)
    // System messages have no display name; clients format from authorType.
  }

  const fetches: Promise<void>[] = []

  if (byType.user.size > 0) {
    fetches.push(
      UserRepository.findByIds(pool, workspaceId, [...byType.user]).then((users) => {
        for (const u of users) nameMap.set(u.id, u.name)
      })
    )
  }
  if (byType.bot.size > 0) {
    fetches.push(
      BotRepository.findByIds(pool, workspaceId, [...byType.bot]).then((bots) => {
        for (const b of bots) nameMap.set(b.id, b.name)
      })
    )
  }
  if (byType.persona.size > 0) {
    fetches.push(
      PersonaRepository.findByIds(pool, [...byType.persona], workspaceId).then((personas) => {
        for (const p of personas) nameMap.set(p.id, p.name)
      })
    )
  }

  await Promise.all(fetches)
  return nameMap
}

/** Mirrors the enclave assignment's history cap (`MAX_HISTORY_MESSAGES`, enclave claim-service). */
const CLAIM_CONTEXT_MAX_MESSAGES = 30

/**
 * Hydrate the inline context handle for a freshly claimed invocation (N-4):
 * the last messages preceding the trigger, from the invocation's own stream,
 * oldest → newest. The trigger itself already travels as `promptMarkdown`.
 *
 * Scoping is per-location (INV-62): the invocation's location is the grant —
 * an agent's access derives from WHERE it was invoked, and every surface's
 * access spec includes the surface itself. So no `stream_members` or
 * bot-channel-grant filter applies here: either would silently drop thread
 * context (threads carry no membership of their own; access resolves through
 * the root), and standing grants are the wrong axis anyway.
 *
 * Returns `undefined` when context is WITHHELD (stream gone, cross-workspace,
 * or any non-plaintext verdict — plaintext history never leaves the enclave/
 * sealed path). An empty conversation instead yields an explicit empty inline
 * handle, so the runner can tell "nothing came before" from "context unavailable".
 *
 * The `verdict` is resolved once by the caller and shared with the sealed branch
 * so the two can't disagree; the plaintext self-guard here is kept as
 * defense-in-depth (a future caller must still never leak plaintext into a sealed
 * stream).
 */
async function buildClaimContext(
  pool: Pool,
  invocation: { workspaceId: string; activeStreamId: string; sourceMessageId: string; actorId: string },
  verdict: DeliveryVerdict
): Promise<ExternalContextHandle | undefined> {
  if (verdict.delivery !== "plaintext") return undefined
  const stream = await StreamRepository.findById(pool, invocation.activeStreamId)
  if (!stream || stream.workspaceId !== invocation.workspaceId) return undefined

  const surrounding = await MessageRepository.findSurrounding(
    pool,
    invocation.sourceMessageId,
    invocation.activeStreamId,
    CLAIM_CONTEXT_MAX_MESSAGES,
    0
  )
  const prior = surrounding.filter((m) => m.id !== invocation.sourceMessageId)
  const authorNames = await resolveAuthorDisplayNames(pool, invocation.workspaceId, prior)
  return {
    kind: "inline",
    messages: prior.map((m) => {
      const authorDisplayName = authorNames.get(m.authorId)
      return {
        messageId: m.id,
        // "assistant" = this runner's own prior replies; other bots and
        // personas are conversational input like any other participant.
        role: m.authorType === AuthorTypes.BOT && m.authorId === invocation.actorId ? "assistant" : "user",
        authorId: m.authorId,
        authorType: m.authorType,
        ...(authorDisplayName != null && { authorDisplayName }),
        contentMarkdown: m.contentMarkdown,
        createdAt: m.createdAt.toISOString(),
      }
    }),
  }
}

/**
 * Builds the sealed assignment for a claimed invocation when the delivery
 * verdict is `sealed` — the external analog of the enclave's
 * `buildEnclaveSessionAssignment`. The backend never decrypts: it ships the
 * SSK wraps addressed to the claiming bot's BIK plus the sealed history/prompt
 * ciphertext, and the bot opens them with its identity private key.
 *
 * Key material resolves against the root (`rootStreamId`): a thread shares the
 * root's SSK and carries no wraps of its own, and the root's `e2e_streams` row
 * is authoritative for `currentKeyGeneration` (a roll lands there). The
 * conversation window and trigger are read from the invocation's own
 * `activeStreamId`, mirroring `buildClaimContext` and the enclave claim.
 *
 * Throws (INV-11) rather than returning a context the bot can't open: the
 * claim gate (`BotInvocationRepository.claimOne`) already proved this instance's
 * BIK covers the prompt's and reply's generations, so a missing key id or a
 * coverage miss here is a revoke/rotation race between claim and build. Failing
 * loudly leaves the row claimed; its TTL hands it back to a still-qualifying
 * instance.
 */
async function buildSealedClaimContext(
  pool: Pool,
  invocation: BotInvocation,
  instanceId: string
): Promise<SealedTurnContext> {
  const instance = await BotRuntimeInstanceRepository.findByInstance(pool, {
    workspaceId: invocation.workspaceId,
    botId: invocation.actorId,
    instanceId,
  })
  if (!instance?.publicKeyId) {
    throw new HttpError("Claiming bot instance has no registered identity key", {
      status: 409,
      code: "BOT_IDENTITY_KEY_REQUIRED",
    })
  }
  const e2e = await E2eStreamsRepository.getByStreamId(pool, invocation.workspaceId, invocation.rootStreamId)
  if (!e2e) {
    throw new HttpError("Sealed claim targets a stream that is no longer E2E", {
      status: 409,
      code: "E2E_STREAM_GONE",
    })
  }
  const [wraps, trigger, surrounding] = await Promise.all([
    StreamE2eKeyWrapsRepository.listForStream(pool, invocation.workspaceId, invocation.rootStreamId),
    MessageRepository.findById(pool, invocation.sourceMessageId),
    MessageRepository.findSurrounding(
      pool,
      invocation.sourceMessageId,
      invocation.activeStreamId,
      CLAIM_CONTEXT_MAX_MESSAGES,
      0
    ),
  ])
  if (!trigger || trigger.deletedAt) {
    throw new HttpError("Sealed claim trigger message is gone", { status: 409, code: "TRIGGER_MESSAGE_GONE" })
  }
  const priorMessages = surrounding.filter((m) => m.id !== invocation.sourceMessageId)
  const triggerAuthorName = (await resolveAuthorDisplayNames(pool, invocation.workspaceId, [trigger])).get(
    trigger.authorId
  )
  const context = buildSealedTurnContext({
    e2e,
    bikKeyId: instance.publicKeyId,
    wraps,
    trigger,
    triggerAuthorName,
    priorMessages,
    replySenderId: invocation.actorId,
    callbackToken: invocation.claimToken!,
  })
  if (!context) {
    throw new HttpError("Claiming bot key no longer covers the stream's key generations", {
      status: 409,
      code: "SEALED_KEY_COVERAGE_LOST",
    })
  }
  return context
}

/**
 * The minimal sealed material a session-control invocation needs to seal its ack
 * on an E2E scratchpad. Unlike {@link buildSealedClaimContext} there is no
 * trigger/history to open (the command name is cleartext dispatch metadata, not
 * a sealed message) — only the current-generation SSK wraps addressed to the
 * claiming bot's BIK plus the `reply` binding. Returns `undefined` when the bot
 * can't seal (no registered BIK, or no wrap for the current generation): the
 * harness then falls back to a silent close, so a key-race never wedges the
 * command.
 */
async function buildSessionControlSealedAck(
  pool: Pool,
  invocation: BotInvocation,
  instanceId: string
): Promise<
  | {
      wraps: { keyGeneration: number; wrapEnc: string; wrapCt: string }[]
      reply: { keyGeneration: number; senderId: string }
    }
  | undefined
> {
  const instance = await BotRuntimeInstanceRepository.findByInstance(pool, {
    workspaceId: invocation.workspaceId,
    botId: invocation.actorId,
    instanceId,
  })
  if (!instance?.publicKeyId) return undefined
  const e2e = await E2eStreamsRepository.getByStreamId(pool, invocation.workspaceId, invocation.rootStreamId)
  if (!e2e) return undefined
  const wraps = await StreamE2eKeyWrapsRepository.listForStream(pool, invocation.workspaceId, invocation.rootStreamId)
  const botWraps = wraps.filter(
    (w) =>
      w.recipientKind === "bot" &&
      w.recipientKeyId === instance.publicKeyId &&
      w.keyGeneration === e2e.currentKeyGeneration
  )
  if (botWraps.length === 0) return undefined
  return {
    wraps: botWraps.map((w) => ({ keyGeneration: w.keyGeneration, wrapEnc: w.wrapEnc, wrapCt: w.wrapCt })),
    reply: { keyGeneration: e2e.currentKeyGeneration, senderId: invocation.actorId },
  }
}

export interface PublicApiDeps {
  searchService: SearchService
  featureFlagService: FeatureFlagService
  memoExplorerService: MemoExplorerService
  attachmentService: AttachmentService
  botChannelService: BotChannelService
  botRuntimeService: BotRuntimeService
  /**
   * The shared presence/renew/steps write path. Production wires the single
   * instance also handed to the `/bot` socket (INV-13); when omitted (tests,
   * standalone handler construction) it is built from the deps below so the
   * REST handlers behave identically without every caller threading it.
   */
  botRuntimeWriteOps?: BotRuntimeWriteOps
  streamService: StreamService
  eventService: EventService
  /**
   * Production wires the shared instance from `registerRoutes` (INV-13); when
   * omitted (tests, standalone construction) one is built from `pool`, which is
   * its only dependency.
   */
  conversationService?: ConversationService
  labelService: LabelService
  labelAssignmentService: LabelAssignmentService
  pool: Pool
  io: Server
}

export function createPublicApiHandlers({
  searchService,
  featureFlagService,
  memoExplorerService,
  attachmentService,
  botChannelService,
  botRuntimeService,
  botRuntimeWriteOps: providedWriteOps,
  streamService,
  eventService,
  conversationService: providedConversationService,
  labelService,
  labelAssignmentService,
  pool,
  io,
}: PublicApiDeps) {
  const botRuntimeWriteOps =
    providedWriteOps ?? createBotRuntimeWriteOps({ pool, io, botRuntimeService, botChannelService })
  const conversationService = providedConversationService ?? new ConversationService(pool)
  /** Resolve accessible stream IDs for the current key (user-scoped or bot) */
  async function getAccessibleStreamIds(req: Request, filters: SearchFilters = {}): Promise<string[]> {
    if (req.userApiKey) {
      return resolveUserAccessibleStreamIds(pool, req.workspaceId!, req.user!.id, filters)
    }
    if (req.botApiKey) {
      return botChannelService.getAccessibleStreamIdsForBot(req.workspaceId!, req.botApiKey.botId)
    }
    throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
  }

  /**
   * Resolve the response-level `slots` map for a page of returned messages.
   * Access resolves against the key principal's active + archived streams (a
   * shared source in an archived stream still hydrates for a user key; bot
   * keys use their readable set, which excludes archived). Lazy — no access
   * query runs when no returned message references a shared source.
   */
  function resolveSlots(req: Request, contentJsons: Iterable<JSONContent | null | undefined>): Promise<WireSlotMap> {
    return resolvePublicMessageSlots(
      pool,
      req.workspaceId!,
      () => {
        // Bot keys ignore the archive filter (their readable set is fixed); user
        // keys widen to active + archived so archived-source pointers hydrate.
        return getAccessibleStreamIds(req, { archiveStatus: ["active", "archived"] })
      },
      contentJsons
    )
  }

  /** Check if a single stream is accessible for the current key */
  async function assertStreamAccessible(req: Request, streamId: string): Promise<void> {
    if (req.userApiKey) {
      const stream = await streamService.tryAccess(streamId, req.workspaceId!, req.user!.id)
      if (!stream) {
        throw new HttpError("Stream not accessible", { status: 403, code: "FORBIDDEN" })
      }
      return
    }
    if (req.botApiKey) {
      const accessible = await botChannelService.isStreamAccessibleForBot(
        req.workspaceId!,
        req.botApiKey.botId,
        streamId
      )
      if (!accessible) {
        throw new HttpError("Stream not accessible", { status: 403, code: "FORBIDDEN" })
      }
      return
    }
    throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
  }

  /**
   * Reject a plaintext write into an end-to-end-encrypted stream. The public
   * API has no ciphertext message path (send/update accept plaintext only), so
   * a write here would persist a plaintext row in an E2E scratchpad and break
   * the encryption guarantee — the same INV-E1 mismatch the first-party handler
   * blocks. We fail before any insert. Lift this once the public API can carry
   * a sealed payload.
   */
  async function assertNotE2eStream(workspaceId: string, streamId: string): Promise<void> {
    if (await E2eStreamsRepository.isE2eStream(pool, workspaceId, streamId)) {
      throw new HttpError("Stream is end-to-end encrypted; the public API cannot post plaintext to it", {
        status: 400,
        code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
      })
    }
  }

  /**
   * Resolve and authorize a sealed bot session callback — the HTTP adapter over
   * the transport-neutral `authorizeSealedCallback` core (shared with the
   * `bot:invocation:sealed-steps` WS frame via `recordSealedSteps`). The verified
   * token IS the per-claim claim token (model A); it is returned so the
   * `/sealed-complete` claim flip scopes by it without re-reading the header,
   * keeping that security dependency explicit rather than an implicit `!`.
   */
  async function authorizeSealedInvocationCallback(
    req: Request,
    opts: { acceptCompletedSession?: boolean; acceptFailedSession?: boolean } = {}
  ) {
    if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
    return authorizeSealedCallback(
      pool,
      {
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        callbackToken: req.header(THREA_CALLBACK_TOKEN_HEADER),
      },
      opts
    )
  }

  /** Bind completed writes to the runtime identity from the current claim generation (INV-20). */
  async function assertCompletedClaimStillLinked(
    tx: PoolClient,
    params: { workspaceId: string; botId: string; invocation: BotInvocation }
  ): Promise<void> {
    const { invocation } = params
    let runtimeSessionId: string | null = null
    if (
      invocation.claimedRuntimeSessionId !== null &&
      invocation.claimedRuntimeSessionClaimToken !== null &&
      invocation.claimToken !== null &&
      invocation.claimedRuntimeSessionClaimToken === invocation.claimToken
    ) {
      runtimeSessionId = invocation.claimedRuntimeSessionId
    } else if (invocation.claimedRuntimeSessionId === null && invocation.claimedRuntimeSessionClaimToken === null) {
      runtimeSessionId = invocation.targetRuntimeSessionId
    }
    if (!invocation.claimedByInstanceId || !runtimeSessionId) {
      throw new HttpError("The runtime session that claimed this invocation is no longer linked", {
        status: 404,
        code: "RUNTIME_LINK_ENDED",
      })
    }
    const link = await botRuntimeService.findActiveSessionLinkForCompletedClaim(tx, {
      workspaceId: params.workspaceId,
      botId: params.botId,
      instanceId: invocation.claimedByInstanceId,
      runtimeSessionId,
    })
    if (!link || link.instanceId !== invocation.claimedByInstanceId || link.runtimeSessionId !== runtimeSessionId) {
      throw new HttpError("The runtime session that claimed this invocation is no longer linked", {
        status: 404,
        code: "RUNTIME_LINK_ENDED",
      })
    }
  }

  /** Bind idempotent replay to the bot, create-event actor, and session that made the request. */
  async function findOwnTurnMessageByClientId(
    tx: PoolClient,
    params: { streamId: string; clientMessageId: string; botId: string; sessionId: string; expectedId?: string }
  ): Promise<Message | null> {
    const existing = await MessageRepository.findByClientMessageId(tx, params.streamId, params.clientMessageId)
    if (!existing) return null
    const createdEvent = await StreamEventRepository.findByMessageId(tx, params.streamId, existing.id)
    if (
      (params.expectedId !== undefined && existing.id !== params.expectedId) ||
      existing.authorId !== params.botId ||
      existing.authorType !== AuthorTypes.BOT ||
      createdEvent?.actorId !== params.botId ||
      createdEvent.actorType !== AuthorTypes.BOT ||
      (createdEvent.payload as { sessionId?: string }).sessionId !== params.sessionId
    ) {
      throw invocationClaimNotFound()
    }
    return existing
  }

  async function terminalizeBotDenial(params: {
    error: unknown
    session: { id: string; streamId: string; personaId: string }
    stream: Stream
    botId: string
    callbackToken: string
    instanceId?: string
  }): Promise<void> {
    const denial = params.error as { code?: string; details?: { reason?: string } }
    if (denial.code !== "STREAM_READ_ONLY" && denial.code !== "STREAM_NOT_FOUND") throw params.error
    const reason = denial.code === "STREAM_NOT_FOUND" ? "not_a_member" : (denial.details?.reason ?? "not_a_member")
    const terminalError = `STREAM_READ_ONLY:${reason}`
    const won = await withTransaction(pool, async (client) => {
      const claim = params.instanceId
        ? await botRuntimeService.findActiveClaimForUpdate(client, {
            workspaceId: params.stream.workspaceId,
            botId: params.botId,
            invocationId: params.session.id,
            instanceId: params.instanceId,
            claimToken: params.callbackToken,
          })
        : await botRuntimeService.findActiveClaimForUpdateByToken(client, {
            workspaceId: params.stream.workspaceId,
            botId: params.botId,
            invocationId: params.session.id,
            claimToken: params.callbackToken,
          })
      if (!claim) return false
      const failed = await botRuntimeService.failInvocationInTransaction(client, {
        workspaceId: params.stream.workspaceId,
        botId: params.botId,
        invocationId: params.session.id,
        instanceId: params.instanceId,
        claimToken: params.callbackToken,
        errorMessage: terminalError,
      })
      if (!failed) return false
      return failSessionWithLifecycleInTransaction(client, params.session, params.stream, terminalError)
    })
    if (won) {
      io.to(`ws:${params.stream.workspaceId}:agent_session:${params.session.id}`).emit("agent_session:failed", {
        sessionId: params.session.id,
      })
    }
  }

  async function loadCompletedInvocationReplay(
    client: PoolClient,
    invocation: BotInvocation,
    botId: string,
    callbackToken: string
  ): Promise<{ invocationId: string; sessionId: string; message: Message | null } | null> {
    const session = await AgentSessionRepository.findById(client, invocation.id)
    if (
      !session ||
      session.status !== AgentSessionStatuses.COMPLETED ||
      session.personaId !== botId ||
      session.streamId !== invocation.responseStreamId
    ) {
      return null
    }
    if (session.callbackTokenHash) verifyCallbackToken(session, callbackToken)
    const message = session.responseMessageId
      ? await MessageRepository.findById(client, session.responseMessageId)
      : null
    if (session.responseMessageId && !message) return null
    if (
      message &&
      (message.streamId !== invocation.responseStreamId ||
        message.authorType !== AuthorTypes.BOT ||
        message.authorId !== botId)
    ) {
      return null
    }
    return { invocationId: invocation.id, sessionId: session.id, message }
  }

  async function resolveCompletedInvocationReplay(
    client: PoolClient,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      claimToken: string
      instanceId?: string
    }
  ): Promise<{ invocationId: string; sessionId: string; message: Message | null } | null> {
    const snapshot = await botRuntimeService.findInvocationForCallback(client, params)
    if (!snapshot || snapshot.status !== "completed") return null
    await resolveLockedStreamAuthorities(client, {
      workspaceId: params.workspaceId,
      streamIds: [snapshot.responseStreamId],
      principal: { kind: "bot", botId: params.botId },
    })
    const invocation = await botRuntimeService.findCompletedInvocationForReplay(client, params)
    if (!invocation || invocation.responseStreamId !== snapshot.responseStreamId) return null
    return loadCompletedInvocationReplay(client, invocation, params.botId, params.claimToken)
  }

  /** Resolve mutation actor independently; message snapshot is only a placement hint. */
  async function resolveMessageMutation(messageId: string, req: Request) {
    const message = await eventService.getMessageById(messageId)
    if (req.userApiKey) {
      return { message, actorId: req.user!.id, actorType: AuthorTypes.USER as AuthorType, displayName: req.user!.name }
    }
    if (req.botApiKey) {
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      if (!bot || bot.archivedAt) {
        throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      }
      return { message, actorId: bot.id, actorType: AuthorTypes.BOT as AuthorType, displayName: bot.name }
    }
    throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
  }

  /**
   * Find a conversation and verify the key can read it. Access is the anchor
   * stream's (a thread anchor resolves through its root, INV-62); a missing or
   * cross-workspace id is a 404.
   */
  async function resolveAccessibleConversation(req: Request, conversationId: string): Promise<Conversation> {
    const conversation = await ConversationRepository.findById(pool, conversationId)
    if (!conversation || conversation.workspaceId !== req.workspaceId) {
      throw new HttpError("Conversation not found", { status: 404, code: "NOT_FOUND" })
    }
    await assertStreamAccessible(req, conversation.streamId)
    return conversation
  }

  async function resolveAccessibleAttachment(req: Request, attachmentId: string): Promise<Attachment> {
    const accessibleStreamIds = await getAccessibleStreamIds(req, { archiveStatus: ["active", "archived"] })
    const attachment = await attachmentService.getAccessible(attachmentId, {
      workspaceId: req.workspaceId!,
      accessibleStreamIds,
    })
    if (!attachment) {
      throw new HttpError("Attachment not found", { status: 404, code: "NOT_FOUND" })
    }
    return attachment
  }

  return {
    async uploadAttachment(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const uploadedBy = req.userApiKey ? req.user!.id : req.botApiKey?.botId
      if (!uploadedBy) throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })

      const file = req.file
      if (!file || !file.key) {
        return res.status(400).json({ error: "No file provided" })
      }
      const attachmentId = req.attachmentId
      if (!attachmentId) {
        throw new HttpError("Attachment id was not generated", { status: 500, code: "INTERNAL_ERROR" })
      }

      // E2E uploads are bot-only: a sealed harness turn binds the ciphertext row
      // via the sealed-messages/sealed-complete `attachmentIds` and seals the
      // per-file key into the payload's `attachmentRefs`, exactly like the
      // first-party client. User API keys have no sealed message-write path on
      // the public API, so an accepted E2E row could never be referenced by a
      // matching message — keep rejecting those loudly.
      const e2e = parseE2eUploadFlag(req.body)
      if (e2e && !req.botApiKey) {
        throw new HttpError("E2E attachment uploads require a bot API key on the public API", {
          status: 400,
          code: "E2E_UPLOAD_UNSUPPORTED",
        })
      }

      const uploadResult = await attachmentService.createForUpload(
        buildUploadParams(
          {
            id: attachmentId,
            workspaceId,
            uploadedBy,
            filename: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            storagePath: file.key,
          },
          e2e
        )
      )

      if (uploadResult.status === "cleanup_failed") {
        throw new HttpError("Attachment quarantined and cleanup failed", { status: 500, code: "INTERNAL_ERROR" })
      }
      if (uploadResult.status === "blocked") {
        return res.status(400).json({ error: uploadResult.reason })
      }

      res.status(201).json({ data: serializeAttachmentUpload(uploadResult.attachment) })
    },

    async upsertBotRuntimePresence(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(upsertPresenceSchema, req.body)
      const presence = await botRuntimeWriteOps.applyPresence({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: data.runtimeKind,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
        displayName: data.displayName,
        status: data.status,
        acceptingInvocations: data.acceptingInvocations,
        capabilities: data.capabilities,
        manifest: data.manifest ?? null,
        statusText: data.statusText,
        publicKey: data.publicKey,
        publicKeyId: data.publicKeyId,
      })
      res.json({
        data: {
          ...presence,
          lastSeenAt: presence.lastSeenAt.toISOString(),
          createdAt: presence.createdAt.toISOString(),
          updatedAt: presence.updatedAt.toISOString(),
        },
      })
    },

    async createBotRuntimeSession(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(createRuntimeSessionSchema, req.body)
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      if (bot.type !== "personal") {
        throw new HttpError("Runtime sessions require a personal bot owner", {
          status: 400,
          code: "PERSONAL_BOT_REQUIRED",
        })
      }
      // An E2E session wraps the stream key to the bot OWNER's identity key, so
      // the declared key must be the owner's CURRENT one — wrapping to a stale
      // or foreign key would create a scratchpad the owner can never open.
      if (data.e2e) {
        const ownerKey = await UserE2eKeysRepository.getActiveByUser(pool, req.workspaceId!, bot.ownerUserId)
        if (!ownerKey || ownerKey.keyId !== data.e2e.ownerKeyId) {
          throw new HttpError("ownerKeyId does not match the bot owner's active encryption key", {
            status: 400,
            code: "E2E_OWNER_KEY_MISMATCH",
          })
        }
      }

      const requiredRuntimeTraits = ["active-scratchpad"] as const
      const identity = {
        workspaceId: req.workspaceId!,
        botId: bot.id,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
        runtimeKind: data.runtimeKind,
      }
      const resumeLink = async (link: BotRuntimeSessionLink) => {
        await withTransaction(pool, (client) =>
          botRuntimeService.repairBotTraitsInTransaction(client, {
            workspaceId: req.workspaceId!,
            botId: bot.id,
            traits: requiredRuntimeTraits,
          })
        )
        return res.json({
          data: {
            linkId: link.id,
            rootStreamId: link.rootStreamId,
            activeStreamId: link.activeStreamId,
            runtimeSessionId: link.runtimeSessionId,
            streamUrlPath: `/w/${req.workspaceId!}/s/${link.activeStreamId}`,
            // The resumed scratchpad's actual encryption state — a harness that
            // asked for e2e can detect a plaintext resume (and vice versa).
            e2eEnabled: await E2eStreamsRepository.isE2eStream(pool, req.workspaceId!, link.rootStreamId),
          },
        })
      }
      // Unique violation on the runtime-session identity: another writer (the
      // unarchive consumer, a concurrent create for the same identity) linked
      // it between our reads above and the insert. The whole create rolled
      // back (no orphan stream) — resume that link instead of surfacing a 500.
      const resumeAfterIdentityConflict = async (error: unknown) => {
        if (!isUniqueViolation(error)) throw error
        const revived = await botRuntimeService.findActivePiRemoteSession(identity)
        // An archive-ended link keeps its runtime_session_id (only `/done`
        // retires it), so that identity attached to a different scratchpad
        // lands here with nothing to resume. Typed so it is not a 500 (INV-32).
        if (!revived) {
          throw new HttpError("A conflicting runtime session link already exists for this identity", {
            status: 409,
            code: "RUNTIME_SESSION_CONFLICT",
            cause: error as Error,
          })
        }
        return resumeLink(revived)
      }

      const existingLink = await botRuntimeService.findActivePiRemoteSession(identity)
      if (existingLink) return resumeLink(existingLink)

      if (data.attachTo) {
        let attached: Awaited<ReturnType<typeof botRuntimeService.attachRuntimeSessionToThread>>
        try {
          attached = await botRuntimeService.attachRuntimeSessionToThread({
            workspaceId: req.workspaceId!,
            botId: bot.id,
            ownerUserId: bot.ownerUserId,
            runtimeKind: data.runtimeKind,
            instanceId: data.instanceId,
            runtimeSessionId: data.runtimeSessionId,
            rootStreamId: data.attachTo.rootStreamId,
            anchorId: data.attachTo.anchorId,
            displayName: data.displayName,
            localCwd: data.localCwd,
            traits: requiredRuntimeTraits,
          })
        } catch (error) {
          return resumeAfterIdentityConflict(error)
        }
        return res.json({
          data: {
            linkId: attached.link.id,
            rootStreamId: attached.link.rootStreamId,
            activeStreamId: attached.link.activeStreamId,
            runtimeSessionId: attached.link.runtimeSessionId,
            streamUrlPath: `/w/${req.workspaceId!}/s/${attached.stream.id}`,
            e2eEnabled: attached.stream.e2eEnabled === true,
          },
        })
      }

      // Archive→unarchive reattach: the runtime re-issues session-create with
      // the same identity after its link was archive-ended. Revive that link
      // (same scratchpad) rather than minting a duplicate; while the scratchpad
      // is still archived, refuse loudly so a self-healing client can tell
      // "wait" apart from "create" (INV-11).
      const reattachParams = {
        workspaceId: req.workspaceId!,
        botId: bot.id,
        runtimeKind: data.runtimeKind,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
      }
      let reattach = await botRuntimeService.reattachArchivedRuntimeSession(reattachParams)
      if (reattach.status === "archived_stream" && data.ifArchived === "replace") {
        // A cold start doesn't wait on an archived scratchpad the user is done
        // with: retire its link (frees the identity) and fall through to a
        // fresh create. Nothing to retire means a concurrent unarchive won the
        // row — re-run the reattach so that revived link is resumed instead.
        const retired = await botRuntimeService.retireArchivedRuntimeSession(reattachParams)
        reattach = retired ? { status: "none" } : await botRuntimeService.reattachArchivedRuntimeSession(reattachParams)
      }
      if (reattach.status === "archived_stream") {
        throw new HttpError("The linked scratchpad is archived; unarchive it to reattach", {
          status: 409,
          code: "SCRATCHPAD_ARCHIVED",
        })
      }
      if (reattach.status === "reattached") return resumeLink(reattach.link)

      if (data.ifMissing === "error") {
        throw new HttpError("No runtime session link exists for this identity", {
          status: 409,
          code: "RUNTIME_SESSION_NOT_FOUND",
        })
      }

      let created: Awaited<ReturnType<typeof botRuntimeService.createLinkedScratchpadSession>>
      try {
        created = await botRuntimeService.createLinkedScratchpadSession({
          workspaceId: req.workspaceId!,
          botId: bot.id,
          ownerUserId: bot.ownerUserId,
          runtimeKind: data.runtimeKind,
          instanceId: data.instanceId,
          runtimeSessionId: data.runtimeSessionId,
          displayName: data.displayName,
          localCwd: data.localCwd,
          memoryMode: data.memoryMode,
          labelName: data.labelName,
          description: data.description,
          traits: requiredRuntimeTraits,
          ...(data.e2e ? { e2e: { ownerKeyId: data.e2e.ownerKeyId } } : {}),
        })
      } catch (error) {
        return resumeAfterIdentityConflict(error)
      }
      const { link, stream } = created

      res.json({
        data: {
          linkId: link.id,
          rootStreamId: link.rootStreamId,
          activeStreamId: link.activeStreamId,
          runtimeSessionId: link.runtimeSessionId,
          streamUrlPath: `/w/${req.workspaceId!}/s/${stream.id}`,
          e2eEnabled: stream.e2eEnabled === true,
        },
      })
    },

    /**
     * The bot OWNER's active encryption key (public half + key id). A sealed
     * harness fetches this before creating an E2E session so it can declare the
     * owner key at create time and wrap the generation-0 stream key to it.
     * Public-key material only — never secret. 404 tells the harness the owner
     * has not set up encryption yet (the actionable next step for the user).
     */
    async getBotOwnerE2eKey(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      if (bot.type !== "personal") {
        throw new HttpError("Only a personal bot has an owner key", { status: 400, code: "PERSONAL_BOT_REQUIRED" })
      }
      const key = await UserE2eKeysRepository.getActiveByUser(pool, req.workspaceId!, bot.ownerUserId)
      if (!key) {
        throw new HttpError("The bot owner has not set up encryption", {
          status: 404,
          code: "E2E_OWNER_KEY_NOT_FOUND",
        })
      }
      res.json({ data: { keyId: key.keyId, publicKey: key.publicKey.toString("base64") } })
    },

    /**
     * Store the generation-0 SSK wraps for a harness-created E2E scratchpad —
     * phase two of the two-phase creation (the wrap AAD binds to the stream id
     * minted in phase one). Only the stream's own bot actor may provision, only
     * at the current generation, and only while the generation has NO wraps:
     * slots are immutable (INV-20 upsert semantics), so a partial or replayed
     * provision can never splice wraps of two different keys together — the
     * whole batch lands in one transaction or the state stays empty.
     */
    async provisionStreamE2eKeyWraps(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(provisionSessionKeyWrapsSchema, req.body)
      const workspaceId = req.workspaceId!
      const streamId = req.params.streamId
      const e2e = await E2eStreamsRepository.getByStreamId(pool, workspaceId, streamId)
      if (!e2e) throw new HttpError("Stream is not end-to-end encrypted", { status: 400, code: "STREAM_NOT_E2E" })
      const actors = await E2eStreamActorsRepository.listForStream(pool, workspaceId, streamId)
      if (!actors.some((actor) => actor.kind === "bot" && actor.actorId === req.botApiKey!.botId)) {
        throw new HttpError("Bot is not an actor on this stream", { status: 403, code: "NOT_STREAM_ACTOR" })
      }
      if (data.keyGeneration !== e2e.currentKeyGeneration) {
        throw new HttpError(
          `Wraps target generation ${data.keyGeneration}; the stream is at ${e2e.currentKeyGeneration}`,
          { status: 400, code: "E2E_WRONG_KEY_GENERATION" }
        )
      }
      // The user slot is pinned to the declared owner key: a wrap for any other
      // user key would plant an unopenable owner slot.
      for (const wrap of data.wraps) {
        if (wrap.recipientKind === "user" && wrap.recipientKeyId !== e2e.ownerUserKeyId) {
          throw new HttpError("A user wrap must target the stream owner's key", {
            status: 400,
            code: "E2E_OWNER_KEY_MISMATCH",
          })
        }
      }
      await withTransaction(pool, async (client) => {
        // Serialize concurrent provisions on the stream's e2e row (INV-20):
        // without the lock, two racers could each see zero wraps and interleave
        // wraps of two DIFFERENT keys into the immutable slots — an unopenable
        // splice. With it, the loser re-reads after commit and 409s cleanly.
        await client.query(`SELECT 1 FROM e2e_streams WHERE workspace_id = $1 AND stream_id = $2 FOR UPDATE`, [
          workspaceId,
          streamId,
        ])
        const existing = await StreamE2eKeyWrapsRepository.listForStream(client, workspaceId, streamId)
        if (existing.some((wrap) => wrap.keyGeneration === data.keyGeneration)) {
          // A replay after success lands here; the harness treats it as done.
          throw new HttpError("This generation already has wraps", { status: 409, code: "E2E_ALREADY_PROVISIONED" })
        }
        await StreamE2eKeyWrapsRepository.insertMany(
          client,
          data.wraps.map((wrap) => ({
            workspaceId,
            streamId,
            keyGeneration: data.keyGeneration,
            recipientKeyId: wrap.recipientKeyId,
            recipientKind: wrap.recipientKind,
            wrapEnc: wrap.wrapEnc,
            wrapCt: wrap.wrapCt,
          }))
        )
      })
      res.json({ data: { stored: data.wraps.length } })
    },

    async renameBotRuntimeSession(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(renameRuntimeSessionSchema, req.body)
      const link = await botRuntimeService.findActivePiRemoteSession({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
      })
      if (!link) {
        throw new HttpError("No active runtime session link found", { status: 404, code: "NOT_FOUND" })
      }
      const updated = await streamService.updateStream(
        link.activeStreamId,
        { displayName: data.displayName },
        { workspaceId: req.workspaceId!, principal: { kind: "bot", botId: req.botApiKey.botId } }
      )
      if (!updated) {
        throw new HttpError("Linked stream not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({
        data: {
          linkId: link.id,
          rootStreamId: link.rootStreamId,
          activeStreamId: link.activeStreamId,
          runtimeSessionId: link.runtimeSessionId,
          streamUrlPath: `/w/${req.workspaceId!}/s/${link.activeStreamId}`,
          displayName: updated.displayName ?? data.displayName,
        },
      })
    },

    async rebindBotRuntimeSession(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(rebindRuntimeSessionSchema, req.body)
      const link = await botRuntimeService.rebindPiRemoteSessionInstance({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        linkId: data.linkId,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
        newInstanceId: data.newInstanceId,
      })
      if (!link) {
        throw new HttpError("No active runtime session link found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({
        data: {
          linkId: link.id,
          rootStreamId: link.rootStreamId,
          activeStreamId: link.activeStreamId,
          runtimeSessionId: link.runtimeSessionId,
          streamUrlPath: `/w/${req.workspaceId!}/s/${link.activeStreamId}`,
        },
      })
    },

    async endBotRuntimeSession(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(endRuntimeSessionSchema, req.body)
      const ended = await botRuntimeService.endRuntimeSession({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
      })
      if (!ended) {
        throw new HttpError("No active runtime session link found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({
        data: {
          linkId: ended.id,
          rootStreamId: ended.rootStreamId,
          activeStreamId: ended.activeStreamId,
          status: "ended" as const,
        },
      })
    },

    async briefBotRuntimeSession(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(briefRuntimeSessionSchema, req.body)
      const workspaceId = req.workspaceId!
      const botId = req.botApiKey.botId
      const bot = await BotRepository.findById(pool, workspaceId, botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      if (bot.type !== "personal") {
        throw new HttpError("Runtime sessions require a personal bot owner", {
          status: 400,
          code: "PERSONAL_BOT_REQUIRED",
        })
      }
      const contentMarkdown = normalizeMessage(data.content)
      const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)
      // Same reason as sendMessage: a brief may carry `[x](attachment:att_x)`,
      // and without the ids the create-time access gate never runs and the
      // attachment_references projection is never written.
      const attachmentIds = collectAttachmentReferenceIds(contentJson)
      const briefed = await botRuntimeService.briefRuntimeSession({
        workspaceId,
        botId,
        ownerUserId: bot.ownerUserId,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
        contentJson,
        contentMarkdown,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      })
      if (!briefed) throw new HttpError("No active runtime session link found", { status: 404, code: "NOT_FOUND" })
      res.status(201).json({
        data: {
          invocationId: briefed.invocation.id,
          messageId: briefed.message.id,
          streamId: briefed.invocation.activeStreamId,
        },
      })
    },

    async claimBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(claimInvocationSchema, req.body)
      // Claim doubles as a heartbeat: refresh presence as "available" on every
      // poll so Pi does not need a separate /presence call per tick. If a claim
      // lands we'll overwrite to "busy" right after.
      await botRuntimeWriteOps.touchPresence({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: data.runtimeKind,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
        status: "available",
        acceptingInvocations: true,
      })
      const invocation = await botRuntimeService.claimNextInvocation({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: data.runtimeKind,
        instanceId: data.instanceId,
        runtimeSessionId: data.runtimeSessionId,
        supportedCapabilities: data.supportedCapabilities,
        claimTtlSeconds: data.claimTtlSeconds,
        responseStreamId: data.responseStreamId,
        claimToken: randomUUID(),
      })
      // An empty claim poll read nothing — runtimes poll every few seconds
      // forever, and logging each empty poll buries the log in heartbeat
      // cadence (2026-07-19 volume reckoning). A claim that hands over an
      // invocation is a real read and records with the invocation subject.
      if (!invocation) {
        res.locals.auditSkip = true
        return res.json({ data: null })
      }
      setAuditSubjects(res, [{ type: "bot_invocation", id: invocation.id }])
      await botRuntimeWriteOps.touchPresence({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: data.runtimeKind,
        instanceId: data.instanceId,
        runtimeSessionId: invocation.targetRuntimeSessionId ?? data.runtimeSessionId,
        status: "busy",
        acceptingInvocations: false,
      })
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      const isSessionControl = invocation.trigger === BotInvocationTriggers.SESSION_CONTROL

      // One delivery verdict per claim (Phase 2.4) drives both the sealed
      // assignment and the plaintext context so they can't disagree. The sealed
      // assignment is built BEFORE the session insert because it supplies the
      // callback binding (token hash + reply generation) the session row stores.
      const sealing = await resolveSealingContext(pool, {
        workspaceId: invocation.workspaceId,
        streamId: invocation.activeStreamId,
        actor: { kind: "bot", botId: invocation.actorId },
      })
      const verdict = resolveDeliveryVerdict({ trust: TrustTiers.THIRD_PARTY, sealing })
      let sealedContext: SealedTurnContext | undefined
      let sealedAck: Awaited<ReturnType<typeof buildSessionControlSealedAck>>
      let callbackBinding: { callbackTokenHash: string; replyKeyGeneration: number } | undefined
      if (!isSessionControl && verdict.delivery === "sealed") {
        sealedContext = await buildSealedClaimContext(pool, invocation, data.instanceId)
        callbackBinding = {
          callbackTokenHash: hashCallbackToken(invocation.claimToken!),
          replyKeyGeneration: sealedContext.reply.keyGeneration,
        }
      } else if (isSessionControl && verdict.delivery === "sealed") {
        // Session-control (e.g. /model) on an E2E scratchpad: no sealed turn, but
        // hand the harness the current-generation SSK wraps so it can seal the
        // command ack. Undefined when the bot can't seal (no BIK / wrap race) —
        // the harness then closes silently, exactly as before this shipped.
        sealedAck = await buildSessionControlSealedAck(pool, invocation, data.instanceId)
      }

      let claimValidForSession = true
      if (!isSessionControl && bot && !bot.archivedAt) {
        await withTransaction(pool, async (client) => {
          const currentClaim = await botRuntimeService.findActiveClaimForUpdate(client, {
            workspaceId: invocation.workspaceId,
            botId: invocation.actorId,
            invocationId: invocation.id,
            instanceId: data.instanceId,
            claimToken: invocation.claimToken!,
          })
          if (!currentClaim || currentClaim.claimedSourceMessageRevision !== invocation.claimedSourceMessageRevision) {
            claimValidForSession = false
            return
          }
          const latestSequence = await eventService.getLatestSequence(invocation.responseStreamId)
          const session = await AgentSessionRepository.insertRunningOrSkip(client, {
            id: invocation.id,
            streamId: invocation.responseStreamId,
            personaId: bot.id,
            triggerMessageId: invocation.sourceMessageId,
            initialSequence: latestSequence ?? 0n,
            ...callbackBinding,
          })
          if (!session) return
          const streamEvent = await StreamEventRepository.insert(client, {
            id: eventId(),
            streamId: invocation.responseStreamId,
            eventType: "agent_session:started",
            payload: {
              sessionId: session.id,
              personaId: bot.id,
              personaName: bot.name,
              triggerMessageId: invocation.sourceMessageId,
              rerunContext: null,
              startedAt: session.createdAt.toISOString(),
            },
            actorId: bot.id,
            actorType: AuthorTypes.BOT,
          })
          await OutboxRepository.insert(client, "agent_session:started", {
            workspaceId: req.workspaceId!,
            streamId: invocation.responseStreamId,
            rootStreamId: invocation.rootStreamId,
            event: streamEvent,
          })
        })
      }
      if (!claimValidForSession) {
        res.locals.auditSkip = true
        return res.json({ data: null })
      }
      const context = await buildClaimContext(pool, invocation, verdict)
      res.json({
        data: {
          id: invocation.id,
          workspaceId: invocation.workspaceId,
          rootStreamId: invocation.rootStreamId,
          activeStreamId: invocation.activeStreamId,
          sourceMessageId: invocation.sourceMessageId,
          responseStreamId: invocation.responseStreamId,
          actor: { type: "bot", id: invocation.actorId, slug: bot?.slug ?? "" },
          trigger: invocation.trigger,
          requiredCapability: invocation.requiredCapability,
          promptMarkdown: invocation.promptMarkdown,
          sourceRevision: invocation.sourceMessageRevision,
          authorUserId: invocation.authorUserId,
          mentionedActorSlugs: invocation.mentionedActorSlugs,
          claimToken: invocation.claimToken!,
          claimExpiresAt: invocation.claimExpiresAt!.toISOString(),
          runtimeSessionId: invocation.targetRuntimeSessionId,
          metadata: invocation.metadata,
          ...(context && { context }),
          ...(sealedContext && { sealedContext }),
          ...(sealedAck && { sealedAck }),
        },
      })
    },

    async renewBotInvocationClaim(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(renewInvocationClaimSchema, req.body)
      const renewed = await botRuntimeWriteOps.renewClaim({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        instanceId: data.instanceId,
        claimToken: data.claimToken,
        claimTtlSeconds: data.claimTtlSeconds,
        knownSourceRevision: data.knownSourceRevision,
        restartRequiredRevision: data.restartRequiredRevision,
      })
      res.json({ data: renewed })
    },

    async recordBotInvocationStep(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(recordInvocationStepSchema, req.body)
      const result = await botRuntimeWriteOps.recordSteps({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        instanceId: data.instanceId,
        claimToken: data.claimToken,
        steps: [{ stepType: data.stepType, content: data.content, clientStepId: data.clientStepId }],
        statusText: data.statusText,
      })
      res.json({
        data: { invocationId: result.invocationId, sessionId: result.sessionId, stepId: result.steps[0].stepId },
      })
    },

    async sendBotInvocationMessage(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(sendInvocationMessageSchema, req.body)
      const workspaceId = req.workspaceId!
      const botId = req.botApiKey.botId
      const bot = await BotRepository.findById(pool, workspaceId, botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })

      const contentMarkdown = normalizeMessage(data.content)
      const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)
      const attachmentIds = collectAttachmentReferenceIds(contentJson)

      let denialSession: AgentSession | null = null
      const message = await withTransaction(pool, async (tx) => {
        denialSession = null
        const callbackParams = {
          workspaceId,
          botId,
          invocationId: req.params.invocationId,
          instanceId: data.instanceId,
          claimToken: data.claimToken,
        }
        const snapshot = await botRuntimeService.findInvocationForCallback(tx, callbackParams)
        if (!snapshot) throw invocationClaimNotFound()
        if (snapshot.trigger === BotInvocationTriggers.SESSION_CONTROL) {
          throw new HttpError("Session-control invocations post no turn messages", {
            status: 409,
            code: "SESSION_CONTROL_MESSAGE_UNSUPPORTED",
          })
        }
        const callbackSession = await AgentSessionRepository.findById(tx, snapshot.id)
        if (
          snapshot.status === "claimed" &&
          callbackSession &&
          (callbackSession.status === AgentSessionStatuses.RUNNING ||
            callbackSession.status === AgentSessionStatuses.FAILED) &&
          callbackSession.personaId === botId &&
          callbackSession.streamId === snapshot.responseStreamId
        ) {
          denialSession = callbackSession
        }
        // Keep stream, invocation, and session lock order aligned with completion to avoid ABBA deadlocks.
        await resolveLockedStreamAuthorities(tx, {
          workspaceId,
          streamIds: [snapshot.responseStreamId],
          principal: { kind: "bot", botId },
        })
        // A committed idempotent retry performs no new authorized write.
        if (data.clientMessageId) {
          const existing = await findOwnTurnMessageByClientId(tx, {
            streamId: snapshot.responseStreamId,
            clientMessageId: data.clientMessageId,
            botId,
            sessionId: snapshot.id,
          })
          if (existing) return existing
        }
        const activeClaim = await botRuntimeService.findActiveClaimForUpdate(tx, callbackParams)
        const invocation = activeClaim ?? (await botRuntimeService.findCompletedInvocationForReplay(tx, callbackParams))
        if (!invocation || invocation.responseStreamId !== snapshot.responseStreamId) {
          throw invocationClaimNotFound()
        }
        // INV-E1/INV-E7: cleartext must never land in an E2E stream — a sealed
        // harness posts through `/sealed-messages` instead.
        if (await E2eStreamsRepository.isE2eStream(tx, workspaceId, invocation.responseStreamId)) {
          throw new HttpError("Stream is end-to-end encrypted; use the sealed-messages endpoint", {
            status: 400,
            code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
          })
        }
        const session = await AgentSessionRepository.findByIdForUpdate(tx, invocation.id)
        if (activeClaim) assertSessionRunningOrFailed(session)
        else assertSessionRunningOrCompleted(session)
        if (session.personaId !== botId) {
          throw new HttpError("Session does not belong to this bot", { status: 403, code: "FORBIDDEN" })
        }
        if (session.streamId !== invocation.responseStreamId) throw invocationClaimNotFound()
        if (activeClaim) denialSession = session
        if (!activeClaim) await assertCompletedClaimStillLinked(tx, { workspaceId, botId, invocation })
        return (
          await eventService.createMessageForPrincipalInTransaction(
            tx,
            { kind: "bot", botId },
            {
              workspaceId,
              streamId: invocation.responseStreamId,
              sessionId: session.id,
              authorId: botId,
              authorType: AuthorTypes.BOT,
              contentJson,
              contentMarkdown,
              ...(attachmentIds.length > 0 && { attachmentIds }),
              ...(data.clientMessageId && { clientMessageId: data.clientMessageId }),
              ...(data.metadata && { metadata: data.metadata }),
            }
          )
        ).message
      }).catch(async (error) => {
        const denial = error as { code?: string }
        if (denialSession && (denial.code === "STREAM_READ_ONLY" || denial.code === "STREAM_NOT_FOUND")) {
          const responseStream = await StreamRepository.findById(pool, denialSession.streamId)
          if (responseStream?.workspaceId === workspaceId) {
            await terminalizeBotDenial({
              error,
              session: denialSession,
              stream: responseStream,
              botId,
              callbackToken: data.claimToken,
              instanceId: data.instanceId,
            })
          }
        }
        throw error
      })

      res.json({
        data: { invocationId: req.params.invocationId, sessionId: req.params.invocationId, messageId: message.id },
      })
    },

    /**
     * Open one in-flight sealed trace step the moment the bot's loop starts it —
     * the external sibling of the enclave's `/steps/started`. Content is sealed
     * when already known (reasoning/reply) and absent for tools (no result yet);
     * only `stepType` is clear. A later sealed `/steps` finalizes this `stepId` in
     * place. The whole sealed path is dark until `externalSealedDelivery` flips.
     */
    async startBotInvocationSealedStep(req: Request, res: Response) {
      const data = validateRequest(startSealedInvocationStepSchema, req.body)
      const { session, stream, bot, callbackToken } = await authorizeSealedInvocationCallback(req)
      assertReplyKeyGeneration(session, data.envelope)

      // Insert the in-flight row (no completed_at) + current_step_type in one
      // transaction (INV-6) so a reader never sees the step without its type;
      // step_number is computed atomically in the INSERT (INV-20).
      let persisted: AgentSessionStep
      try {
        persisted = await withTransaction(pool, async (tx) => {
          const callbackParams = {
            workspaceId: stream.workspaceId,
            botId: bot.id,
            invocationId: session.id,
            claimToken: callbackToken,
          }
          const snapshot = await botRuntimeService.findInvocationForCallback(tx, callbackParams)
          if (!snapshot || snapshot.status !== "claimed" || snapshot.responseStreamId !== session.streamId) {
            throw invocationClaimNotFound()
          }
          await assertStreamWritable(tx, {
            workspaceId: stream.workspaceId,
            streamId: snapshot.responseStreamId,
            principal: { kind: "bot", botId: bot.id },
          })
          const claim = await botRuntimeService.findActiveClaimForUpdateByToken(tx, callbackParams)
          if (!claim || claim.responseStreamId !== snapshot.responseStreamId) {
            throw invocationClaimNotFound()
          }
          const created = await AgentSessionRepository.appendStep(tx, {
            id: data.stepId,
            sessionId: session.id,
            stepType: data.stepType,
            messageId: data.messageId,
            contentCiphertext: data.ciphertext,
            contentEnvelope: data.envelope,
            startedAt: new Date(),
          })
          await AgentSessionRepository.updateCurrentStepType(tx, session.id, data.stepType)
          return created
        })
      } catch (error) {
        await terminalizeBotDenial({
          error,
          session,
          stream,
          botId: bot.id,
          callbackToken,
        })
        throw error
      }

      io.to(`ws:${stream.workspaceId}:agent_session:${session.id}`).emit("agent_session:step:started", {
        sessionId: session.id,
        step: serializeTraceStep(persisted),
      })
      emitBotSealedProgress(io, { stream, session, bot }, persisted)

      res.json({ data: { invocationId: session.id, sessionId: session.id, stepId: persisted.id } })
    },

    /**
     * Finalize one sealed trace step in place when it completes — the HTTP
     * adapter over the shared `recordSealedSteps` write-op (the WS
     * `bot:invocation:sealed-steps` frame drives the same op, so the two
     * transports can never diverge). The external sibling of the enclave's
     * `/steps`.
     */
    async recordBotInvocationSealedStep(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(recordSealedInvocationStepSchema, req.body)
      const result = await botRuntimeWriteOps.recordSealedSteps({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        callbackToken: req.header(THREA_CALLBACK_TOKEN_HEADER) ?? "",
        steps: [data],
      })
      res.json({
        data: { invocationId: result.invocationId, sessionId: result.sessionId, stepId: result.steps[0].stepId },
      })
    },

    async sendBotInvocationSealedMessage(req: Request, res: Response) {
      const data = validateRequest(sendSealedInvocationMessageSchema, req.body)
      const { session, stream, bot, callbackToken } = await authorizeSealedInvocationCallback(req, {
        acceptCompletedSession: true,
        acceptFailedSession: true,
      })
      assertReplyKeyGeneration(session, data.envelope)

      let message: Message
      try {
        message = await withTransaction(pool, async (tx) => {
          const callbackParams = {
            workspaceId: stream.workspaceId,
            botId: bot.id,
            invocationId: session.id,
            claimToken: callbackToken,
          }
          const snapshot = await botRuntimeService.findInvocationForCallback(tx, callbackParams)
          if (!snapshot || snapshot.responseStreamId !== session.streamId) {
            throw invocationClaimNotFound()
          }
          const [authority] = await resolveLockedStreamAuthorities(tx, {
            workspaceId: stream.workspaceId,
            streamIds: [snapshot.responseStreamId],
            principal: { kind: "bot", botId: bot.id },
          })
          const existing = await findOwnTurnMessageByClientId(tx, {
            streamId: snapshot.responseStreamId,
            clientMessageId: data.messageId,
            botId: bot.id,
            sessionId: session.id,
            expectedId: data.messageId,
          })
          if (existing) return existing
          if (snapshot.status !== "claimed" && snapshot.status !== "completed") {
            throw invocationClaimNotFound()
          }
          assertViewerStreamWritable(authority.state)
          // Keep stream, invocation, and session lock order aligned with completion.
          const activeClaim = await botRuntimeService.findActiveClaimForUpdateByToken(tx, callbackParams)
          const claim = activeClaim ?? (await botRuntimeService.findCompletedInvocationForReplay(tx, callbackParams))
          if (!claim || claim.responseStreamId !== snapshot.responseStreamId) {
            throw invocationClaimNotFound()
          }
          const locked = await AgentSessionRepository.findByIdForUpdate(tx, session.id)
          if (activeClaim) assertSessionRunningOrFailed(locked)
          else assertSessionRunningOrCompleted(locked)
          if (locked.personaId !== bot.id) {
            throw new HttpError("Session does not belong to this bot", { status: 403, code: "FORBIDDEN" })
          }
          if (locked.streamId !== claim.responseStreamId) throw invocationClaimNotFound()
          if (!activeClaim) {
            await assertCompletedClaimStillLinked(tx, {
              workspaceId: stream.workspaceId,
              botId: bot.id,
              invocation: claim,
            })
          }
          return (
            await eventService.createMessageForPrincipalInTransaction(
              tx,
              { kind: "bot", botId: bot.id },
              {
                id: data.messageId,
                workspaceId: stream.workspaceId,
                streamId: locked.streamId,
                sessionId: locked.id,
                authorId: bot.id,
                authorType: AuthorTypes.BOT,
                contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
                contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
                ciphertext: Buffer.from(data.ciphertext, "base64"),
                envelope: data.envelope,
                e2eVersion: 2,
                // Restrict the bot's reach to this scratchpad, mirroring the sealed
                // completion reply; the client-minted id dedupes a redelivered post.
                accessibleStreamIds: [locked.streamId],
                clientMessageId: data.messageId,
                ...(data.attachmentIds && data.attachmentIds.length > 0 && { attachmentIds: data.attachmentIds }),
              }
            )
          ).message
        })
      } catch (error) {
        await terminalizeBotDenial({ error, session, stream, botId: bot.id, callbackToken })
        throw error
      }

      res.json({ data: { messageId: message.id } })
    },

    /**
     * Complete a sealed bot turn — the external sibling of the enclave's
     * `/complete` and the sealed variant of the plaintext `completeBotInvocation`.
     * Unlike the enclave (which streams each reply to `/messages` and acks here),
     * the bot path delivers its single sealed reply inline, exactly as the
     * plaintext bot complete does — only the body is ciphertext the server can't
     * read (INV-E7). In one transaction (INV-7): persist the sealed reply (when
     * present), flip the `bot_invocations` claim, and finalize the session
     * lifecycle (status + the `agent_session:completed` event/outbox), so the
     * claimable set, the message, and the lifecycle event can never diverge. No
     * reply-only trace synthesis (the plaintext floor needs cleartext we don't
     * have); the trace is whatever sealed steps the harness already POSTed. The
     * whole path is dark until `externalSealedDelivery` flips.
     *
     * Two things the plaintext sibling does are deliberately absent: the
     * runtime-command `command:completed` event (a runtime command requires the
     * SESSION_CONTROL capability, and the claim path never seals a session-control
     * invocation — so a sealed completion is never a runtime command), and the
     * `assertManifestAllows` reject-undeclared gate (it keys off the runtime's
     * declared manifest, looked up by `instanceId`, which the header-auth model
     * omits — the sealed grant is the capability proof here).
     */
    async completeBotInvocationSealed(req: Request, res: Response) {
      const data = validateRequest(completeSealedInvocationSchema, req.body)
      let callbackContext: Awaited<ReturnType<typeof authorizeSealedInvocationCallback>>
      try {
        callbackContext = await authorizeSealedInvocationCallback(req, { acceptFailedSession: true })
      } catch (error) {
        if (!req.botApiKey) throw error
        const callbackToken = req.header(THREA_CALLBACK_TOKEN_HEADER) ?? ""
        const replay = await withTransaction(pool, (client) =>
          resolveCompletedInvocationReplay(client, {
            workspaceId: req.workspaceId!,
            botId: req.botApiKey!.botId,
            invocationId: req.params.invocationId,
            claimToken: callbackToken,
          })
        )
        if (!replay || (data.reply ? replay.message?.id !== data.reply.messageId : replay.message !== null)) {
          throw error
        }
        res.json({
          data: {
            invocationId: replay.invocationId,
            sessionId: replay.sessionId,
            messageId: replay.message?.id ?? null,
          },
        })
        return
      }
      const { session, stream, bot, callbackToken } = callbackContext
      if (data.reply) assertReplyKeyGeneration(session, data.reply.envelope)

      let completion:
        | { kind: "completed"; message: Message | null; sessionFinalized: boolean }
        | { kind: "replay"; replay: { invocationId: string; sessionId: string; message: Message | null } }
        | { kind: "stale" }
      try {
        completion = await withTransaction(pool, async (client) => {
          const callbackParams = {
            workspaceId: req.workspaceId!,
            botId: bot.id,
            invocationId: session.id,
            claimToken: callbackToken,
          }
          const snapshot = await botRuntimeService.findInvocationForCallback(client, callbackParams)
          if (!snapshot) throw invocationClaimNotFound()
          if (snapshot.status === "completed") {
            assertSessionRunningOrCompleted(session)
            const replay = await resolveCompletedInvocationReplay(client, callbackParams)
            if (!replay || (data.reply ? replay.message?.id !== data.reply.messageId : replay.message !== null)) {
              throw invocationClaimNotFound()
            }
            return { kind: "replay", replay }
          }

          let authorityLocked = false
          if (data.reply) {
            const [authority] = await resolveLockedStreamAuthorities(client, {
              workspaceId: stream.workspaceId,
              streamIds: [session.streamId],
              principal: { kind: "bot", botId: bot.id },
            })
            const completedInvocation = await botRuntimeService.findCompletedInvocationForReplay(client, callbackParams)
            if (completedInvocation) {
              assertSessionRunningOrCompleted(session)
              const replay = await loadCompletedInvocationReplay(client, completedInvocation, bot.id, callbackToken)
              if (!replay || replay.message?.id !== data.reply.messageId) {
                throw invocationClaimNotFound()
              }
              return { kind: "replay" as const, replay }
            }
            assertViewerStreamWritable(authority.state)
            authorityLocked = true
          }

          // FAILED reaches the write path only after this active claim lock succeeds.
          const claim = await botRuntimeService.findActiveClaimForUpdateByToken(client, callbackParams)
          if (
            claim &&
            !(await botRuntimeService.validateClaimSourceForCompletion(client, claim, data.sourceRevision))
          ) {
            await botRuntimeService.reconcileStaleCompletionInTransaction(client, claim)
            return { kind: "stale" as const }
          }
          if (!claim) {
            assertSessionRunningOrCompleted(session)
            const replay = authorityLocked
              ? await botRuntimeService
                  .findCompletedInvocationForReplay(client, callbackParams)
                  .then((invocation) =>
                    invocation ? loadCompletedInvocationReplay(client, invocation, bot.id, callbackToken) : null
                  )
              : await resolveCompletedInvocationReplay(client, callbackParams)
            if (!replay || (data.reply ? replay.message?.id !== data.reply.messageId : replay.message !== null)) {
              throw invocationClaimNotFound()
            }
            return { kind: "replay", replay }
          }
          if (claim.responseStreamId !== session.streamId) {
            throw invocationClaimNotFound()
          }

          const reply = data.reply
          const message = reply
            ? (
                await eventService.createMessageForPrincipalInTransaction(
                  client,
                  { kind: "bot", botId: bot.id },
                  {
                    id: reply.messageId,
                    workspaceId: stream.workspaceId,
                    streamId: session.streamId,
                    sessionId: session.id,
                    authorId: bot.id,
                    authorType: AuthorTypes.BOT,
                    contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
                    contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
                    ciphertext: Buffer.from(reply.ciphertext, "base64"),
                    envelope: reply.envelope,
                    e2eVersion: 2,
                    // Restrict the bot's reach to this scratchpad and dedupe a redelivered
                    // completion (one reply per invocation), mirroring the enclave reply.
                    accessibleStreamIds: [session.streamId],
                    clientMessageId: `bot-invocation:${session.id}`,
                    ...(reply.attachmentIds &&
                      reply.attachmentIds.length > 0 && {
                        attachmentIds: reply.attachmentIds,
                      }),
                  }
                )
              ).message
            : null

          const completed = await botRuntimeService.completeInvocationInTransaction(client, {
            ...callbackParams,
            sourceRevision: data.sourceRevision ?? claim.claimedSourceMessageRevision!,
          })
          if (!completed) throw invocationClaimNotFound()

          // Finalize the session lifecycle in the same transaction (INV-7), gated on
          // winning the RUNNING→COMPLETED transition so a raced redelivery can't
          // double-emit. Plaintext-free: counts + timing only.
          const latestSequence = await eventService.getLatestSequence(session.streamId)
          const finalized = await AgentSessionRepository.completeSession(client, session.id, {
            lastSeenSequence: latestSequence ?? 0n,
            responseMessageId: message?.id ?? null,
            sentMessageIds: message ? [message.id] : [],
            recoverFromFailed: true,
          })
          if (!finalized) return { kind: "completed", message, sessionFinalized: false }

          const completedAt = finalized.completedAt ?? new Date()
          const steps = await AgentSessionRepository.findStepsBySession(client, session.id)
          const streamEvent = await StreamEventRepository.insert(client, {
            id: eventId(),
            streamId: session.streamId,
            eventType: "agent_session:completed",
            payload: {
              sessionId: session.id,
              stepCount: steps.length,
              messageCount: message ? 1 : 0,
              duration: completedAt.getTime() - finalized.createdAt.getTime(),
              completedAt: completedAt.toISOString(),
            },
            actorId: bot.id,
            actorType: AuthorTypes.BOT,
          })
          await OutboxRepository.insert(client, "agent_session:completed", {
            workspaceId: stream.workspaceId,
            streamId: session.streamId,
            rootStreamId: stream.rootStreamId ?? stream.id,
            event: streamEvent,
          })
          return { kind: "completed", message, sessionFinalized: true }
        })
      } catch (error) {
        await terminalizeBotDenial({ error, session, stream, botId: bot.id, callbackToken })
        throw error
      }

      if (completion.kind === "stale") throw invocationInputStale()
      if (completion.kind === "replay") {
        res.json({
          data: {
            invocationId: completion.replay.invocationId,
            sessionId: completion.replay.sessionId,
            messageId: completion.replay.message?.id ?? null,
          },
        })
        return
      }

      const { message, sessionFinalized } = completion
      // Live-update an open trace dialog (session room) the way the enclave/in-process
      // completes do — the outbox broadcast does not reach the session room, so the
      // dialog wouldn't otherwise transition until a refetch.
      if (sessionFinalized) {
        io.to(`ws:${stream.workspaceId}:agent_session:${session.id}`).emit("agent_session:completed", {
          sessionId: session.id,
        })
      }

      res.json({ data: { invocationId: session.id, sessionId: session.id, messageId: message?.id ?? null } })
    },

    async completeBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(completeInvocationSchema, req.body)
      const [bot, runtimePresence] = await Promise.all([
        BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId),
        botRuntimeService.findPresenceByInstance({
          workspaceId: req.workspaceId!,
          botId: req.botApiKey.botId,
          instanceId: data.instanceId,
        }),
      ])
      const contentMarkdown =
        data.noResponse === true || !data.finalMessageMarkdown ? null : normalizeMessage(data.finalMessageMarkdown)
      if (!bot || (bot.archivedAt && (contentMarkdown || data.sealedReply))) {
        throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      }
      // Reject-undeclared (INV-11): a runtime that declared a manifest may only
      // emit what it declared. Unenforced for legacy (null-manifest) runtimes.
      const manifest = runtimePresence?.manifest ?? null
      if (contentMarkdown) assertManifestAllows(manifest, "reply")
      if (data.sources && data.sources.length > 0) assertManifestAllows(manifest, "sources")
      const contentJson = contentMarkdown ? parseMarkdown(contentMarkdown, undefined, toEmoji) : null
      const attachmentIds = contentJson ? collectAttachmentReferenceIds(contentJson) : []
      let denialSession: Awaited<ReturnType<typeof AgentSessionRepository.findById>> = null
      const { completed, message, sessionFinalized, synthesizedSteps, replay, stale } = await withTransaction(
        pool,
        async (client) => {
          const callbackParams = {
            workspaceId: req.workspaceId!,
            botId: req.botApiKey!.botId,
            invocationId: req.params.invocationId,
            instanceId: data.instanceId,
            claimToken: data.claimToken,
          }
          const snapshot = await botRuntimeService.findInvocationForCallback(client, callbackParams)
          if (!snapshot) throw invocationClaimNotFound()
          if (snapshot.status === "completed") {
            const replay = await resolveCompletedInvocationReplay(client, callbackParams)
            if (!replay) throw invocationClaimNotFound()
            return { completed: null, message: null, sessionFinalized: false, synthesizedSteps: [], replay }
          }
          denialSession = await AgentSessionRepository.findById(client, snapshot.id)

          let authorityLocked = false
          if (data.sealedReply || contentMarkdown) {
            const [authority] = await resolveLockedStreamAuthorities(client, {
              workspaceId: req.workspaceId!,
              streamIds: [snapshot.responseStreamId],
              principal: { kind: "bot", botId: bot.id },
            })
            const completedInvocation = await botRuntimeService.findCompletedInvocationForReplay(client, callbackParams)
            if (completedInvocation) {
              const replay = await loadCompletedInvocationReplay(client, completedInvocation, bot.id, data.claimToken)
              if (!replay) throw invocationClaimNotFound()
              return { completed: null, message: null, sessionFinalized: false, synthesizedSteps: [], replay }
            }
            assertViewerStreamWritable(authority.state)
            authorityLocked = true
          }

          const claim = await botRuntimeService.findActiveClaimForUpdate(client, callbackParams)
          if (
            claim &&
            !(await botRuntimeService.validateClaimSourceForCompletion(client, claim, data.sourceRevision))
          ) {
            await botRuntimeService.reconcileStaleCompletionInTransaction(client, claim)
            return {
              completed: null,
              message: null,
              sessionFinalized: false,
              synthesizedSteps: [],
              replay: null,
              stale: true as const,
            }
          }
          if (!claim) {
            const replay = authorityLocked
              ? await botRuntimeService
                  .findCompletedInvocationForReplay(client, callbackParams)
                  .then((invocation) =>
                    invocation ? loadCompletedInvocationReplay(client, invocation, bot.id, data.claimToken) : null
                  )
              : await resolveCompletedInvocationReplay(client, callbackParams)
            if (!replay) throw invocationClaimNotFound()
            return { completed: null, message: null, sessionFinalized: false, synthesizedSteps: [], replay }
          }
          if (claim.responseStreamId !== snapshot.responseStreamId) {
            throw invocationClaimNotFound()
          }
          // E2EE-2: a plaintext completion MESSAGE into an E2E stream would break
          // the sealed timeline (sealed replies go to /sealed-complete instead),
          // so reject it loudly — but only when there is content to persist. A
          // `noResponse` completion writes no message row and must work on E2E
          // streams: session-control invocations (e.g. /model, /steer acks) are
          // dispatched there with plaintext claims, and blocking their close
          // would strand every one of them in a TTL-recycle loop.
          if (contentMarkdown) await assertNotE2eStream(req.workspaceId!, claim.responseStreamId)
          let message: Message | null = null
          if (data.sealedReply) {
            // Sealed session-control ack: the stream MUST be E2E and the seal MUST
            // bind the current generation, or the row is permanently undecryptable.
            const e2e = await E2eStreamsRepository.getByStreamId(client, req.workspaceId!, claim.responseStreamId)
            if (!e2e) {
              throw new HttpError("A sealed reply requires an E2E stream", {
                status: 400,
                code: "SEALED_REPLY_REQUIRES_E2E_STREAM",
              })
            }
            if (data.sealedReply.envelope.keyGeneration !== e2e.currentKeyGeneration) {
              throw new HttpError(
                `Sealed reply uses key generation ${data.sealedReply.envelope.keyGeneration}; the stream is at ${e2e.currentKeyGeneration}`,
                { status: 400, code: "E2E_WRONG_KEY_GENERATION" }
              )
            }
            message = (
              await eventService.createMessageForPrincipalInTransaction(
                client,
                { kind: "bot", botId: bot.id },
                {
                  id: data.sealedReply.messageId,
                  workspaceId: req.workspaceId!,
                  streamId: claim.responseStreamId,
                  authorId: bot.id,
                  authorType: AuthorTypes.BOT,
                  contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
                  contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
                  ciphertext: Buffer.from(data.sealedReply.ciphertext, "base64"),
                  envelope: data.sealedReply.envelope,
                  e2eVersion: 2,
                  accessibleStreamIds: [claim.responseStreamId],
                  clientMessageId: `bot-invocation:${claim.id}`,
                }
              )
            ).message
          } else if (contentMarkdown) {
            message = (
              await eventService.createMessageForPrincipalInTransaction(
                client,
                { kind: "bot", botId: bot.id },
                {
                  workspaceId: req.workspaceId!,
                  streamId: claim.responseStreamId,
                  authorId: bot.id,
                  authorType: AuthorTypes.BOT,
                  contentJson: contentJson!,
                  contentMarkdown,
                  attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
                  clientMessageId: `bot-invocation:${claim.id}`,
                  sources: data.sources,
                  metadata: data.metadata,
                }
              )
            ).message
          }
          const completed = await botRuntimeService.completeInvocationInTransaction(client, {
            workspaceId: req.workspaceId!,
            botId: req.botApiKey!.botId,
            invocationId: req.params.invocationId,
            instanceId: data.instanceId,
            claimToken: data.claimToken,
            sourceRevision: data.sourceRevision ?? claim.claimedSourceMessageRevision!,
          })
          if (!completed) throw invocationClaimNotFound()
          const runtimeCommand = parseRuntimeCommandInvocationMetadata(completed.metadata)
          if (runtimeCommand) {
            await insertCommandCompletedEvent(client, {
              workspaceId: req.workspaceId!,
              streamId: completed.responseStreamId,
              userId: completed.authorUserId,
              commandId: runtimeCommand.id,
              result: {
                invocationId: completed.id,
                ...(message && { messageId: message.id }),
              },
            })
          }
          const session = denialSession ?? (await AgentSessionRepository.findById(client, completed.id))
          // RUNNING is the happy path; FAILED is recoverable here. Reaching this
          // point means the claim was still valid (findActiveClaimForUpdate above
          // succeeded), so the only way the session is FAILED is an orphan
          // false-positive from cleanup's stale-heartbeat scan — the turn really
          // did finish and send its reply, so finalize it COMPLETED rather than
          // leaving the trace stuck red.
          if (session?.status === AgentSessionStatuses.RUNNING || session?.status === AgentSessionStatuses.FAILED) {
            const latestSequence = await eventService.getLatestSequence(completed.responseStreamId)
            const finalizedSession = await AgentSessionRepository.completeSession(client, completed.id, {
              lastSeenSequence: latestSequence ?? 0n,
              responseMessageId: message?.id ?? null,
              sentMessageIds: message ? [message.id] : [],
              recoverFromFailed: true,
            })
            if (finalizedSession) {
              let steps = await AgentSessionRepository.findStepsBySession(client, completed.id)
              // Synthesized-trace floor (N-6): a reply-only harness never POSTed
              // /steps, so reconstruct the minimal context_received → message_sent
              // trace in the same transaction — the completed event's stepCount
              // and the rows land together (INV-7).
              let synthesizedSteps: AgentSessionStep[] = []
              if (steps.length === 0 && message) {
                const author = await UserRepository.findById(client, req.workspaceId!, completed.authorUserId)
                synthesizedSteps = await synthesizeReplyOnlyBotTrace(client, {
                  sessionId: completed.id,
                  trigger: {
                    messageId: completed.sourceMessageId,
                    authorName: author?.name ?? "Unknown",
                    authorType: AuthorTypes.USER,
                    createdAt: completed.createdAt.toISOString(),
                    content: completed.promptMarkdown,
                  },
                  reply: { messageId: message.id, content: contentMarkdown! },
                })
                steps = synthesizedSteps
              }
              const completedAt = finalizedSession.completedAt ?? new Date()
              const streamEvent = await StreamEventRepository.insert(client, {
                id: eventId(),
                streamId: completed.responseStreamId,
                eventType: "agent_session:completed",
                payload: {
                  sessionId: completed.id,
                  stepCount: steps.length,
                  messageCount: message ? 1 : 0,
                  duration: completedAt.getTime() - finalizedSession.createdAt.getTime(),
                  completedAt: completedAt.toISOString(),
                },
                actorId: bot.id,
                actorType: AuthorTypes.BOT,
              })
              await OutboxRepository.insert(client, "agent_session:completed", {
                workspaceId: req.workspaceId!,
                streamId: completed.responseStreamId,
                rootStreamId: completed.rootStreamId,
                event: streamEvent,
              })
              return { completed, message, sessionFinalized: true, synthesizedSteps, replay: null }
            }
          }
          return { completed, message, sessionFinalized: false, synthesizedSteps: [], replay: null }
        }
      ).catch(async (error) => {
        const denial = error as { code?: string }
        if (denialSession && (denial.code === "STREAM_READ_ONLY" || denial.code === "STREAM_NOT_FOUND")) {
          const responseStream = await StreamRepository.findById(pool, denialSession.streamId)
          if (responseStream) {
            await terminalizeBotDenial({
              error,
              session: denialSession,
              stream: responseStream,
              botId: bot.id,
              callbackToken: data.claimToken,
              instanceId: data.instanceId,
            })
          }
        }
        throw error
      })
      if (stale) throw invocationInputStale()
      if (replay) {
        res.json({
          data: {
            invocationId: replay.invocationId,
            message: replay.message ? serializeMessage(replay.message, { authorDisplayName: bot.name }) : null,
          },
          slots: await resolveSlots(req, replay.message ? [replay.message.contentJson] : []),
        })
        return
      }
      // Best-effort live frames for an open trace dialog, emitted after the
      // transaction releases its connection (INV-41) — the durable record is
      // the rows + outbox event committed above. Synthesized steps first, then
      // the terminal status, mirroring a reported run's ordering.
      if (sessionFinalized) {
        try {
          for (const step of synthesizedSteps) {
            io.to(`ws:${req.workspaceId!}:agent_session:${completed.id}`).emit("agent_session:step:completed", {
              sessionId: completed.id,
              step: serializeTraceStep(step),
            })
          }
          io.to(`ws:${req.workspaceId!}:agent_session:${completed.id}`).emit("agent_session:completed", {
            sessionId: completed.id,
          })
        } catch (err) {
          logger.warn({ err, invocationId: completed.id }, "Failed to emit bot invocation completion frames")
        }
      }
      res.json({
        data: {
          invocationId: completed.id,
          message: message ? serializeMessage(message, { authorDisplayName: bot.name }) : null,
        },
        slots: await resolveSlots(req, message ? [message.contentJson] : []),
      })
    },

    async failBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const data = validateRequest(failInvocationSchema, req.body)
      const failed = await withTransaction(pool, async (client) => {
        const failed = await botRuntimeService.failInvocationInTransaction(client, {
          workspaceId: req.workspaceId!,
          botId: req.botApiKey!.botId,
          invocationId: req.params.invocationId,
          instanceId: data.instanceId,
          claimToken: data.claimToken,
          errorMessage: data.errorMessage,
        })
        if (!failed) throw invocationClaimNotFound()

        const runtimeCommand = parseRuntimeCommandInvocationMetadata(failed.metadata)
        if (runtimeCommand) {
          await insertCommandFailedEvent(client, {
            workspaceId: req.workspaceId!,
            streamId: failed.responseStreamId,
            userId: failed.authorUserId,
            commandId: runtimeCommand.id,
            error: data.errorMessage,
          })
        }

        return failed
      })
      res.json({ data: { invocationId: failed.id, status: failed.status } })
    },

    async searchMessages(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { query, semantic, exact, streams, from, type, before, after, limit } = validateRequest(
        publicSearchSchema,
        req.body
      )

      const accessibleStreamIds = await getAccessibleStreamIds(req)

      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [], slots: {} })
      }

      // Replies live in thread streams under the requested streams (INV-62); an
      // unexpanded filter would silently exclude them. A filter that resolves to
      // nothing must return empty, not fall back to an unfiltered search.
      let filterStreamIds: string[] | undefined
      if (streams && streams.length > 0) {
        filterStreamIds = await SearchRepository.expandStreamIdsWithThreads(pool, workspaceId, streams)
        if (filterStreamIds.length === 0) {
          return res.json({ data: [], slots: {} })
        }
      }

      // API keys carry no user for the user layer; the workspace layer decides.
      const searchFlag = await featureFlagService.getWorkspaceFlag(workspaceId, "search")
      const { results } = await searchService.search({
        workspaceId,
        permissions: { accessibleStreamIds },
        query,
        filters: {
          streamIds: filterStreamIds,
          authorId: from,
          streamTypes: type,
          before: before ? new Date(before) : undefined,
          after: after ? new Date(after) : undefined,
        },
        limit,
        exact,
        skipEmbedding: !semantic,
        searchFlag,
      })

      setAuditSubjects(
        res,
        results.map((r) => ({ type: "message", id: r.id }))
      )
      const [authorNames, slots] = await Promise.all([
        resolveAuthorDisplayNames(pool, workspaceId, results),
        resolveSlots(
          req,
          results.map((r) => r.contentJson)
        ),
      ])
      const serialized: WireSearchResult[] = results.map((r) => {
        const name = authorNames.get(r.authorId)
        return {
          ...serializeSearchResult(r),
          ...(name != null && { authorDisplayName: name }),
        }
      })

      res.json({ data: serialized, slots })
    },

    async searchMemos(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { query, exact, streams, memoType, knowledgeType, tags, scope, before, after, limit } = validateRequest(
        searchMemosSchema,
        req.body
      )
      const normalized = normalizeMemoSearchMode(query, exact)
      const accessibleStreamIds = await getAccessibleStreamIds(req, {
        archiveStatus: ["active", "archived"],
      })

      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      // Same expansion as searchMessages: memos captured from thread
      // conversations carry the thread's stream id (INV-62).
      let memoFilterStreamIds: string[] | undefined
      if (streams && streams.length > 0) {
        memoFilterStreamIds = await SearchRepository.expandStreamIdsWithThreads(pool, workspaceId, streams)
        if (memoFilterStreamIds.length === 0) {
          return res.json({ data: [] })
        }
      }

      const results = await memoExplorerService.search({
        workspaceId,
        // A user API key's principal owns its user-scoped memos; a bot key has no
        // user, so user-scoped memos stay invisible to it (roadmap 6.4).
        permissions: { accessibleStreamIds, userId: req.userApiKey ? req.user!.id : undefined },
        query: normalized.query,
        exact: normalized.exact,
        filters: {
          streamIds: memoFilterStreamIds,
          memoTypes: memoType,
          knowledgeTypes: knowledgeType,
          tags,
          scope,
          before: before ? new Date(before) : undefined,
          after: after ? new Date(after) : undefined,
        },
        limit,
      })

      setAuditSubjects(
        res,
        results.map((r) => ({ type: "memo", id: r.memo.id }))
      )
      res.json({ data: results.map(serializeMemoSearchResult) })
    },

    async getMemo(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const memoId = req.params.memoId
      const accessibleStreamIds = await getAccessibleStreamIds(req, {
        archiveStatus: ["active", "archived"],
      })

      const memo = await memoExplorerService.getById(workspaceId, memoId, {
        accessibleStreamIds,
        userId: req.userApiKey ? req.user!.id : undefined,
      })
      if (!memo) {
        throw new HttpError("Memo not found", { status: 404, code: "NOT_FOUND" })
      }

      setAuditSubjects(res, [{ type: "memo", id: memoId }])
      res.json({ data: serializeMemoDetail(memo) })
    },

    async searchAttachments(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { query, streams, contentTypes, limit } = validateRequest(searchAttachmentsSchema, req.body)
      const accessibleStreamIds = await getAccessibleStreamIds(req)
      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      // Expand to thread descendants (INV-62) before intersecting with access.
      const requestedStreamIds = streams?.length
        ? await SearchRepository.expandStreamIdsWithThreads(pool, workspaceId, streams)
        : null
      const filterStreamIds = requestedStreamIds
        ? requestedStreamIds.filter((streamId) => accessibleStreamIds.includes(streamId))
        : accessibleStreamIds

      if (filterStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      const attachments = await AttachmentRepository.searchWithExtractions(pool, {
        workspaceId,
        streamIds: filterStreamIds,
        query,
        contentTypes,
        safetyStatuses: [AttachmentSafetyStatuses.CLEAN],
        limit,
      })

      setAuditSubjects(
        res,
        attachments.map((a) => ({ type: "attachment", id: a.id }))
      )
      res.json({ data: attachments.map(serializeAttachmentSearchResult) })
    },

    async getAttachment(req: Request, res: Response) {
      const attachment = await resolveAccessibleAttachment(req, req.params.attachmentId)
      const extraction = await AttachmentExtractionRepository.findByAttachmentId(pool, attachment.id)

      setAuditSubjects(res, [{ type: "attachment", id: attachment.id }])
      res.json({ data: serializeAttachmentDetail(attachment, extraction) })
    },

    async getAttachmentDownloadUrl(req: Request, res: Response) {
      const attachment = await resolveAccessibleAttachment(req, req.params.attachmentId)
      const data: WireAttachmentUrl = {
        url: await attachmentService.getDownloadUrl(attachment),
        expiresIn: 900,
      }

      setAuditSubjects(res, [{ type: "attachment", id: attachment.id }])
      res.json({ data })
    },

    async listStreams(req: Request, res: Response) {
      const { type, query, after: afterCursor, limit, includeArchived } = validateRequest(listStreamsSchema, req.query)
      const accessibleStreamIds = await getAccessibleStreamIds(req)

      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [], hasMore: false, cursor: null })
      }

      // Cursor pagination disabled when query is provided (relevance ordering)
      const cursor = !query && afterCursor ? decodeCursor(afterCursor) : undefined

      const streams = await StreamRepository.listByIds(pool, req.workspaceId!, accessibleStreamIds, {
        types: type,
        query,
        limit: limit + 1,
        cursorCreatedAt: cursor?.sortKey,
        cursorId: cursor?.id,
        includeArchived: includeArchived === "true",
      })

      const hasMore = streams.length > limit
      const page = hasMore ? streams.slice(0, limit) : streams

      const parentStreamMap = await resolveParentStreams(pool, page)

      const lastStream = page[page.length - 1]
      res.json({
        data: page.map((s) => {
          const parentStream = s.parentStreamId ? parentStreamMap.get(s.parentStreamId) : undefined
          return serializeStream(s, parentStream ? { parentStream } : undefined)
        }),
        hasMore,
        cursor: !query && lastStream ? encodeCursor(lastStream.createdAt, lastStream.id) : null,
      })
    },

    async getStream(req: Request, res: Response) {
      const streamId = req.params.streamId

      await assertStreamAccessible(req, streamId)

      // Archived streams stay retrievable by id (the app opens them read-only);
      // the payload's archivedAt tells the caller. Only list hides them.
      const stream = await StreamRepository.findById(pool, streamId)
      if (!stream) {
        throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
      }

      let context: DisplayNameContext | undefined
      if (stream.type === "thread" && stream.displayName === null && stream.parentStreamId) {
        const parent = await StreamRepository.findById(pool, stream.parentStreamId)
        if (parent) context = { parentStream: parent }
      }

      res.json({ data: serializeStream(stream, context) })
    },

    async updateStream(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const streamId = req.params.streamId

      const { description } = validateRequest(updateStreamSchema, req.body)
      await assertStreamAccessible(req, streamId)

      // Attribute the change (drives the `description_set` timeline event):
      // user keys act as the key owner, workspace keys as the bot. Descriptions
      // are plaintext metadata (never sealed), so unlike message send there's no
      // E2E gate — a description carries no ciphertext.
      let actorId: string
      let actorType: AuthorType
      if (req.userApiKey) {
        actorId = req.user!.id
        actorType = AuthorTypes.USER
      } else if (req.botApiKey) {
        const bot = await BotRepository.findById(pool, workspaceId, req.botApiKey.botId)
        if (!bot || bot.archivedAt) {
          throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
        }
        actorId = bot.id
        actorType = AuthorTypes.BOT
      } else {
        throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
      }

      const principal = req.userApiKey
        ? { kind: "user" as const, userId: req.user!.id }
        : { kind: "bot" as const, botId: req.botApiKey!.botId }
      const updated = await streamService.updateStream(
        streamId,
        { description, actorId, actorType },
        { workspaceId, principal }
      )
      if (!updated || updated.archivedAt) {
        throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
      }

      let context: DisplayNameContext | undefined
      if (updated.type === "thread" && updated.displayName === null && updated.parentStreamId) {
        const parent = await StreamRepository.findById(pool, updated.parentStreamId)
        if (parent) context = { parentStream: parent }
      }

      res.json({ data: serializeStream(updated, context) })
    },

    async listMembers(req: Request, res: Response) {
      const streamId = req.params.streamId
      const workspaceId = req.workspaceId!

      const { after: afterCursor, limit } = validateRequest(listMembersSchema, req.query)

      await assertStreamAccessible(req, streamId)

      const cursor = afterCursor ? decodeCursor(afterCursor) : undefined

      const members = await StreamMemberRepository.listPaginated(pool, streamId, {
        limit: limit + 1,
        cursorJoinedAt: cursor?.sortKey,
        cursorMemberId: cursor?.id,
      })

      const hasMore = members.length > limit
      const page = hasMore ? members.slice(0, limit) : members

      const memberIds = page.map((m) => m.memberId)
      const users = memberIds.length > 0 ? await UserRepository.findByIds(pool, workspaceId, memberIds) : []
      const userMap = new Map(users.map((u) => [u.id, u]))

      const data: WireMember[] = page
        .filter((m) => userMap.has(m.memberId))
        .map((m) => {
          const user = userMap.get(m.memberId)!
          return {
            userId: m.memberId,
            name: user.name,
            slug: user.slug,
            ...(user.avatarUrl != null && { avatarUrl: user.avatarUrl }),
            joinedAt: m.joinedAt.toISOString(),
          }
        })

      const lastMember = page[page.length - 1]
      res.json({
        data,
        hasMore,
        cursor: lastMember ? encodeCursor(lastMember.joinedAt, lastMember.memberId) : null,
      })
    },

    async listMessages(req: Request, res: Response) {
      const streamId = req.params.streamId

      const result = listMessagesSchema.safeParse(req.query)
      if (!result.success) {
        const flat = z.flattenError(result.error)
        return res.status(400).json({
          error: flat.formErrors.length > 0 ? flat.formErrors[0] : "Validation failed",
          details: flat.fieldErrors,
        })
      }

      const { before, after, limit } = result.data

      await assertStreamAccessible(req, streamId)

      const messages = await eventService.getMessages(streamId, {
        limit: limit + 1,
        beforeSequence: before ? BigInt(before) : undefined,
        afterSequence: after ? BigInt(after) : undefined,
      })

      const hasMore = messages.length > limit
      // afterSequence returns ASC from DB — extra probe is at the tail.
      // beforeSequence/default return DESC then reverse to ASC — extra probe is at the head.
      let page = messages
      if (hasMore) {
        page = after ? messages.slice(0, limit) : messages.slice(-limit)
      }

      setAuditSubjects(
        res,
        page.length > 0
          ? [
              {
                type: "stream",
                id: streamId,
                fromSeq: Number(page[0].sequence),
                toSeq: Number(page[page.length - 1].sequence),
              },
            ]
          : [{ type: "stream", id: streamId }]
      )
      const pageMessageIds = page.map((m) => m.id)
      const [authorNames, threadMap, attachmentsByMessage, slots] = await Promise.all([
        resolveAuthorDisplayNames(pool, req.workspaceId!, page),
        StreamRepository.findThreadsForMessageIds(pool, streamId, pageMessageIds),
        AttachmentRepository.findByMessageIds(pool, pageMessageIds),
        resolveSlots(
          req,
          page.map((m) => m.contentJson)
        ),
      ])

      res.json({
        data: page.map((m) =>
          serializeMessage(m, {
            authorDisplayName: authorNames.get(m.authorId) ?? null,
            threadStreamId: threadMap.get(m.id) ?? null,
            attachments: attachmentsByMessage.get(m.id) ?? [],
          })
        ),
        hasMore,
        slots,
      })
    },

    /**
     * Cursor-paginated conversation feed. User keys reuse the board feed's
     * SQL access predicate (INV-62); bot keys filter by the bot's readable
     * roots (public streams + channel grants).
     */
    async listConversations(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const { streamId, status, after, limit } = validateRequest(listConversationsSchema, req.query)

      let scopeRootIds: string[] | undefined
      if (streamId) {
        await assertStreamAccessible(req, streamId)
        const stream = await StreamRepository.findByIdForWorkspace(pool, streamId, workspaceId)
        if (!stream) {
          throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
        }
        scopeRootIds = [stream.rootStreamId ?? stream.id]
      }

      const decoded = after ? decodeCursor(after) : undefined
      const cursor = decoded ? { lastActivityAt: decoded.sortKey.toISOString(), id: decoded.id } : undefined

      let rows: Conversation[]
      if (req.userApiKey) {
        rows = await ConversationRepository.findByWorkspaceForViewer(pool, workspaceId, req.user!.id, {
          status,
          scopeStreamIds: scopeRootIds,
          limit: limit + 1,
          cursor,
        })
      } else if (req.botApiKey) {
        const rootIds =
          scopeRootIds ?? (await botChannelService.getAccessibleStreamIdsForBot(workspaceId, req.botApiKey.botId))
        rows = await ConversationRepository.findByWorkspaceForRoots(pool, workspaceId, rootIds, {
          status,
          limit: limit + 1,
          cursor,
        })
      } else {
        throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
      }

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const streamsById = await resolveConversationStreams(pool, page)
      const last = page[page.length - 1]

      res.json({
        data: page.map((conversation) => serializeConversation(conversation, streamsById.get(conversation.streamId))),
        hasMore,
        cursor: last ? encodeCursor(last.lastActivityAt, last.id) : null,
      })
    },

    async getConversation(req: Request, res: Response) {
      const conversation = await resolveAccessibleConversation(req, req.params.conversationId)
      const streamsById = await resolveConversationStreams(pool, [conversation])
      res.json({
        data: serializeConversation(conversation, streamsById.get(conversation.streamId)),
      })
    },

    /**
     * The conversation's member messages, chronological, cursor-paginated.
     * Membership is bounded (one conversation's `message_ids`), so the page is
     * cut in memory after one batch fetch rather than paginated in SQL.
     */
    async listConversationMessages(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const { after, limit } = validateRequest(listConversationMessagesSchema, req.query)
      const conversation = await resolveAccessibleConversation(req, req.params.conversationId)

      const members = await conversationService.getMessages(conversation.id)
      const sorted = members
        .filter((m) => !m.deletedAt)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))

      const cursor = after ? decodeCursor(after) : undefined
      const remaining = cursor
        ? sorted.filter(
            (m) =>
              m.createdAt.getTime() > cursor.sortKey.getTime() ||
              (m.createdAt.getTime() === cursor.sortKey.getTime() && m.id > cursor.id)
          )
        : sorted
      const page = remaining.slice(0, limit)
      const hasMore = remaining.length > limit

      // A conversation can span its root and that root's threads, so thread
      // lookups group by each message's own stream.
      const byStream = new Map<string, string[]>()
      for (const m of page) {
        const ids = byStream.get(m.streamId) ?? []
        ids.push(m.id)
        byStream.set(m.streamId, ids)
      }
      const pageMessageIds = page.map((m) => m.id)
      const [authorNames, threadMaps, attachmentsByMessage, slots] = await Promise.all([
        resolveAuthorDisplayNames(pool, workspaceId, page),
        Promise.all(
          [...byStream.entries()].map(([sid, ids]) => StreamRepository.findThreadsForMessageIds(pool, sid, ids))
        ),
        AttachmentRepository.findByMessageIds(pool, pageMessageIds),
        resolveSlots(
          req,
          page.map((m) => m.contentJson)
        ),
      ])
      const threadMap = new Map(threadMaps.flatMap((m) => [...m.entries()]))
      const lastMessage = page[page.length - 1]

      res.json({
        data: page.map((m) =>
          serializeMessage(m, {
            authorDisplayName: authorNames.get(m.authorId) ?? null,
            threadStreamId: threadMap.get(m.id) ?? null,
            attachments: attachmentsByMessage.get(m.id) ?? [],
          })
        ),
        hasMore,
        cursor: lastMessage ? encodeCursor(lastMessage.createdAt, lastMessage.id) : null,
        slots,
      })
    },

    /**
     * Find messages by metadata (AND-containment), scoped to streams accessible
     * to this API key. Intended for dedup flows — e.g. "has a message already
     * been posted for this GitHub PR event?".
     */
    async findMessagesByMetadata(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { metadata, streamId, limit } = validateRequest(findMessagesByMetadataSchema, req.body)

      const accessibleStreamIds = await getAccessibleStreamIds(req)
      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [], slots: {} })
      }

      const messages = await eventService.findByMetadata({
        streamIds: accessibleStreamIds,
        filter: metadata,
        streamId,
        limit,
      })

      if (messages.length === 0) {
        return res.json({ data: [], slots: {} })
      }

      const [authorNames, slots] = await Promise.all([
        resolveAuthorDisplayNames(pool, workspaceId, messages),
        resolveSlots(
          req,
          messages.map((m) => m.contentJson)
        ),
      ])

      setAuditSubjects(
        res,
        messages.map((m) => ({ type: "message", id: m.id }))
      )
      res.json({
        data: messages.map((m) => serializeMessage(m, { authorDisplayName: authorNames.get(m.authorId) ?? null })),
        slots,
      })
    },

    /**
     * Send a message. User-scoped keys send as the user (with sentVia indicator);
     * workspace-scoped keys send as a bot entity.
     */
    async sendMessage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const streamId = req.params.streamId

      const { content, clientMessageId, metadata, conversation } = validateRequest(sendMessageSchema, req.body)

      let principal: { kind: "user"; userId: string } | { kind: "bot"; botId: string } | null = null
      if (req.userApiKey) {
        principal = { kind: "user", userId: req.user!.id }
      } else if (req.botApiKey) {
        principal = { kind: "bot", botId: req.botApiKey.botId }
      }
      if (!principal) throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
      await eventService.assertStreamWritableForPrincipal(principal, workspaceId, streamId)
      await assertNotE2eStream(workspaceId, streamId)

      const contentMarkdown = normalizeMessage(content)
      const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)
      // Derive inline `attachment:` ids from the parsed contentJson so the
      // create-time access gate runs and the attachment_references projection
      // gets written. Public-API senders can post markdown like `[Image
      // #1](attachment:att_x)`; without this they'd persist a message that
      // references an attachment without ever validating read access. The
      // schema doesn't accept fresh-upload ids today, so this list IS the
      // full set.
      const attachmentIds = collectAttachmentReferenceIds(contentJson)

      if (req.userApiKey) {
        const user = req.user!

        const { message, conversationId } = await eventService.createMessageForPrincipalReturningConversation(
          { kind: "user", userId: user.id },
          {
            workspaceId,
            streamId,
            authorId: user.id,
            authorType: AuthorTypes.USER,
            contentJson,
            contentMarkdown,
            attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
            clientMessageId,
            sentVia: sentViaApiKey(req.userApiKey.id),
            metadata,
            conversation,
          }
        )

        res.status(201).json({
          data: serializeMessage(message, { authorDisplayName: user.name }),
          ...(conversationId && { conversationId }),
          slots: await resolveSlots(req, [message.contentJson]),
        })
        return
      }

      if (req.botApiKey) {
        const bot = await BotRepository.findById(pool, workspaceId, req.botApiKey.botId)
        if (!bot || bot.archivedAt) {
          throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
        }

        // Stamp the message with the bot's running session so it deep-links to
        // the trace (parity with the enclave path). Bot invocations register the
        // session on `responseStreamId` under `personaId = bot.id`; match only a
        // session on this exact stream owned by this bot — a plaintext send with
        // no active invocation stays unstamped (bots CAN post without a claim).
        // Known limitation: if a prior invocation's session sticks at
        // status='running' (missed terminal event), a later unrelated plaintext
        // send by the same bot on this stream mis-stamps to that stale session.
        // The partial unique index caps it at one running session per stream, so
        // this only misfires under the abnormal stuck-running state.
        const runningSession = await AgentSessionRepository.findRunningByStream(pool, streamId)
        const sessionId = runningSession?.personaId === bot.id ? runningSession.id : undefined

        const { message, conversationId } = await eventService.createMessageForPrincipalReturningConversation(
          { kind: "bot", botId: bot.id },
          {
            workspaceId,
            streamId,
            authorId: bot.id,
            authorType: AuthorTypes.BOT,
            contentJson,
            contentMarkdown,
            attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
            clientMessageId,
            metadata,
            conversation,
            sessionId,
          }
        )

        res.status(201).json({
          data: serializeMessage(message, { authorDisplayName: bot.name }),
          ...(conversationId && { conversationId }),
          slots: await resolveSlots(req, [message.contentJson]),
        })
        return
      }

      throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
    },

    async updateMessage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const messageId = req.params.messageId

      const result = updateMessageSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { content } = result.data
      const { message: existing, actorId, actorType, displayName } = await resolveMessageMutation(messageId, req)

      const contentMarkdown = normalizeMessage(content)
      const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)
      // Refresh attachment_references projection to match the new contentJson
      // (INV-7) — same derivation as the user UI handler and the agent adapter.
      const attachmentIds = collectAttachmentReferenceIds(contentJson)

      const updated = await eventService.editMessageForPrincipal(
        actorType === AuthorTypes.BOT ? { kind: "bot", botId: actorId } : { kind: "user", userId: actorId },
        {
          workspaceId,
          messageId,
          streamId: existing?.streamId ?? "stream_missing",
          contentJson,
          contentMarkdown,
          actorId,
          actorType,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        }
      )

      if (!updated) {
        throw new HttpError("Message not found or was deleted", { status: 404, code: "NOT_FOUND" })
      }

      const [thread, slots] = await Promise.all([
        StreamRepository.findByAnchor(pool, updated.streamId, messageId),
        resolveSlots(req, [updated.contentJson]),
      ])
      res.json({
        data: serializeMessage(updated, {
          authorDisplayName: displayName,
          threadStreamId: thread?.id ?? null,
        }),
        slots,
      })
    },

    async deleteMessage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const messageId = req.params.messageId

      const { message: existing, actorId, actorType } = await resolveMessageMutation(messageId, req)

      const deleted = await eventService.deleteMessageForPrincipal(
        actorType === AuthorTypes.BOT ? { kind: "bot", botId: actorId } : { kind: "user", userId: actorId },
        {
          workspaceId,
          messageId,
          streamId: existing?.streamId ?? "stream_missing",
          actorId,
          actorType,
        }
      )

      if (!deleted) {
        throw new HttpError("Message not found or was deleted", { status: 404, code: "NOT_FOUND" })
      }

      res.status(204).send()
    },

    async listUsers(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { query, after: afterCursor, limit } = validateRequest(listUsersSchema, req.query)

      // Cursor pagination disabled when query is provided (relevance ordering)
      const cursor = !query && afterCursor ? decodeCursor(afterCursor) : undefined

      const users = await UserRepository.listByWorkspace(pool, workspaceId, {
        query,
        limit: limit + 1,
        cursorJoinedAt: cursor?.sortKey,
        cursorId: cursor?.id,
      })

      const hasMore = users.length > limit
      const page = hasMore ? users.slice(0, limit) : users

      const lastUser = page[page.length - 1]
      res.json({
        data: page.map(serializeUser),
        hasMore,
        cursor: !query && lastUser ? encodeCursor(lastUser.joinedAt, lastUser.id) : null,
      })
    },

    /**
     * Returns the authenticated principal. Used by clients (e.g. the OpenClaw
     * channel plugin) to verify their key and discover their identity after
     * pairing. No scope required — being authenticated is sufficient.
     */
    async getMe(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      // Version introspection for agents: the key's pin (null = unpinned,
      // tracks current), what this request resolved to (req.apiVersion, set by
      // the version gate), and the full supported list.
      const apiVersion = {
        pinned: req.userApiKey ? req.userApiKey.apiVersion : (req.botApiKey?.apiVersion ?? null),
        resolved: req.apiVersion ?? CURRENT_API_VERSION,
        current: CURRENT_API_VERSION,
        supported: [...API_VERSIONS],
      }

      if (req.userApiKey) {
        const user = req.user!
        res.json({
          data: {
            kind: "user",
            workspaceId,
            userId: user.id,
            apiVersion,
          },
        })
        return
      }

      if (req.botApiKey) {
        const bot = await BotRepository.findById(pool, workspaceId, req.botApiKey.botId)
        if (!bot) {
          throw new HttpError("Bot not found", { status: 404, code: "NOT_FOUND" })
        }
        res.json({
          data: {
            kind: "bot",
            workspaceId,
            botId: bot.id,
            botType: bot.type,
            traits: bot.traits,
            ownerUserId: bot.ownerUserId,
            apiVersion,
          },
        })
        return
      }

      throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
    },

    /**
     * For user-scoped keys: returns the authenticated user's personal bots,
     * optionally filtered by trait. Frontend uses this to enumerate
     * "New scratchpad with <bot>" quick-switcher commands.
     *
     * Bot-scoped keys get 403 — bots don't own bots.
     */
    async listMyBots(req: Request, res: Response) {
      if (req.botApiKey) {
        throw new HttpError("Bot keys cannot list personal bots", { status: 403, code: "FORBIDDEN" })
      }
      if (!req.userApiKey) {
        throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
      }

      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const query = validateRequest(listMyBotsSchema, req.query)
      const traits = query.traits ? [query.traits] : []

      const bots = await BotRepository.listByOwner(pool, workspaceId, userId, { traits })
      res.json({ data: bots.map(serializeBot) })
    },

    async listLabels(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const actor = await resolveLabelActor(req, pool)
      const [labels, assignments] = await Promise.all([
        labelService.listForActor(workspaceId, actor.id),
        labelAssignmentService.listForViewer(workspaceId, actor),
      ])
      res.json({
        data: {
          labels: labels.map(serializeLabel),
          assignments: assignments.map(serializeLabelAssignment),
        },
      })
    },

    async createLabel(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const actor = await resolveLabelActor(req, pool)
      const body = validateRequest(createLabelSchema, req.body)
      const label = await labelService.upsertByName({
        workspaceId,
        actor,
        name: body.name,
        color: body.color,
        emoji: body.emoji,
        description: body.description,
      })
      res.status(201).json({ data: serializeLabel(label) })
    },

    async updateLabel(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const actor = await resolveLabelActor(req, pool)
      const { labelId } = validateRequest(labelIdParamSchema, req.params)
      const body = validateRequest(updateLabelSchema, req.body)
      const label = await labelService.update({
        workspaceId,
        actor,
        labelId,
        name: body.name,
        color: body.color,
        emoji: body.emoji,
        description: body.description,
      })
      res.json({ data: serializeLabel(label) })
    },

    async deleteLabel(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const actor = await resolveLabelActor(req, pool)
      const { labelId } = validateRequest(labelIdParamSchema, req.params)
      await labelService.archive({ workspaceId, actor, labelId })
      res.status(204).end()
    },

    async assignLabel(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const actor = await resolveLabelActor(req, pool)
      const body = validateRequest(assignLabelByNameSchema, req.body)
      const { label, assignment } = await labelAssignmentService.assignByName({
        workspaceId,
        actor,
        name: body.name,
        color: body.color,
        emoji: body.emoji,
        description: body.description,
        resourceType: body.resourceType,
        resourceId: body.resourceId,
      })
      res.status(201).json({ data: { label: serializeLabel(label), assignment: serializeLabelAssignment(assignment) } })
    },

    async unassignLabel(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const actor = await resolveLabelActor(req, pool)
      const query = validateRequest(unassignLabelByNameSchema, req.query)
      await labelAssignmentService.unassignByName({
        workspaceId,
        actor,
        name: query.name,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
      })
      res.status(204).end()
    },
  }
}
