export { createConversationHandlers } from "./handlers"

export { conversationAssigner, PROVISIONAL_ATTACH_WINDOW_MINUTES } from "./conversation-assigner"

export { ConversationService } from "./service"
export type { ConversationWithStaleness, ListConversationsOptions } from "./service"

export { BoardExclusionService } from "./board-exclusion-service"
export type { BoardExclusions } from "./board-exclusion-service"
export { BoardExclusionRepository } from "./board-exclusion-repository"

export { BoundaryExtractionService } from "./boundary-extraction-service"

export { LLMBoundaryExtractor } from "./boundary-extraction/llm-extractor"
export { StubBoundaryExtractor } from "./boundary-extraction/stub-extractor"
export type {
  BoundaryExtractor,
  ExtractionContext,
  ExtractionResult,
  ConversationSummary,
  CompletenessUpdate,
  MessageAssignment,
  Reassignment,
  ReplyTarget,
  SplitContext,
  SplitProposal,
  SplitGroup,
} from "./boundary-extraction/types"
export {
  BOUNDARY_EXTRACTION_MODEL_ID,
  BOUNDARY_EXTRACTION_TEMPERATURE,
  BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
  BOUNDARY_EXTRACTION_PROMPT,
  extractionResponseSchema,
  CONVERSATION_SPLIT_SYSTEM_PROMPT,
  CONVERSATION_SPLIT_PROMPT,
  conversationSplitResponseSchema,
  SETTLING_CONFIDENCE_THRESHOLD,
  SETTLING_MAX_AGE_SECONDS,
} from "./boundary-extraction/config"
export type { ExtractionResponse, ConversationSplitResponse } from "./boundary-extraction/config"

export { BoundaryExtractionHandler } from "./boundary-extraction-outbox-handler"
export type { BoundaryExtractionHandlerConfig } from "./boundary-extraction-outbox-handler"

export { createBoundaryExtractionWorker } from "./boundary-extraction-worker"
export type { BoundaryExtractionWorkerDeps } from "./boundary-extraction-worker"

export {
  createStalenessSweepWorker,
  SWEEP_STALLED_AFTER_SECONDS,
  SWEEP_RESOLVED_AFTER_SECONDS,
} from "./staleness-sweep-worker"
export type { StalenessSweepWorkerDeps } from "./staleness-sweep-worker"

export { ConversationRepository } from "./repository"
export {
  MessageConversationStateRepository,
  MESSAGE_CONVERSATION_STATES,
  SETTLED_BY_REASONS,
} from "./settling-repository"
export type { MessageConversationState, SettledByReason, SettlingRow } from "./settling-repository"
export { settleMessagesOnEngagement, emitSettledConversationUpdates } from "./settling-service"
export { ConversationFeedbackRepository } from "./feedback-repository"
export type { Conversation, InsertConversationParams, UpdateConversationParams } from "./repository"

export { addStalenessFields, computeTemporalStaleness, computeEffectiveCompleteness } from "./staleness"
