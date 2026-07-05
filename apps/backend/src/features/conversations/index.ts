export { createConversationHandlers } from "./handlers"

export { conversationAssigner } from "./conversation-assigner"

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
} from "./boundary-extraction/types"
export {
  BOUNDARY_EXTRACTION_MODEL_ID,
  BOUNDARY_EXTRACTION_TEMPERATURE,
  BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
  BOUNDARY_EXTRACTION_PROMPT,
  extractionResponseSchema,
} from "./boundary-extraction/config"
export type { ExtractionResponse } from "./boundary-extraction/config"

export { BoundaryExtractionHandler } from "./boundary-extraction-outbox-handler"
export type { BoundaryExtractionHandlerConfig } from "./boundary-extraction-outbox-handler"

export { createBoundaryExtractionWorker } from "./boundary-extraction-worker"
export type { BoundaryExtractionWorkerDeps } from "./boundary-extraction-worker"

export { ConversationRepository } from "./repository"
export { ConversationFeedbackRepository } from "./feedback-repository"
export type { Conversation, InsertConversationParams, UpdateConversationParams } from "./repository"

export { addStalenessFields, computeTemporalStaleness, computeEffectiveCompleteness } from "./staleness"
