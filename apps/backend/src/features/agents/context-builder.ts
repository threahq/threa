import type { Querier } from "../../db"
import type {
  AuthorType,
  StreamType,
  UserPreferences,
  ExtractionContentType,
  ExtractionSourceType,
  PdfSizeTier,
  ChartData,
  TableData,
  DiagramData,
} from "@threa/types"
import {
  StreamTypes,
  AuthorTypes,
  ExtractionSourceTypes,
  PdfSizeTiers,
  InjectionStrategies,
  DEFAULT_USER_PREFERENCES,
} from "@threa/types"
import { StreamRepository, StreamMemberRepository, type Stream } from "../streams"
import { MessageRepository, type Message } from "../messaging"
import { UserRepository } from "../workspaces"
import { AttachmentRepository } from "../attachments"
import { AttachmentExtractionRepository, type PdfMetadata, type PdfSection } from "../attachments"
import { getUtcOffset, type TemporalContext, type ParticipantTemporal } from "../../lib/temporal"

/**
 * A participant in a stream (user or persona).
 */
export interface Participant {
  id: string
  name: string
  role?: string
}

/**
 * Info about a message in the thread hierarchy.
 */
export interface AnchorMessage {
  id: string
  content: string
  authorName: string
}

/**
 * Position in thread hierarchy for nested threads.
 */
export interface ThreadPathEntry {
  streamId: string
  displayName: string | null
  anchorMessage: AnchorMessage | null
}

/**
 * Attachment context for a message.
 * Detail level varies based on message recency.
 */
export interface AttachmentContext {
  id: string
  filename: string
  mimeType: string
  extraction: {
    contentType: ExtractionContentType
    summary: string
    /** Full text is included for recent messages (invoking + last 3 user messages) */
    fullText: string | null
    /** Structured data for charts, tables, diagrams (included for recent messages) */
    structuredData: ChartData | TableData | DiagramData | null
    /** Source type: 'image' or 'pdf' */
    sourceType: ExtractionSourceType
    /** PDF-specific metadata (only for PDFs) */
    pdfMetadata?: {
      totalPages: number
      sizeTier: PdfSizeTier
      sections?: PdfSection[]
    }
    /** Excel-specific metadata (only for Excel workbooks) */
    excelMetadata?: {
      totalSheets: number
      totalRows: number
      totalCells: number
      sheets: Array<{
        name: string
        rows: number
        columns: number
        headers: string[]
        columnTypes: string[]
        sampleRows: string[][]
      }>
    }
  } | null
  /**
   * Base64 data URL for image attachments.
   * Only populated for recent messages when the model supports vision.
   * Format: "data:image/png;base64,..."
   */
  dataUrl?: string
}

/**
 * Message with attachment context.
 */
export interface MessageWithAttachments extends Message {
  attachments?: AttachmentContext[]
}

/**
 * Context about the stream for the companion agent.
 * Different stream types populate different fields.
 */
export interface StreamContext {
  streamType: StreamType
  streamInfo: {
    id: string
    name: string | null
    description: string | null
    slug: string | null
  }
  /** Participants in the stream (for channels, DMs). Scratchpads don't need this. */
  participants?: Participant[]
  /** Conversation history - messages in chronological order, may include attachment context */
  conversationHistory: MessageWithAttachments[]
  /** For threads: path from current thread up to root channel */
  threadContext?: {
    depth: number
    path: ThreadPathEntry[]
  }
  /** Temporal context for the invoking user */
  temporal?: TemporalContext
  /** Participant timezone info (for multi-timezone awareness) */
  participantTimezones?: ParticipantTemporal[]
}

const MAX_CONTEXT_MESSAGES = 20

/**
 * Options for building stream context with temporal information.
 */
export interface BuildStreamContextOptions {
  /** User preferences (used for temporal context) */
  preferences?: UserPreferences
  /** Current time at invocation (for deterministic testing) */
  currentTime?: Date
  /** Trigger message ID (for determining attachment detail levels) */
  triggerMessageId?: string
  /** Whether to include attachment context */
  includeAttachments?: boolean
  /**
   * Storage provider for loading image data.
   * Required when loadImages is true.
   */
  storage?: {
    getObject(key: string): Promise<Buffer>
  }
  /**
   * Whether to load actual image data for vision models.
   * When true, images in recent messages will be loaded from storage
   * and included as base64 data URLs so the model can see them.
   */
  loadImages?: boolean
}

