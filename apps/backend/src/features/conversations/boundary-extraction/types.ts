import { z } from "zod"
import { CONVERSATION_STATUSES } from "@threa/types"
import type { Message } from "../../messaging"

/**
 * Internal Zod schemas for boundary extraction output shapes.
 *
 * Per INV-31, the TypeScript types below are derived from these schemas so a
 * schema change automatically propagates to consumer types — no parallel
 * hand-typed interface to drift out of sync.
 *
 * NOTE: these are the *internal* shapes used inside the service after the LLM
 * response has been normalized. The wire-format schemas (with `.nullable()`
 * fields) live in `./config.ts` and are translated to the internal shape by
 * `LLMBoundaryExtractor.validateResult`.
 */

/**
 * One assignment for the new message being classified.
 *
 * `conversationId: null` means "start a new conversation and assign the new
 * message to it as primary"; `newConversationTopic` on the result then carries
 * the topic. Exactly one assignment must be primary; remaining assignments are
 * secondaries the message also belongs to (cross-topic references).
 */
const messageAssignmentSchema = z.object({
  conversationId: z.string().nullable(),
  isPrimary: z.boolean(),
})

/**
 * Reassignment of a prior message in the LLM's context window. The primary
 * conversation for `messageId` moves from wherever it was to `toConversationId`.
 *
 * `toConversationId: null` means "move into the new conversation this call is
 * creating" (only valid when the result also has a `conversationId: null`
 * primary assignment for the new message). `messageId` must be in the
 * reassignment candidate set (recent messages or context-window messages of
 * active conversations); anything else is rejected by the service.
 */
const reassignmentSchema = z.object({
  messageId: z.string(),
  toConversationId: z.string().nullable(),
  reason: z.string(),
  confidence: z.number().optional(),
})

const completenessUpdateSchema = z.object({
  conversationId: z.string(),
  score: z.number(),
  status: z.enum(CONVERSATION_STATUSES),
  /**
   * Refreshed rolling summary of what the conversation covers, when its
   * content moved on this pass. Undefined leaves the stored summary untouched.
   */
  summary: z.string().optional(),
})

const extractionResultSchema = z.object({
  /**
   * Assignments for the new message. Always at least one entry, exactly one
   * with `isPrimary: true`.
   */
  assignments: z.array(messageAssignmentSchema),
  /** Topic summary; required when any assignment has `conversationId: null`. */
  newConversationTopic: z.string().optional(),
  /** Rolling prose summary for the new conversation, set alongside the topic. */
  newConversationSummary: z.string().optional(),
  reassignments: z.array(reassignmentSchema).optional(),
  completenessUpdates: z.array(completenessUpdateSchema).optional(),
  confidence: z.number(),
})

export type MessageAssignment = z.infer<typeof messageAssignmentSchema>
export type Reassignment = z.infer<typeof reassignmentSchema>
export type CompletenessUpdate = z.infer<typeof completenessUpdateSchema>
export type ExtractionResult = z.infer<typeof extractionResultSchema>

export interface ConversationSummary {
  id: string
  topicSummary: string | null
  /**
   * Rolling prose summary of what the conversation covers, maintained by
   * prior extraction passes. Null for conversations the extractor has not
   * summarized yet (pre-migration rows, sync-assigned conversations).
   */
  summary: string | null
  messageCount: number
  lastMessagePreview: string
  participantIds: string[]
  completenessScore: number
  /** Lifecycle status so the model treats "resolved" conversations as closed. */
  status: (typeof CONVERSATION_STATUSES)[number]
  /**
   * When the conversation last saw activity. The prompt renders this as a
   * relative age next to the summary so the model can weigh session gaps —
   * without it a conversation idle for days is indistinguishable from a live
   * exchange.
   */
  lastActivityAt: Date
  /**
   * Message IDs from this conversation that appear in the current extraction
   * context. The LLM may reassign these to a different conversation.
   */
  contextMessageIds: string[]
}

/**
 * Compact extraction summary for one attachment, shaped for the boundary
 * extractor's prompt. `fullText` is the complete transcript / OCR / parse,
 * `summary` is the AI-generated short description that is always present.
 *
 * The service decides per-message whether to populate `fullText` (typically
 * only for the new message, where extracted content is most likely to change
 * the classification decision) or leave it null and rely on `summary`.
 */
export interface AttachmentExtractContext {
  filename: string
  mimeType: string
  /** "text" | "image" | "pdf" | "word" | "excel" | "video" | "audio" or whatever extractor recorded. */
  contentType: string | null
  summary: string | null
  fullText: string | null
}

/**
 * An explicit quote-reply the new message makes, resolved to the conversation
 * that owns the quoted message as primary. This is a deliberate user action, so
 * the prompt treats it as strong (overridable) evidence the new message
 * continues `conversationId`. Only quotes whose target has a primary
 * conversation appear here; the quoted conversation is guaranteed to be in
 * `activeConversations` so the model can actually assign to it.
 */
export interface ReplyTarget {
  quotedMessageId: string
  conversationId: string
  topicSummary: string | null
  snippet: string
}

export interface ExtractionContext {
  newMessage: Message
  recentMessages: Message[]
  activeConversations: ConversationSummary[]
  streamType: string
  /** For threads: conversations containing the parent message (in the parent channel) */
  parentMessageConversations?: ConversationSummary[]
  /** Conversations the new message explicitly quote-replies into (strong continuity signal). */
  replyTargets?: ReplyTarget[]
  /**
   * Extracted text from attachments, keyed by message id. Includes the new
   * message and any recent/context messages whose attachments produced a
   * transcript, OCR text, or other extracted content. Empty/absent when no
   * relevant attachments exist.
   */
  attachmentsByMessageId?: Map<string, AttachmentExtractContext[]>
  /** Workspace ID for cost tracking - required for cost attribution */
  workspaceId: string
}

/**
 * One proposed topic group from an on-demand conversation split. `messageIds` is
 * a subset of the source conversation's messages; across a proposal the groups
 * partition the conversation (every message in exactly one group). `title`/`summary`
 * are model-generated and shown to the user for confirmation before any write.
 */
export interface SplitGroup {
  title: string
  summary?: string
  messageIds: string[]
}

/** Input for a batch split: the full message set of one existing conversation. */
export interface SplitContext {
  conversationId: string
  topicSummary: string | null
  summary: string | null
  /** The conversation's messages, in chronological (timeline) order. */
  messages: Message[]
  streamType: string
  /** Workspace ID for cost attribution (INV-19). */
  workspaceId: string
}

/**
 * A proposed split of one conversation. `groups` is ordered most-central-topic
 * first and always partitions the input messages; a single group means the model
 * judged the conversation focused enough to leave whole (no split).
 */
export interface SplitProposal {
  groups: SplitGroup[]
  confidence: number
  reasoning: string | null
}

export interface BoundaryExtractor {
  extract(context: ExtractionContext): Promise<ExtractionResult>
  /**
   * Re-cluster an existing conversation's messages into ≥1 topic group. Read-only
   * (returns a proposal; the caller applies it after user confirmation). Reuses the
   * boundary clustering model — see {@link BoundaryExtractor.extract}.
   */
  splitConversation(context: SplitContext): Promise<SplitProposal>
}
