import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { SearchFilters, SearchService } from "../search"
import { serializeSearchResult, resolveUserAccessibleStreamIds } from "../search"
import type { BotChannelService } from "../api-keys"
import type { EventService } from "../messaging"
import {
  StreamRepository,
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
} from "../attachments"
import { BotRepository, type Bot } from "./bot-repository"
import { AttachmentSafetyStatuses, AuthorTypes, sentViaApiKey, type AuthorType } from "@threa/types"
import { BotRuntimeService } from "../bot-runtimes"
import { HttpError } from "@threa/backend-common"
import { normalizeMessage, toEmoji } from "../emoji"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threa/prosemirror"
import { randomUUID } from "crypto"
import { botId } from "../../lib/id"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
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
  claimInvocationSchema,
  completeInvocationSchema,
  failInvocationSchema,
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
  opts?: { authorDisplayName?: string | null; threadStreamId?: string | null }
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

  return {
    async upsertBotRuntimePresence(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = upsertPresenceSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const presence = await botRuntimeService.upsertPresenceFromBotKey({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        ...result.data,
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

    async claimBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = claimInvocationSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const invocation = await botRuntimeService.claimNextInvocation({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        runtimeKind: result.data.runtimeKind,
        instanceId: result.data.instanceId,
        supportedCapabilities: result.data.supportedCapabilities,
        claimTtlSeconds: result.data.claimTtlSeconds,
        claimToken: randomUUID(),
      })
      if (!invocation) return res.json({ data: null })
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
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
          claimToken: invocation.claimToken,
          claimExpiresAt: invocation.claimExpiresAt?.toISOString() ?? null,
          runtimeSessionId: invocation.targetRuntimeSessionId,
        },
      })
    },

    async completeBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = completeInvocationSchema.safeParse(req.body)
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
      const bot = await BotRepository.findById(pool, req.workspaceId!, req.botApiKey.botId)
      if (!bot || bot.archivedAt) throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      const contentMarkdown = normalizeMessage(result.data.finalMessageMarkdown)
      const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)
      const attachmentIds = collectAttachmentReferenceIds(contentJson)
      const message = await eventService.createMessage({
        workspaceId: req.workspaceId!,
        streamId: claim.responseStreamId,
        authorId: bot.id,
        authorType: AuthorTypes.BOT,
        contentJson,
        contentMarkdown,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        metadata: result.data.metadata,
      })
      const completed = await botRuntimeService.completeInvocation({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        instanceId: result.data.instanceId,
        claimToken: result.data.claimToken,
      })
      if (!completed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
      res.json({
        data: { invocationId: completed.id, message: serializeMessage(message, { authorDisplayName: bot.name }) },
      })
    },

    async failBotInvocation(req: Request, res: Response) {
      if (!req.botApiKey) throw new HttpError("Bot API key required", { status: 403, code: "FORBIDDEN" })
      const result = failInvocationSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", details: z.flattenError(result.error).fieldErrors })
      }
      const failed = await botRuntimeService.failInvocation({
        workspaceId: req.workspaceId!,
        botId: req.botApiKey.botId,
        invocationId: req.params.invocationId,
        instanceId: result.data.instanceId,
        claimToken: result.data.claimToken,
        errorMessage: result.data.errorMessage,
      })
      if (!failed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
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

      const results = await searchService.search({
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
      const [authorNames, threadMap] = await Promise.all([
        resolveAuthorDisplayNames(pool, req.workspaceId!, page),
        StreamRepository.findThreadsForMessageIds(pool, streamId, pageMessageIds),
      ])

      res.json({
        data: page.map((m) =>
          serializeMessage(m, {
            authorDisplayName: authorNames.get(m.authorId) ?? null,
            threadStreamId: threadMap.get(m.id) ?? null,
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
