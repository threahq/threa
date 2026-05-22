/**
 * Boundary Extraction Evaluation Types
 */

import type { ConversationStatus } from "@threa/types"

/**
 * Simplified conversation summary for eval input.
 */
export interface EvalConversationSummary {
  id: string
  topicSummary: string | null
  messageCount: number
  lastMessagePreview: string
  participantIds: string[]
  completenessScore: number
  /** Lifecycle status; defaults to "active" when omitted. */
  status?: ConversationStatus
}

/**
 * Simplified message for eval input.
 */
export interface EvalMessage {
  authorId: string
  authorType: "user" | "persona"
  contentMarkdown: string
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
  /** Stream type (channel, scratchpad, thread, dm) */
  streamType?: string
  /** Category for organizing test cases */
  category?: "new-topic" | "continue-existing" | "topic-shift" | "resolution" | "ambiguous"
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
}
