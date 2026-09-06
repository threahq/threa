/**
 * Boundary Extraction Evaluation Types
 */

import type { ConversationStatus } from "@threahq/types"

/**
 * Simplified conversation summary for eval input.
 */
export interface EvalConversationSummary {
  id: string
  topicSummary: string | null
  /** Rolling prose summary of what the conversation covers; null/omitted = not yet summarized. */
  summary?: string | null
  messageCount: number
  lastMessagePreview: string
  participantIds: string[]
  completenessScore: number
  /** Lifecycle status; defaults to "active" when omitted. */
  status?: ConversationStatus
  /**
   * How long before the new message this conversation last saw activity.
   * Defaults to 5 minutes (a live conversation) when omitted.
   */
  lastActivityMinutesAgo?: number
  /**
   * Ids of recent messages (EvalMessage.id) this conversation owns. Renders
   * as the conversation's in-context message ids, making ownership visible to
   * the model — required for reassignment (merge/split) cases.
   */
  contextMessageIds?: string[]
}

/**
 * Simplified message for eval input.
 */
export interface EvalMessage {
  /**
   * Stable id so conversations can claim the message via contextMessageIds
   * and reassignment expectations can name it. Random when omitted.
   */
  id?: string
  authorId: string
  authorType: "user" | "persona"
  contentMarkdown: string
  /**
   * How long before the new message this message was sent. Defaults to
   * 2 minutes (part of a live exchange) when omitted.
   */
  minutesAgo?: number
}

/**
 * One explicit quote-reply the new message makes, already resolved to the
 * conversation that owns the quoted message (the production service does this
 * resolution from `content_json`; evals provide it directly).
 */
export interface EvalReplyTarget {
  quotedMessageId: string
  conversationId: string
  topicSummary: string | null
  snippet: string
}

/**
 * Input for boundary extraction evaluation.
 */
export interface BoundaryExtractionInput {
  /** The new message to classify */
  newMessage: EvalMessage
  /** Recent messages for context */
  recentMessages?: EvalMessage[]
  /** Active conversations in the stream */
  activeConversations?: EvalConversationSummary[]
  /** Conversations the new message explicitly quote-replies (strong continuity signal) */
  replyTargets?: EvalReplyTarget[]
  /** Stream type (channel, scratchpad, thread, dm) */
  streamType?: string
  /** Category for organizing test cases */
  category?:
    | "new-topic"
    | "continue-existing"
    | "topic-shift"
    | "resolution"
    | "ambiguous"
    | "reply"
    | "continuity"
    | "session-gap"
    | "merge-resistance"
}

/**
 * Output from boundary extraction.
 */
export interface BoundaryExtractionOutput {
  /** The input that was provided */
  input: BoundaryExtractionInput
  /** ID of conversation to join, or null for new conversation */
  conversationId: string | null
  /** Topic summary if starting new conversation */
  newConversationTopic?: string
  /** Updates to completeness scores */
  completenessUpdates?: Array<{
    conversationId: string
    score: number
    status: ConversationStatus
  }>
  /** Prior messages the extractor chose to move between conversations */
  reassignments?: Array<{
    messageId: string
    toConversationId: string | null
  }>
  /** Confidence in classification (0-1) */
  confidence: number
  /** Error message if extraction failed */
  error?: string
}

/**
 * Expected output for evaluation.
 */
export interface BoundaryExtractionExpected {
  /** Should create a new conversation (conversationId should be null) */
  expectNewConversation?: boolean
  /** Should join this specific conversation ID */
  expectConversationId?: string
  /** New topic should contain these words (if new conversation) */
  topicContains?: string[]
  /** New topic should NOT contain these words (e.g. framing preamble, language labels) */
  topicNotContains?: string[]
  /** Minimum confidence threshold */
  minConfidence?: number
  /** Should update completeness for these conversations */
  expectCompletenessUpdate?: {
    conversationId: string
    minScore?: number
    maxScore?: number
    status?: ConversationStatus
  }[]
  /**
   * No prior message may be reassigned (merge-resistance: a correct
   * classification must not come with collateral merges into a blob).
   */
  expectNoReassignments?: boolean
  /** These message ids MUST be reassigned (sandwich-split correction). */
  expectReassignedMessageIds?: string[]
}
