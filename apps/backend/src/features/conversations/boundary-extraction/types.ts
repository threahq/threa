import type { Message } from "../../messaging"
import type { ConversationStatus } from "@threa/types"

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

export interface CompletenessUpdate {
  conversationId: string
  score: number
  status: ConversationStatus
}

/**
 * One assignment for the new message being classified.
 *
 * `conversationId: null` means "start a new conversation and assign the new
 * message to it as primary"; `newConversationTopic` on the result then carries
 * the topic. Exactly one assignment must be primary; remaining assignments are
 * secondaries the message also belongs to (cross-topic references).
 */
export interface MessageAssignment {
  conversationId: string | null
  isPrimary: boolean
}

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
export interface Reassignment {
  messageId: string
  toConversationId: string | null
  reason: string
  confidence?: number
}

export interface ExtractionResult {
  /**
   * Assignments for the new message. Always at least one entry, exactly one
   * with `isPrimary: true`.
   */
  assignments: MessageAssignment[]
  /** Topic summary; required when any assignment has `conversationId: null`. */
  newConversationTopic?: string
  /** Optional reassignments of prior messages. Empty/undefined if none. */
  reassignments?: Reassignment[]
  /** Updates to completeness scores for affected conversations. */
  completenessUpdates?: CompletenessUpdate[]
  /** Overall confidence in the classification. */
  confidence: number
}

export interface BoundaryExtractor {
  extract(context: ExtractionContext): Promise<ExtractionResult>
}
