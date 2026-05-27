import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import type { SearchFilters, SearchService } from "../search"
import { serializeSearchResult, resolveUserAccessibleStreamIds } from "../search"
import { BotChannelAccessRepository, type BotChannelService } from "../api-keys"
import type { EventService } from "../messaging"
import {
  StreamRepository,
  StreamEventRepository,
  StreamMemberRepository,
  getEffectiveDisplayName,
  type Stream,
  type DisplayNameContext,
  type StreamService,
} from "../streams"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "../agents"
import { type Memo, type MemoExplorerService, type MemoExplorerDetail, type MemoExplorerResult } from "../memos"
import {
  AttachmentExtractionRepository,
  AttachmentRepository,
  type Attachment,
  type AttachmentExtraction,
  type AttachmentWithExtraction,
  type AttachmentService,
  toAttachmentSummary,
} from "../attachments"
import { BotRepository, type Bot } from "./bot-repository"
import {
  AgentSessionStatuses,
  AttachmentSafetyStatuses,
  AuthorTypes,
  BotInvocationCapabilities,
  BotRuntimeKinds,
  PI_TOOL_TRACE_FORMAT,
  PI_TOOL_TRACE_SECTION_LABELS,
  PiToolTraceSectionLabels,
  sentViaApiKey,
  type AuthorType,
  type PiToolTraceSectionLabel,
} from "@threa/types"
import { BotRuntimeService, type BotRuntimeInstance } from "../bot-runtimes"
import {
  insertCommandCompletedEvent,
  insertCommandFailedEvent,
  parseRuntimeCommandInvocationMetadata,
} from "../commands"
import type { BotRuntimeKind, BotRuntimeStatus } from "@threa/types"
import { HttpError } from "@threa/backend-common"
import { normalizeMessage, toEmoji } from "../emoji"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threa/prosemirror"
import { randomUUID } from "crypto"
import { botId, eventId, stepId } from "../../lib/id"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { AgentSessionRepository, type AgentSessionStep } from "../agents"
import { encodeCursor, decodeCursor } from "./cursor"
import { listMyBotsSchema } from "./schemas"
import type {
  WireStream,
  WireMessage,
  WireSearchResult,
  WireUser,
  WireMember,
  WireBot,
  WirePrincipal,
  WireMemoSearchResult,
  WireMemoDetail,
  WireAttachmentSearchResult,
  WireAttachmentDetails,
  WireAttachmentUrl,
  WireAttachmentUpload,
} from "./routes"
import {
  publicSearchSchema,
  listStreamsSchema,
  listMessagesSchema,
  sendMessageSchema,
  updateMessageSchema,
  listMembersSchema,
  listUsersSchema,
  searchMemosSchema,
  searchAttachmentsSchema,
  findMessagesByMetadataSchema,
  upsertPresenceSchema,
  createRuntimeSessionSchema,
  claimInvocationSchema,
  renewInvocationClaimSchema,
  completeInvocationSchema,
  failInvocationSchema,
  recordInvocationStepSchema,
} from "./schemas"

function serializeStream(stream: Stream, context?: DisplayNameContext): WireStream {
  const effective = getEffectiveDisplayName(stream, context)
  const displayName = stream.type === "channel" ? `#${effective.displayName}` : effective.displayName

  return {
    id: stream.id,
    type: stream.type,
    displayName,
    ...(stream.slug != null && { slug: stream.slug }),
    ...(stream.description != null && { description: stream.description }),
    visibility: stream.visibility,
    ...(stream.parentStreamId != null && { parentStreamId: stream.parentStreamId }),
    ...(stream.rootStreamId != null && { rootStreamId: stream.rootStreamId }),
    ...(stream.parentMessageId != null && { parentMessageId: stream.parentMessageId }),
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
    // Always return metadata (possibly empty) so consumers can rely on the shape.
    metadata: message.metadata ?? {},
    ...(opts?.attachments && opts.attachments.length > 0 && { attachments: opts.attachments.map(toAttachmentSummary) }),
    ...(message.editedAt != null && { editedAt: message.editedAt.toISOString() }),
    createdAt: message.createdAt.toISOString(),
  }
}

export function serializeBot(bot: Bot): WireBot {
  const common = {
    id: bot.id,
    workspaceId: bot.workspaceId,
    traits: bot.traits,
    slug: bot.slug,
    name: bot.name,
    description: bot.description,
    avatarEmoji: bot.avatarEmoji,
    avatarUrl: bot.avatarUrl,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  }
  if (bot.type === "personal") {
    return { ...common, type: "personal", ownerUserId: bot.ownerUserId }
  }
  return { ...common, type: "shared", ownerUserId: null }
}

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

/**
 * Batch-resolve display names for message authors across all author types.
 */
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
    // System messages: authorDisplayName stays null — clients use authorType to format
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