/**
 * Build stream context for the companion agent.
 * Returns stream-type-specific context for enriching the system prompt.
 *
 * When preferences are provided, includes temporal context with the invoking user's
 * timezone and time preferences. When only `currentTime` is provided (e.g. deterministic
 * evals without a user prefs row), temporal context uses UTC and default date/time formats.
 *
 * When includeAttachments is true, messages are enriched with attachment context.
 * Detail level varies based on message recency relative to triggerMessageId.
 */
export async function buildStreamContext(
  db: Querier,
  stream: Stream,
  options?: BuildStreamContextOptions
): Promise<StreamContext> {
  let temporal: TemporalContext | undefined
  if (options?.preferences) {
    temporal = buildTemporalContext(options.preferences, options.currentTime)
  } else if (options?.currentTime) {
    temporal = buildTemporalContext(
      {
        timezone: DEFAULT_USER_PREFERENCES.timezone,
        dateFormat: DEFAULT_USER_PREFERENCES.dateFormat,
        timeFormat: DEFAULT_USER_PREFERENCES.timeFormat,
      },
      options.currentTime
    )
  }

  let context: StreamContext
  switch (stream.type) {
    case StreamTypes.SCRATCHPAD:
      context = await buildScratchpadContext(db, stream, temporal)
      break

    case StreamTypes.CHANNEL:
      context = await buildChannelContext(db, stream, temporal, options?.currentTime)
      break

    case StreamTypes.THREAD:
      context = await buildThreadContext(db, stream, temporal)
      break

    case StreamTypes.DM:
      context = await buildDmContext(db, stream, temporal, options?.currentTime)
      break

    default:
      context = await buildScratchpadContext(db, stream, temporal)
  }

  // Enrich with attachment context if requested
  if (options?.includeAttachments) {
    context.conversationHistory = await enrichMessagesWithAttachments(
      db,
      stream.workspaceId,
      context.conversationHistory,
      {
        triggerMessageId: options.triggerMessageId,
        storage: options.storage,
        loadImages: options.loadImages,
      }
    )
  }

  return context
}

type TemporalPreferenceFields = Pick<UserPreferences, "timezone" | "dateFormat" | "timeFormat">

/**
 * Build temporal context from timezone and display preferences.
 */
function buildTemporalContext(preferences: TemporalPreferenceFields, currentTime?: Date): TemporalContext {
  const now = currentTime ?? new Date()

  return {
    currentTime: now.toISOString(),
    timezone: preferences.timezone,
    utcOffset: getUtcOffset(preferences.timezone, now),
    dateFormat: preferences.dateFormat,
    timeFormat: preferences.timeFormat,
  }
}

/**
 * Scratchpad context: personal, solo-first. Conversation history is primary context.
 */
async function buildScratchpadContext(db: Querier, stream: Stream, temporal?: TemporalContext): Promise<StreamContext> {
  const messages = await MessageRepository.list(db, stream.id, { limit: MAX_CONTEXT_MESSAGES })

  return {
    streamType: stream.type,
    streamInfo: {
      id: stream.id,
      name: stream.displayName,
      description: stream.description,
      slug: stream.slug,
    },
    conversationHistory: messages,
    temporal,
  }
}

/**
 * Channel context: collaborative. Includes members, slug, and conversation.
 */
async function buildChannelContext(
  db: Querier,
  stream: Stream,
  temporal?: TemporalContext,
  currentTime?: Date
): Promise<StreamContext> {
  const [messages, members] = await Promise.all([
    MessageRepository.list(db, stream.id, { limit: MAX_CONTEXT_MESSAGES }),
    StreamMemberRepository.list(db, { streamId: stream.id }),
  ])

  const userIds = members.map((m) => m.memberId)
  const { participants, participantTimezones } = await resolveParticipantsWithTimezones(
    db,
    stream.workspaceId,
    userIds,
    temporal !== undefined,
    currentTime
  )

  return {
    streamType: stream.type,
    streamInfo: {
      id: stream.id,
      name: stream.displayName,
      description: stream.description,
      slug: stream.slug,
    },
    participants,
    conversationHistory: messages,
    temporal,
    participantTimezones,
  }
}

