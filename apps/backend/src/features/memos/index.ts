// Repositories
export { MemoRepository } from "./repository"
export type {
  Memo,
  InsertMemoParams,
  UpdateMemoParams,
  MemoSearchFilters,
  MemoSearchResult,
  SemanticSearchParams,
  FullTextSearchParams,
  HybridSearchParams,
} from "./repository"

export { classifyMemoQueryIntent } from "./query-intent"
export type { MemoQueryIntent, MemoQueryIntentResult } from "./query-intent"

export { PendingItemRepository } from "./pending-item-repository"
export type { PendingMemoItem, QueuePendingItemParams } from "./pending-item-repository"

// AI pipeline
export { MemoClassifier } from "./classifier"
export type { ConversationClassification, ClassifierContext } from "./classifier"

export { Memorizer } from "./memorizer"
export type { MemoContent, MemorizerContext } from "./memorizer"

// Config (INV-44)
export {
  MEMO_CLASSIFIER_MODEL_ID,
  MEMO_MEMORIZER_MODEL_ID,
  MEMO_TEMPERATURES,
  MEMO_GEM_CONFIDENCE_FLOOR,
  MEMO_SINGLE_MESSAGE_AGE_GATE_MS,
  conversationClassificationSchema,
  memoContentSchema,
  getMemorizerSystemPrompt,
} from "./config"

export { EMBEDDING_MODEL_ID } from "./embedding-config"

// Services
export { MemoService } from "./service"
export type { MemoServiceLike, MemoServiceConfig, ProcessResult } from "./service"

export { StubMemoService } from "./service.stub"

export { MemoExplorerService } from "./explorer-service"
export type {
  MemoExplorerServiceDeps,
  MemoExplorerFilters,
  MemoExplorerPermissions,
  MemoExplorerSearchParams,
  MemoExplorerResult,
  MemoExplorerDetail,
  MemoExplorerSourceMessage,
  MemoStreamRef,
} from "./explorer-service"

export { MemoReranker } from "./reranker"
export type { RerankerLike, RerankCandidate, RerankContext, RerankerServiceConfig } from "./reranker"

export { StubReranker } from "./reranker.stub"

export { EmbeddingService } from "./embedding-service"
export type { EmbeddingServiceLike, EmbeddingServiceConfig, EmbeddingContext } from "./embedding-service"

export { StubEmbeddingService } from "./embedding-service.stub"

// Outbox handlers
export { MemoAccumulatorHandler } from "./accumulator-outbox-handler"
export type { MemoAccumulatorHandlerConfig } from "./accumulator-outbox-handler"

export { EmbeddingHandler } from "./embedding-outbox-handler"
export type { EmbeddingHandlerConfig } from "./embedding-outbox-handler"

// Workers
export { createMemoBatchCheckWorker, createMemoBatchProcessWorker } from "./batch-worker"
export type { MemoBatchWorkerDeps } from "./batch-worker"

export { createEmbeddingWorker } from "./embedding-worker"
export type { EmbeddingWorkerDeps } from "./embedding-worker"

// Handlers
export { createMemoHandlers } from "./handlers"