export interface PublicApiDeps {
  searchService: SearchService
  memoExplorerService: MemoExplorerService
  attachmentService: AttachmentService
  botChannelService: BotChannelService
  botRuntimeService: BotRuntimeService
  streamService: StreamService
  eventService: EventService
  pool: Pool
  io?: Server
}

const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:sk|rk|pk|lf|wos|gh[a-z]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Authorization|X-Api-Key|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;\"'}]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

function redactSensitiveText(text: string): string {
  let redacted = text
  for (const pattern of SENSITIVE_VALUE_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]")
  return redacted
}

function sanitizeStatusText(statusText?: string | null): string | null {
  const trimmed = redactSensitiveText(statusText?.trim() ?? "")
  if (!trimmed) return null
  const allowed = new Set([
    "Thinking…",
    "Loaded context…",
    "Running shell command…",
    "Reading file…",
    "Reading sensitive file…",
    "Writing file…",
    "Editing file…",
    "Searching files…",
    "Listing directory…",
    "Using tool…",
    "Tool finished",
    "Tool failed",
    "Working…",
    "Composing response…",
    "Sent response",
  ])
  if (allowed.has(trimmed)) return trimmed
  return "Working…"
}

const TRACE_HEADLINE_MAX_CHARS = 200
const TRACE_BODY_MAX_CHARS = 10_000
const TRACE_LANG_MAX_CHARS = 32
const TRACE_MAX_SECTIONS = 16

const TRACE_SECTION_LABEL_SET: ReadonlySet<string> = new Set(PI_TOOL_TRACE_SECTION_LABELS)

interface SafeTraceSection {
  label: PiToolTraceSectionLabel
  body: string
  lang: string | null
}

function clampString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function sanitizeTraceSection(section: unknown): SafeTraceSection | null {
  if (!section || typeof section !== "object" || Array.isArray(section)) return null
  const item = section as Record<string, unknown>
  const rawLabel = typeof item.label === "string" ? item.label : ""
  if (!TRACE_SECTION_LABEL_SET.has(rawLabel)) return null
  const label = rawLabel as PiToolTraceSectionLabel
  if (label === PiToolTraceSectionLabels.ARGUMENTS) {
    return { label, body: "Tool arguments omitted for safety.", lang: null }
  }
  if (label === PiToolTraceSectionLabels.OUTPUT || label === PiToolTraceSectionLabels.ERROR_OUTPUT) {
    return { label, body: "Tool output omitted for safety.", lang: null }
  }
  const body = typeof item.body === "string" ? clampString(redactSensitiveText(item.body), TRACE_BODY_MAX_CHARS) : ""
  const lang = typeof item.lang === "string" ? clampString(item.lang, TRACE_LANG_MAX_CHARS) : null
  return { label, body, lang }
}

// Trace step content is stored as-received from the bot runtime, after
// best-effort sanitization. The official Pi extension is the security
// boundary — it is responsible for never forwarding raw tool stdout, file
// contents, or credentials. Third-party runtimes inherit the trust level
// of the API key holder; the allowlist + regex here is defense-in-depth,
// not a guarantee. Do not loosen this (relax the allowlist, drop the
// length caps, or pass arbitrary fields through) without revisiting the
// threat model — see extensions/pi-remote/ for the trusted-runtime
// contract.
export function sanitizeInvocationStepContent(content: string): string {
  const redacted = redactSensitiveText(content)
  try {
    const parsed = JSON.parse(redacted) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return redacted
    const trace = parsed as Record<string, unknown>
    if (trace.format !== PI_TOOL_TRACE_FORMAT || !Array.isArray(trace.sections)) return redacted
    const headline =
      typeof trace.headline === "string"
        ? clampString(redactSensitiveText(trace.headline), TRACE_HEADLINE_MAX_CHARS)
        : ""
    const sections = trace.sections
      .slice(0, TRACE_MAX_SECTIONS)
      .map(sanitizeTraceSection)
      .filter((section): section is SafeTraceSection => section !== null)
    return JSON.stringify({ format: PI_TOOL_TRACE_FORMAT, headline, sections })
  } catch {
    return redacted
  }
}

function serializeTraceStep(step: AgentSessionStep) {
  return {
    id: step.id,
    sessionId: step.sessionId,
    stepNumber: step.stepNumber,
    stepType: step.stepType,
    content: step.content as string | undefined,
    sources: step.sources ?? undefined,
    messageId: step.messageId ?? undefined,
    tokensUsed: step.tokensUsed ?? undefined,
    duration: step.completedAt && step.startedAt ? step.completedAt.getTime() - step.startedAt.getTime() : undefined,
    startedAt: step.startedAt.toISOString(),
    completedAt: step.completedAt?.toISOString(),
  }
}