/**
 * DM context: two-party. Like channels but focused.
 */
async function buildDmContext(
  db: Querier,
  stream: Stream,
  temporal?: TemporalContext,
  currentTime?: Date
): Promise<StreamContext> {
  const [messages, members] = await Promise.all([
    MessageRepository.list(db, stream.id, { limit: MAX_CONTEXT_MESSAGES }),
    StreamMemberRepository.list(db, { streamId: stream.id }),
  ])

  const userIds = members.map((m) => m.memberId)
  const { participants, participantTimezones } = await resolveParticipantsWithTimezones(
    db,
    stream.workspaceId,
    userIds,
    temporal !== undefined,
    currentTime
  )

  return {
    streamType: stream.type,
    streamInfo: {
      id: stream.id,
      name: stream.displayName,
      description: stream.description,
      slug: stream.slug,
    },
    participants,
    conversationHistory: messages,
    temporal,
    participantTimezones,
  }
}

/**
 * Thread context: nested discussions. Traverses hierarchy to root.
 *
 * Includes the parent message that spawned the thread as the first message
 * in conversation history. This ensures the agent sees the full context
 * (including attachments like images) that led to the thread being created.
 */
async function buildThreadContext(db: Querier, stream: Stream, temporal?: TemporalContext): Promise<StreamContext> {
  const messages = await MessageRepository.list(db, stream.id, { limit: MAX_CONTEXT_MESSAGES })

  // Build thread path from current thread up to root
  const threadPath = await buildThreadPath(db, stream)

  // Include the parent (root) message that spawned this thread — the reply
  // chain is unintelligible without it, and the parent often carries
  // attachments / context the thread is about. `findThreadRoot` is the
  // canonical helper: filters soft-deleted roots + returns null for
  // non-threads. Every new thread-context code path MUST use this helper
  // rather than hand-rolling a `findById` + prepend (recurring bug class).
  const parentMessage = await MessageRepository.findThreadRoot(db, stream)
  const conversationHistory = parentMessage ? [parentMessage, ...messages] : messages

  return {
    streamType: stream.type,
    streamInfo: {
      id: stream.id,
      name: stream.displayName,
      description: stream.description,
      slug: stream.slug,
    },
    conversationHistory,
    threadContext: {
      depth: threadPath.length,
      path: threadPath,
    },
    temporal,
  }
}

/**
 * Build the path from a thread up to its root (channel/scratchpad).
 * Returns entries in order from root to current thread.
 */
async function buildThreadPath(db: Querier, stream: Stream): Promise<ThreadPathEntry[]> {
  const path: ThreadPathEntry[] = []
  let current: Stream | null = stream

  while (current) {
    let anchorMessage: AnchorMessage | null = null

    // If this is a thread spawned from a message, get that message. Use the
    // canonical `findThreadRoot` helper so the same soft-delete filter that
    // protects `conversationHistory` also scrubs `threadPath[*].anchorMessage`
    // — otherwise a user-deleted root would be absent from the AI's
    // conversation but still reach the prompt via the breadcrumb path.
    const message = await MessageRepository.findThreadRoot(db, current)
    if (message) {
      const authorName = await resolveAuthorName(db, current.workspaceId, message.authorId, message.authorType)
      anchorMessage = {
        id: message.id,
        content: message.contentMarkdown.slice(0, 200), // Truncate for context
        authorName,
      }
    }

    path.unshift({
      streamId: current.id,
      displayName: current.displayName,
      anchorMessage,
    })

    // Traverse up
    if (current.parentStreamId) {
      current = await StreamRepository.findById(db, current.parentStreamId)
    } else {
      current = null
    }
  }

  return path
}

/**
 * Resolve participants and their timezone info in a single batch query.
 * Avoids N+1 queries by fetching all members at once.
 */
