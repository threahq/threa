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
})

const extractionResultSchema = z.object({
  /**
   * Assignments for the new message. Always at least one entry, exactly one
   * with `isPrimary: true`.
   */
  assignments: z.array(messageAssignmentSchema),
  /** Topic summary; required when any assignment has `conversationId: null`. */
  newConversationTopic: z.string().optional(),
  /** Optional reassignments of prior messages. Empty/undefined if none. */
  reassignments: z.array(reassignmentSchema).optional(),
  /** Updates to completeness scores for affected conversations. */
  completenessUpdates: z.array(completenessUpdateSchema).optional(),
  /** Overall confidence in the classification. */
  confidence: z.number(),
})

export type MessageAssignment = z.infer<typeof messageAssignmentSchema>
export type Reassignment = z.infer<typeof reassignmentSchema>
export type CompletenessUpdate = z.infer<typeof completenessUpdateSchema>
export type ExtractionResult = z.infer<typeof extractionResultSchema>

export interface ConversationSummary {
  id: string
  topicSummary: string | null
  messageCount: number
  lastMessagePreview: string
  participantIds: string[]
  completenessScore: number
  /**
   * Message IDs from this conversation that appear in the current extraction
   * context. The LLM may reassign these to a different conversation.
   */
  contextMessageIds: string[]
}

export interface ExtractionContext {
  newMessage: Message
  recentMessages: Message[]
  activeConversations: ConversationSummary[]
  streamType: string
  /** For threads: conversations containing the parent message (in the parent channel) */
  parentMessageConversations?: ConversationSummary[]
  /** Workspace ID for cost tracking - required for cost attribution */
  workspaceId: string
}

export interface BoundaryExtractor {
  extract(context: ExtractionContext): Promise<ExtractionResult>
}