export function createPublicApiHandlers({
  searchService,
  memoExplorerService,
  attachmentService,
  botChannelService,
  botRuntimeService,
  streamService,
  eventService,
  pool,
  io,
}: PublicApiDeps) {
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

  /** Find a message, verify stream access, and verify ownership. Used by update/delete. */
  async function resolveOwnedMessage(messageId: string, req: Request) {
    const message = await eventService.getMessageById(messageId)
    if (!message || message.deletedAt) {
      throw new HttpError("Message not found", { status: 404, code: "NOT_FOUND" })
    }

    await assertStreamAccessible(req, message.streamId)

    // User-scoped key: can modify own messages (regardless of how they were sent)
    if (req.userApiKey) {
      if (message.authorId !== req.user!.id) {
        throw new HttpError("Cannot modify another user's messages", {
          status: 403,
          code: "FORBIDDEN",
        })
      }
      return { message, actorId: req.user!.id, actorType: AuthorTypes.USER as AuthorType, displayName: req.user!.name }
    }

    // Bot-scoped key: verify the message was authored by the bot this key belongs to
    if (req.botApiKey) {
      if (message.authorType !== AuthorTypes.BOT || message.authorId !== req.botApiKey.botId) {
        throw new HttpError("Cannot modify messages created by another bot", { status: 403, code: "FORBIDDEN" })
      }
      const bot = await BotRepository.findById(pool, req.workspaceId!, message.authorId)
      if (!bot) {
        throw new HttpError("Bot not found", { status: 404, code: "NOT_FOUND" })
      }
      return { message, actorId: bot.id, actorType: AuthorTypes.BOT as AuthorType, displayName: bot.name }
    }

    throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
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

  /**
   * Fan a presence update out to every stream the bot is a member of. Frontend
   * subscribes via the stream room and patches its cached bootstrap. Keeps the
   * UI in sync without any client-side polling.
   */
  async function broadcastBotPresence(
    workspaceId: string,
    botId: string,
    presence: BotRuntimeInstance | null
  ): Promise<void> {
    if (!io) return
    const streamIds = await BotChannelAccessRepository.getGrantedStreamIds(pool, workspaceId, botId)
    if (streamIds.length === 0) return
    // Only pi-local runtimes create scratchpad session links; skip the lookup
    // when there's no presence or the runtime kind can't have linked sessions.
    const links =
      presence?.runtimeKind === BotRuntimeKinds.PI_LOCAL
        ? await botRuntimeService.findActivePiRemoteSessionsForStreams({ workspaceId, botId, streamIds })
        : new Map<string, { instanceId: string; runtimeSessionId: string }>()
    const payload = {
      workspaceId,
      botId,
      presence: presence
        ? {
            botId: presence.botId,
            runtimeKind: presence.runtimeKind,
            instanceId: presence.instanceId,
            displayName: presence.displayName,
            status: presence.status,
            acceptingInvocations: presence.acceptingInvocations,
            statusText: presence.statusText,
            lastSeenAt: presence.lastSeenAt.toISOString(),
          }
        : null,
    }
    const runtimeSessionId =
      typeof presence?.capabilities.runtimeSessionId === "string" ? presence.capabilities.runtimeSessionId : null
    for (const streamId of streamIds) {
      const link = links.get(streamId)
      const streamPresence =
        link && (!presence || presence.instanceId !== link.instanceId || runtimeSessionId !== link.runtimeSessionId)
          ? null
          : payload.presence
      io.to(`ws:${workspaceId}:stream:${streamId}`).emit("bot_runtime:presence", {
        ...payload,
        presence: streamPresence,
        streamId,
      })
    }
  }

  /**
   * Touch presence as part of an invocation-side request (claim / step) so the
   * Pi runtime does not need to send a separate heartbeat per poll tick. The
   * caller decides which status to record; `statusText` is optional.
   */
  async function touchAndBroadcastPresence(params: {
    workspaceId: string
    botId: string
    runtimeKind: BotRuntimeKind
    instanceId: string
    runtimeSessionId?: string
    status: BotRuntimeStatus
    acceptingInvocations: boolean
    statusText?: string | null
  }): Promise<void> {
    try {
      const presence = await botRuntimeService.upsertPresenceFromBotKey({
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: params.runtimeKind,
        instanceId: params.instanceId,
        status: params.status,
        acceptingInvocations: params.acceptingInvocations,
        capabilities: params.runtimeSessionId ? { runtimeSessionId: params.runtimeSessionId } : undefined,
        statusText: sanitizeStatusText(params.statusText),
        mergeCapabilities: true,
      })
      await broadcastBotPresence(params.workspaceId, params.botId, presence)
    } catch (err) {
      logger.warn(
        { err, workspaceId: params.workspaceId, botId: params.botId },
        "Failed to update bot runtime presence"
      )
    }
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

      const uploadResult = await attachmentService.createForUpload({
        id: attachmentId,
        workspaceId,
        uploadedBy,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storagePath: file.key,
      })

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
      const result = upsertPresenceSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const presence = await botRuntimeService.upsertPresenceFromBotKey({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: result.data.runtimeKind,
        instanceId: result.data.instanceId,
        displayName: result.data.displayName,
        status: result.data.status,
        acceptingInvocations: result.data.acceptingInvocations,
        capabilities: {
          ...result.data.capabilities,
          ...(result.data.runtimeSessionId && { runtimeSessionId: result.data.runtimeSessionId }),
        },
        statusText: sanitizeStatusText(result.data.statusText),
      })
      await broadcastBotPresence(req.workspaceId!, req.botApiKey.botId, presence)
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
      const result = createRuntimeSessionSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      if (bot.type !== "personal") {
        throw new HttpError("Runtime sessions require a personal bot owner", {
          status: 400,
          code: "PERSONAL_BOT_REQUIRED",
        })
      }

      const requiredRuntimeTraits = ["active-scratchpad"] as const

      const existingLink = await botRuntimeService.findActivePiRemoteSession({
        workspaceId: req.workspaceId!,
        botId: bot.id,
        instanceId: result.data.instanceId,
        runtimeSessionId: result.data.runtimeSessionId,
      })
      if (existingLink) {
        await withTransaction(pool, (client) =>
          botRuntimeService.repairBotTraitsInTransaction(client, {
            workspaceId: req.workspaceId!,
            botId: bot.id,
            traits: requiredRuntimeTraits,
          })
        )
        return res.json({
          data: {
            linkId: existingLink.id,
            rootStreamId: existingLink.rootStreamId,
            activeStreamId: existingLink.activeStreamId,
            runtimeSessionId: existingLink.runtimeSessionId,
            streamUrlPath: `/streams/${existingLink.activeStreamId}`,
          },
        })
      }

      const stream = await streamService.createScratchpad({
        workspaceId: req.workspaceId!,
        displayName: result.data.displayName,
        createdBy: bot.ownerUserId,
      })
      await streamService.addBotToStream(stream.id, bot.id, req.workspaceId!, bot.ownerUserId)
      const link = await withTransaction(pool, async (client) => {
        await botRuntimeService.repairBotTraitsInTransaction(client, {
          workspaceId: req.workspaceId!,
          botId: bot.id,
          traits: requiredRuntimeTraits,
        })
        return botRuntimeService.createOrLinkPiRemoteSessionInTransaction(client, {
          workspaceId: req.workspaceId!,
          botId: bot.id,
          instanceId: result.data.instanceId,
          runtimeSessionId: result.data.runtimeSessionId,
          rootStreamId: stream.id,
          activeStreamId: stream.id,
          linkedBy: bot.ownerUserId,
          metadata: { displayName: result.data.displayName, localCwd: result.data.localCwd ?? null },
        })
      })

      res.json({
        data: {
          linkId: link.id,
          rootStreamId: link.rootStreamId,
          activeStreamId: link.activeStreamId,
          runtimeSessionId: link.runtimeSessionId,
          streamUrlPath: `/streams/${stream.id}`,
        },
      })
    },

    async claimBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = claimInvocationSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      // Claim doubles as a heartbeat: refresh presence as "available" on every
      // poll so Pi does not need a separate /presence call per tick. If a claim
      // lands we'll overwrite to "busy" right after.
      await touchAndBroadcastPresence({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: result.data.runtimeKind,
        instanceId: result.data.instanceId,
        runtimeSessionId: result.data.runtimeSessionId,
        status: "available",
        acceptingInvocations: true,
      })
      const invocation = await botRuntimeService.claimNextInvocation({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: result.data.runtimeKind,
        instanceId: result.data.instanceId,
        runtimeSessionId: result.data.runtimeSessionId,
        supportedCapabilities: result.data.supportedCapabilities,
        claimTtlSeconds: result.data.claimTtlSeconds,
        claimToken: randomUUID(),
      })
      if (!invocation) return res.json({ data: null })
      await touchAndBroadcastPresence({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: result.data.runtimeKind,
        instanceId: result.data.instanceId,
        runtimeSessionId: invocation.targetRuntimeSessionId ?? result.data.runtimeSessionId,
        status: "busy",
        acceptingInvocations: false,
      })
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      const isSessionControl = invocation.requiredCapability === BotInvocationCapabilities.SESSION_CONTROL
      if (!isSessionControl && bot && !bot.archivedAt) {
        await withTransaction(pool, async (client) => {
          const latestSequence = await eventService.getLatestSequence(invocation.responseStreamId)
          const session = await AgentSessionRepository.insertRunningOrSkip(client, {
            id: invocation.id,
            streamId: invocation.responseStreamId,
            personaId: bot.id,
            triggerMessageId: invocation.sourceMessageId,
            initialSequence: latestSequence ?? 0n,
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
            event: streamEvent,
          })
        })
      }
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
          authorUserId: invocation.authorUserId,
          mentionedActorSlugs: invocation.mentionedActorSlugs,
          claimToken: invocation.claimToken!,
          claimExpiresAt: invocation.claimExpiresAt!.toISOString(),
          runtimeSessionId: invocation.targetRuntimeSessionId,
          metadata: invocation.metadata,
        },
      })
    },

    async renewBotInvocationClaim(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = renewInvocationClaimSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const renewed = await botRuntimeService.renewInvocationClaim({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        instanceId: result.data.instanceId,
        claimToken: result.data.claimToken,
        claimTtlSeconds: result.data.claimTtlSeconds,
      })
      if (!renewed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
      res.json({
        data: {
          invocationId: renewed.id,
          status: renewed.status,
          claimExpiresAt: renewed.claimExpiresAt?.toISOString() ?? null,
        },
      })
    },

    async recordBotInvocationStep(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = recordInvocationStepSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const claim = await botRuntimeService.findActiveClaim({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        instanceId: result.data.instanceId,
        claimToken: result.data.claimToken,
      })
      if (!claim) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
      await assertStreamAccessible(req, claim.responseStreamId)
      const [bot, runtimePresence] = await Promise.all([
        BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId),
        botRuntimeService.findPresenceByInstance({
          workspaceId: req.workspaceId!,
          botId: req.botApiKey.botId,
          instanceId: result.data.instanceId,
        }),
      ])
      const now = new Date()
      // Append + currentStepType must run in one transaction. appendStep is
      // race-safe for concurrent step POSTs (INV-20), so simultaneous Pi events
      // append distinct rows instead of clobbering each other.
      const step = await withTransaction(pool, async (client) => {
        const inserted = await AgentSessionRepository.appendStep(client, {
          id: stepId(),
          sessionId: claim.id,
          stepType: result.data.stepType,
          content: sanitizeInvocationStepContent(result.data.content),
          startedAt: now,
          completedAt: now,
        })
        await AgentSessionRepository.updateCurrentStepType(client, claim.id, result.data.stepType)
        return inserted
      })
      const sessionRoom = `ws:${req.workspaceId!}:agent_session:${claim.id}`
      io?.to(sessionRoom).emit("agent_session:step:completed", {
        sessionId: claim.id,
        step: serializeTraceStep(step),
      })
      io?.to(`ws:${req.workspaceId!}:stream:${claim.responseStreamId}`).emit("agent_session:progress", {
        workspaceId: req.workspaceId!,
        streamId: claim.responseStreamId,
        sessionId: claim.id,
        triggerMessageId: claim.sourceMessageId,
        personaName: bot?.name ?? "",
        stepCount: step.stepNumber,
        messageCount: 0,
        currentStepType: result.data.stepType,
      })
      // Step recording also serves as a busy heartbeat — keeps the runtime's
      // presence statusText in sync with the most recent trace step so Pi
      // does not need to send a separate /presence call alongside each step.
      // Capabilities is fully overwritten on upsert, so we have to re-supply
      // the runtime's session id for untargeted invocations; otherwise the
      // scratchpad's session-link filter would treat the runtime as stale and
      // hide its presence mid-run.
      const persistedRuntimeSessionId =
        typeof runtimePresence?.capabilities.runtimeSessionId === "string"
          ? runtimePresence.capabilities.runtimeSessionId
          : undefined
      await touchAndBroadcastPresence({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: runtimePresence?.runtimeKind ?? BotRuntimeKinds.PI_LOCAL,
        instanceId: result.data.instanceId,
        runtimeSessionId: claim.targetRuntimeSessionId ?? persistedRuntimeSessionId,
        status: "busy",
        acceptingInvocations: false,
        statusText: sanitizeStatusText(result.data.statusText),
      })
      res.json({ data: { invocationId: claim.id, sessionId: claim.id, stepId: step.id } })
    },

    async completeBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = completeInvocationSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      const contentMarkdown =
        result.data.noResponse === true || !result.data.finalMessageMarkdown
          ? null
          : normalizeMessage(result.data.finalMessageMarkdown)
      const contentJson = contentMarkdown ? parseMarkdown(contentMarkdown, undefined, toEmoji) : null
      const attachmentIds = contentJson ? collectAttachmentReferenceIds(contentJson) : []
      const { completed, message } = await withTransaction(pool, async (client) => {
        const claim = await botRuntimeService.findActiveClaimForUpdate(client, {
          workspaceId: req.workspaceId!,
          botId: req.botApiKey!.botId,
          invocationId: req.params.invocationId,
          instanceId: result.data.instanceId,
          claimToken: result.data.claimToken,
        })
        if (!claim) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
        await assertStreamAccessible(req, claim.responseStreamId)
        const message = contentMarkdown
          ? await eventService.createMessageInTransaction(client, {
              workspaceId: req.workspaceId!,
              streamId: claim.responseStreamId,
              authorId: bot.id,
              authorType: AuthorTypes.BOT,
              contentJson: contentJson!,
              contentMarkdown,
              attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
              clientMessageId: `bot-invocation:${claim.id}`,
              metadata: result.data.metadata,
            })
          : null
        const completed = await botRuntimeService.completeInvocationInTransaction(client, {
          workspaceId: req.workspaceId!,
          botId: req.botApiKey!.botId,
          invocationId: req.params.invocationId,
          instanceId: result.data.instanceId,
          claimToken: result.data.claimToken,
        })
        if (!completed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
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
        const session = await AgentSessionRepository.findById(client, completed.id)
        if (session?.status === AgentSessionStatuses.RUNNING) {
          const latestSequence = await eventService.getLatestSequence(completed.responseStreamId)
          const finalizedSession = await AgentSessionRepository.completeSession(client, completed.id, {
            lastSeenSequence: latestSequence ?? 0n,
            responseMessageId: message?.id ?? null,
            sentMessageIds: message ? [message.id] : [],
          })
          if (finalizedSession) {
            const steps = await AgentSessionRepository.findStepsBySession(client, completed.id)
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
              event: streamEvent,
            })
            io?.to(`ws:${req.workspaceId!}:agent_session:${completed.id}`).emit("agent_session:completed", {
              sessionId: completed.id,
            })
          }
        }
        return { completed, message }
      })
      res.json({
        data: {
          invocationId: completed.id,
          message: message ? serializeMessage(message, { authorDisplayName: bot.name }) : null,
        },
      })
    },

    async failBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = failInvocationSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const failed = await withTransaction(pool, async (client) => {
        const failed = await botRuntimeService.failInvocationInTransaction(client, {
          workspaceId: req.workspaceId!,
          botId: req.botApiKey!.botId,
          invocationId: req.params.invocationId,
          instanceId: result.data.instanceId,
          claimToken: result.data.claimToken,
          errorMessage: result.data.errorMessage,
        })
        if (!failed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })

        const runtimeCommand = parseRuntimeCommandInvocationMetadata(failed.metadata)
        if (runtimeCommand) {
          await insertCommandFailedEvent(client, {
            workspaceId: req.workspaceId!,
            streamId: failed.responseStreamId,
            userId: failed.authorUserId,
            commandId: runtimeCommand.id,
            error: result.data.errorMessage,
          })
        }

        return failed
      })
      res.json({ data: { invocationId: failed.id, status: failed.status } })
    },

    /**
     * Search messages via public API.
     *
     * POST /api/v1/workspaces/:workspaceId/messages/search
     */
    async searchMessages(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = publicSearchSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { query, semantic, exact, streams, from, type, before, after, limit } = result.data

      const accessibleStreamIds = await getAccessibleStreamIds(req)

      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      const { results } = await searchService.search({
        workspaceId,
        permissions: { accessibleStreamIds },
        query,
        filters: {
          streamIds: streams,
          authorId: from,
          streamTypes: type,
          before: before ? new Date(before) : undefined,
          after: after ? new Date(after) : undefined,
        },
        limit,
        exact,
        skipEmbedding: !semantic,
      })

      // Resolve author display names for search results
      const authorNames = await resolveAuthorDisplayNames(pool, workspaceId, results)
      const serialized: WireSearchResult[] = results.map((r) => {
        const name = authorNames.get(r.authorId)
        return {
          ...serializeSearchResult(r),
          ...(name != null && { authorDisplayName: name }),
        }
      })

      res.json({ data: serialized })
    },

    /**
     * Search memos via public API.
     *
     * POST /api/v1/workspaces/:workspaceId/memos/search
     */
    async searchMemos(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = searchMemosSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { query, exact, streams, memoType, knowledgeType, tags, before, after, limit } = result.data
      const normalized = normalizeMemoSearchMode(query, exact)
      const accessibleStreamIds = await getAccessibleStreamIds(req, {
        archiveStatus: ["active", "archived"],
      })

      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      const results = await memoExplorerService.search({
        workspaceId,
        permissions: { accessibleStreamIds },
        query: normalized.query,
        exact: normalized.exact,
        filters: {
          streamIds: streams,
          memoTypes: memoType,
          knowledgeTypes: knowledgeType,
          tags,
          before: before ? new Date(before) : undefined,
          after: after ? new Date(after) : undefined,
        },
        limit,
      })

      res.json({ data: results.map(serializeMemoSearchResult) })
    },

    /**
     * Get a memo via public API.
     *
     * GET /api/v1/workspaces/:workspaceId/memos/:memoId
     */
    async getMemo(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const memoId = req.params.memoId
      const accessibleStreamIds = await getAccessibleStreamIds(req, {
        archiveStatus: ["active", "archived"],
      })

      const memo = await memoExplorerService.getById(workspaceId, memoId, { accessibleStreamIds })
      if (!memo) {
        throw new HttpError("Memo not found", { status: 404, code: "NOT_FOUND" })
      }

      res.json({ data: serializeMemoDetail(memo) })
    },

    /**
     * Search attachments via public API.
     *
     * POST /api/v1/workspaces/:workspaceId/attachments/search
     */
    async searchAttachments(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = searchAttachmentsSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { query, streams, contentTypes, limit } = result.data
      const accessibleStreamIds = await getAccessibleStreamIds(req)
      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      const filterStreamIds = streams?.length
        ? streams.filter((streamId) => accessibleStreamIds.includes(streamId))
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

      res.json({ data: attachments.map(serializeAttachmentSearchResult) })
    },

    /**
     * Get an attachment via public API.
     *
     * GET /api/v1/workspaces/:workspaceId/attachments/:attachmentId
     */
    async getAttachment(req: Request, res: Response) {
      const attachment = await resolveAccessibleAttachment(req, req.params.attachmentId)
      const extraction = await AttachmentExtractionRepository.findByAttachmentId(pool, attachment.id)

      res.json({ data: serializeAttachmentDetail(attachment, extraction) })
    },

    /**
     * Get a signed attachment download URL via public API.
     *
     * GET /api/v1/workspaces/:workspaceId/attachments/:attachmentId/url
     */
    async getAttachmentDownloadUrl(req: Request, res: Response) {
      const attachment = await resolveAccessibleAttachment(req, req.params.attachmentId)
      const data: WireAttachmentUrl = {
        url: await attachmentService.getDownloadUrl(attachment),
        expiresIn: 900,
      }

      res.json({ data })
    },

    /**
     * List accessible streams.
     *
     * GET /api/v1/workspaces/:workspaceId/streams
     */
    async listStreams(req: Request, res: Response) {
      const result = listStreamsSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { type, query, after: afterCursor, limit } = result.data
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
      })

      const hasMore = streams.length > limit
      const page = hasMore ? streams.slice(0, limit) : streams

      // Batch-fetch parent streams for unnamed threads to compute display names
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

    /**
     * Get a single stream by ID.
     *
     * GET /api/v1/workspaces/:workspaceId/streams/:streamId
     */
    async getStream(req: Request, res: Response) {
      const streamId = req.params.streamId

      await assertStreamAccessible(req, streamId)

      const stream = await StreamRepository.findById(pool, streamId)
      if (!stream || stream.archivedAt) {
        throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
      }

      // Resolve parent stream for unnamed thread display names
      let context: DisplayNameContext | undefined
      if (stream.type === "thread" && stream.displayName === null && stream.parentStreamId) {
        const parent = await StreamRepository.findById(pool, stream.parentStreamId)
        if (parent) context = { parentStream: parent }
      }

      res.json({ data: serializeStream(stream, context) })
    },

    /**
     * List members of a stream.
     *
     * GET /api/v1/workspaces/:workspaceId/streams/:streamId/members
     */
    async listMembers(req: Request, res: Response) {
      const streamId = req.params.streamId
      const workspaceId = req.workspaceId!

      const result = listMembersSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { after: afterCursor, limit } = result.data

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

    /**
     * List messages in a stream.
     *
     * GET /api/v1/workspaces/:workspaceId/streams/:streamId/messages
     */
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

      // Verify stream access
      await assertStreamAccessible(req, streamId)

      const messages = await eventService.getMessages(streamId, {
        limit: limit + 1, // Fetch one extra to determine hasMore
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

      // Resolve author display names and thread stream IDs
      const pageMessageIds = page.map((m) => m.id)
      const [authorNames, threadMap, attachmentsByMessage] = await Promise.all([
        resolveAuthorDisplayNames(pool, req.workspaceId!, page),
        StreamRepository.findThreadsForMessageIds(pool, streamId, pageMessageIds),
        AttachmentRepository.findByMessageIds(pool, pageMessageIds),
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
      })
    },

    /**
     * Find messages by metadata (AND-containment).
     *
     * Scoped to streams accessible to this API key. Intended for dedup flows —
     * e.g. "has a message already been posted for this GitHub PR event?".
     *
     * POST /api/v1/workspaces/:workspaceId/messages/find-by-metadata
     */
    async findMessagesByMetadata(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = findMessagesByMetadataSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { metadata, streamId, limit } = result.data

      const accessibleStreamIds = await getAccessibleStreamIds(req)
      if (accessibleStreamIds.length === 0) {
        return res.json({ data: [] })
      }

      const messages = await eventService.findByMetadata({
        streamIds: accessibleStreamIds,
        filter: metadata,
        streamId,
        limit,
      })

      if (messages.length === 0) {
        return res.json({ data: [] })
      }

      const authorNames = await resolveAuthorDisplayNames(pool, workspaceId, messages)

      res.json({
        data: messages.map((m) => serializeMessage(m, { authorDisplayName: authorNames.get(m.authorId) ?? null })),
      })
    },

    /**
     * Send a message. User-scoped keys send as the user (with sentVia indicator);
     * workspace-scoped keys send as a bot entity.
     *
     * POST /api/v1/workspaces/:workspaceId/streams/:streamId/messages
     */
    async sendMessage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const streamId = req.params.streamId

      const result = sendMessageSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { content, clientMessageId, metadata } = result.data

      // Verify stream access
      await assertStreamAccessible(req, streamId)

      // Normalize and parse content
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

      // User-scoped key: send as the user with "api" indicator
      if (req.userApiKey) {
        const user = req.user!

        const message = await eventService.createMessage({
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
        })

        res.status(201).json({ data: serializeMessage(message, { authorDisplayName: user.name }) })
        return
      }

      // Bot-scoped key: send as the bot directly (no upsert needed)
      if (req.botApiKey) {
        const bot = await BotRepository.findById(pool, workspaceId, req.botApiKey.botId)
        if (!bot || bot.archivedAt) {
          throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
        }

        const message = await eventService.createMessage({
          workspaceId,
          streamId,
          authorId: bot.id,
          authorType: AuthorTypes.BOT,
          contentJson,
          contentMarkdown,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          clientMessageId,
          metadata,
        })

        res.status(201).json({ data: serializeMessage(message, { authorDisplayName: bot.name }) })
        return
      }

      throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
    },

    /**
     * Update an API-created message.
     *
     * PATCH /api/v1/workspaces/:workspaceId/messages/:messageId
     */
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
      const { message: existing, actorId, actorType, displayName } = await resolveOwnedMessage(messageId, req)

      // Normalize and parse content
      const contentMarkdown = normalizeMessage(content)
      const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)
      // Refresh attachment_references projection to match the new contentJson
      // (INV-7) — same derivation as the user UI handler and the agent adapter.
      const attachmentIds = collectAttachmentReferenceIds(contentJson)

      const updated = await eventService.editMessage({
        workspaceId,
        messageId,
        streamId: existing.streamId,
        contentJson,
        contentMarkdown,
        actorId,
        actorType,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      })

      if (!updated) {
        throw new HttpError("Message not found or was deleted", { status: 404, code: "NOT_FOUND" })
      }

      // Look up thread for this message
      const thread = await StreamRepository.findByParentMessage(pool, existing.streamId, messageId)
      res.json({
        data: serializeMessage(updated, {
          authorDisplayName: displayName,
          threadStreamId: thread?.id ?? null,
        }),
      })
    },

    /**
     * Delete an API-created message.
     *
     * DELETE /api/v1/workspaces/:workspaceId/messages/:messageId
     */
    async deleteMessage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const messageId = req.params.messageId

      const { message: existing, actorId, actorType } = await resolveOwnedMessage(messageId, req)

      const deleted = await eventService.deleteMessage({
        workspaceId,
        messageId,
        streamId: existing.streamId,
        actorId,
        actorType,
      })

      if (!deleted) {
        throw new HttpError("Message not found or was deleted", { status: 404, code: "NOT_FOUND" })
      }

      res.status(204).send()
    },

    /**
     * List workspace users.
     *
     * GET /api/v1/workspaces/:workspaceId/users
     */
    async listUsers(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const result = listUsersSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { query, after: afterCursor, limit } = result.data

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
     * GET /api/v1/workspaces/:workspaceId/me
     *
     * Returns the authenticated principal. Used by clients (e.g. the OpenClaw
     * channel plugin) to verify their key and discover their identity after
     * pairing. No scope required — being authenticated is sufficient.
     */
    async getMe(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      if (req.userApiKey) {
        const user = req.user!
        res.json({
          data: {
            kind: "user",
            workspaceId,
            userId: user.id,
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
          },
        })
        return
      }

      throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
    },

    /**
     * GET /api/v1/workspaces/:workspaceId/me/bots
     *
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

      const result = listMyBotsSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }
      const traits = result.data.traits ? [result.data.traits] : []

      const bots = await BotRepository.listByOwner(pool, workspaceId, userId, { traits })
      res.json({ data: bots.map(serializeBot) })
    },
  }
}