async function resolveParticipantsWithTimezones(
  db: Querier,
  workspaceId: string,
  userIds: string[],
  includeTimezones: boolean,
  currentTime?: Date
): Promise<{ participants: Participant[]; participantTimezones?: ParticipantTemporal[] }> {
  if (userIds.length === 0) {
    return { participants: [], participantTimezones: includeTimezones ? [] : undefined }
  }

  // Batch fetch all users in one query
  const members = await UserRepository.findByIds(db, workspaceId, userIds)

  const participants: Participant[] = members.map((member) => ({
    id: member.id,
    name: member.name,
  }))

  // Build timezone info from the same member data if needed
  let participantTimezones: ParticipantTemporal[] | undefined
  if (includeTimezones) {
    const now = currentTime ?? new Date()
    participantTimezones = members.map((member) => {
      const timezone = member.timezone ?? "UTC"
      return {
        id: member.id,
        name: member.name,
        timezone,
        utcOffset: getUtcOffset(timezone, now),
      }
    })
  }

  return { participants, participantTimezones }
}

/**
 * Resolve author name for a message.
 */
async function resolveAuthorName(
  db: Querier,
  workspaceId: string,
  authorId: string,
  authorType: AuthorType
): Promise<string> {
  if (authorType === "system") {
    return "Threa"
  }

  if (authorType === "user") {
    const member = await UserRepository.findById(db, workspaceId, authorId)
    return member?.name ?? "Unknown"
  }

  // For personas, we'd need to look up the persona
  // For now, return a placeholder
  return "Assistant"
}

/**
 * Number of recent user messages to include full extraction details for.
 */
const FULL_EXTRACTION_USER_MESSAGES = 3

/**
 * Options for enriching messages with attachment context.
 */
export interface EnrichAttachmentsOptions {
  /** The trigger message ID (for determining detail levels) */
  triggerMessageId?: string
  /**
   * Storage provider for loading image data.
   * If provided along with loadImages=true, actual image data will be loaded
   * for recent messages so vision models can see the images.
   */
  storage?: {
    getObject(key: string): Promise<Buffer>
  }
  /**
   * Whether to load actual image data for vision models.
   * Requires storage to be provided.
   */
  loadImages?: boolean
}

/**
 * Enrich messages with attachment context.
 *
 * Detail levels based on message position:
 * - Trigger message + messages after it: Full extraction (summary + fullText) + image data
 * - Last N user messages before trigger: Full extraction + image data
 * - Older messages: Summary only (no image data)
 *
 * When loadImages is true and storage is provided, actual image data (as base64 data URLs)
 * will be included for recent messages with image attachments. This allows vision models
 * to see the images directly in the conversation.
 */
