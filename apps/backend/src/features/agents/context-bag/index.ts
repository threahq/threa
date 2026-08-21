// Public API for the context-bag feature.
// External consumers import from here (INV-52).
export { ContextBagRepository } from "./repository"
export type { InsertContextBagParams } from "./repository"
export { SummaryRepository } from "./summary-repository"
export type { StoredSummary, UpsertSummaryParams } from "./summary-repository"
export { getIntentConfig, canonicalRefKey, assertRefAccess, fetchRef } from "./registry"
export { ThreadResolver } from "./resolvers/thread-resolver"
export { ConversationResolver } from "./resolvers/conversation-resolver"
export { ViewportResolver } from "./resolvers/viewport-resolver"
export { DiscussThreadIntent } from "./intents/discuss-thread"
export { AsideIntent } from "./intents/aside"
export { diffInputs } from "./diff"
export type { DiffResult } from "./diff"
export { renderStable, renderDelta, buildSnapshot } from "./render"
export { fingerprintContent, fingerprintManifest } from "./fingerprint"
export { summarizeThread } from "./summarizer"
export { resolveBagForStream, persistSnapshot, loadOrCreateSummary } from "./resolve"
export type { ResolvedBag, ResolveBagDeps } from "./resolve"
export { precomputeRefSummaries } from "./precompute-service"
export type { PrecomputeRefsDeps, PrecomputeRefsParams, PrecomputedRefResult } from "./precompute-service"
export { createContextBagHandlers } from "./handlers"
export {
  fetchStreamBag,
  type ContextRefSource,
  type EnrichedContextRef,
  type StreamContextBagResponse,
} from "./fetch-stream-bag"
export { appendBagToSystemPrompt } from "./prompt"
export {
  contextBagSchema,
  contextRefSchema,
  contextIntentSchema,
  contextRefKindSchema,
  type ContextBagInput,
  type ContextRefInput,
} from "./schemas"
export type {
  StoredContextBag,
  SummaryInput,
  LastRenderedSnapshot,
  RenderableMessage,
  ResolvedRef,
  Resolver,
  IntentConfig,
  SummarizerDeps,
} from "./types"
