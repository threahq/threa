// Handlers
export { createConversationHandlers } from "./handlers"

// Service
export { ConversationService } from "./service"
export type { ConversationWithStaleness, ListConversationsOptions } from "./service"

// Boundary Extraction Service
export { BoundaryExtractionService } from "./boundary-extraction-service"

// Boundary Extraction
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
} from "./boundary-extraction/types"
export {
  BOUNDARY_EXTRACTION_MODEL_ID,
  BOUNDARY_EXTRACTION_TEMPERATURE,
  BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
  BOUNDARY_EXTRACTION_PROMPT,
  extractionResponseSchema,
} from "./boundary-extraction/config"
export type { ExtractionResponse } from "./boundary-extraction/config"

// Outbox Handler
export { BoundaryExtractionHandler } from "./boundary-extraction-outbox-handler"
export type { BoundaryExtractionHandlerConfig } from "./boundary-extraction-outbox-handler"

// Worker
export { createBoundaryExtractionWorker } from "./boundary-extraction-worker"
export type { BoundaryExtractionWorkerDeps } from "./boundary-extraction-worker"

// Repository
export { ConversationRepository } from "./repository"
export type { Conversation, InsertConversationParams, UpdateConversationParams } from "./repository"

// Assignment Repository
export { ConversationMessageAssignmentRepository } from "./assignment-repository"
export type { ConversationMessageAssignment, AssignmentReason } from "./assignment-repository"

// Staleness
export { addStalenessFields, computeTemporalStaleness, computeEffectiveCompleteness } from "./staleness"