export async function enrichMessagesWithAttachments(
  db: Querier,
  workspaceId: string,
  messages: Message[],
  options?: EnrichAttachmentsOptions
): Promise<MessageWithAttachments[]> {
  const { triggerMessageId, storage, loadImages } = options ?? {}
  if (messages.length === 0) return []

  // Get all message IDs
  const messageIds = messages.map((m) => m.id)

  // Batch fetch attachments for all messages
  const attachmentsByMessage = await AttachmentRepository.findByMessageIds(db, workspaceId, messageIds)

  // If no attachments, return messages as-is
  if (attachmentsByMessage.size === 0) {
    return messages
  }

  // Collect all attachment IDs for extraction lookup
  const allAttachmentIds: string[] = []
  for (const attachments of attachmentsByMessage.values()) {
    for (const a of attachments) {
      allAttachmentIds.push(a.id)
    }
  }

  // Batch fetch extractions
  const extractionsByAttachment = await AttachmentExtractionRepository.findByAttachmentIds(db, allAttachmentIds)

  // Determine which messages get full extraction details
  const triggerIdx = triggerMessageId ? messages.findIndex((m) => m.id === triggerMessageId) : -1

  // Find indices of last N user messages before trigger
  const userMessageIndicesBeforeTrigger: number[] = []
  for (let i = triggerIdx - 1; i >= 0 && userMessageIndicesBeforeTrigger.length < FULL_EXTRACTION_USER_MESSAGES; i--) {
    if (messages[i].authorType === AuthorTypes.USER) {
      userMessageIndicesBeforeTrigger.push(i)
    }
  }

  // Build set of message indices that get full extraction
  const fullExtractionIndices = new Set<number>()
  if (triggerIdx >= 0) {
    // Trigger message and all messages after it
    for (let i = triggerIdx; i < messages.length; i++) {
      fullExtractionIndices.add(i)
    }
  }
  // Last N user messages before trigger
  for (const idx of userMessageIndicesBeforeTrigger) {
    fullExtractionIndices.add(idx)
  }

  // Determine if we should load images
  const shouldLoadImages = loadImages && storage

  // Collect image attachments that need loading (for recent messages only)
  const imageAttachmentsToLoad: Array<{ attachmentId: string; storagePath: string; mimeType: string }> = []
  if (shouldLoadImages) {
    for (let idx = 0; idx < messages.length; idx++) {
      if (!fullExtractionIndices.has(idx)) continue
      const attachments = attachmentsByMessage.get(messages[idx].id)
      if (!attachments) continue
      for (const att of attachments) {
        if (att.mimeType.startsWith("image/")) {
          imageAttachmentsToLoad.push({
            attachmentId: att.id,
            storagePath: att.storagePath,
            mimeType: att.mimeType,
          })
        }
      }
    }
  }

  // Load image data in parallel
  const imageDataByAttachment = new Map<string, string>()
  if (imageAttachmentsToLoad.length > 0 && storage) {
    const results = await Promise.allSettled(
      imageAttachmentsToLoad.map(async ({ attachmentId, storagePath, mimeType }) => {
        const buffer = await storage.getObject(storagePath)
        const base64 = buffer.toString("base64")
        return { attachmentId, dataUrl: `data:${mimeType};base64,${base64}` }
      })
    )
    for (const result of results) {
      if (result.status === "fulfilled") {
        imageDataByAttachment.set(result.value.attachmentId, result.value.dataUrl)
      }
      // Silently skip failed image loads - the caption will still be available
    }
  }

  // Enrich each message with attachment context
  return messages.map((message, idx): MessageWithAttachments => {
    const attachments = attachmentsByMessage.get(message.id)
    if (!attachments || attachments.length === 0) {
      return message
    }

    const includeFullText = fullExtractionIndices.has(idx)
    const includeImageData = shouldLoadImages && fullExtractionIndices.has(idx)

    const attachmentContexts: AttachmentContext[] = attachments.map((attachment) => {
      const extraction = extractionsByAttachment.get(attachment.id)
      const dataUrl = includeImageData ? imageDataByAttachment.get(attachment.id) : undefined

      // For large PDFs, don't include full text (use load_pdf_section tool instead)
      const isLargePdf =
        extraction?.sourceType === ExtractionSourceTypes.PDF && extraction?.pdfMetadata?.sizeTier === PdfSizeTiers.LARGE

      // For large Excel workbooks, don't include full text (use load_excel_section tool instead)
      const isLargeExcel =
        extraction?.sourceType === ExtractionSourceTypes.EXCEL &&
        extraction?.excelMetadata?.injectionStrategy === InjectionStrategies.SUMMARY

      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        extraction: extraction
          ? {
              contentType: extraction.contentType,
              summary: extraction.summary,
              fullText: includeFullText && !isLargePdf && !isLargeExcel ? extraction.fullText : null,
              structuredData: includeFullText ? extraction.structuredData : null,
              sourceType: extraction.sourceType,
              pdfMetadata: extraction.pdfMetadata
                ? {
                    totalPages: extraction.pdfMetadata.totalPages,
                    sizeTier: extraction.pdfMetadata.sizeTier,
                    sections: extraction.pdfMetadata.sections,
                  }
                : undefined,
              excelMetadata: extraction.excelMetadata
                ? {
                    totalSheets: extraction.excelMetadata.totalSheets,
                    totalRows: extraction.excelMetadata.totalRows,
                    totalCells: extraction.excelMetadata.totalCells,
                    sheets: extraction.excelMetadata.sheets,
                  }
                : undefined,
            }
          : null,
        dataUrl,
      }
    })

    return {
      ...message,
      attachments: attachmentContexts,
    }
  })
}
