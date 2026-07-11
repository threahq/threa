export { createAgentSessionHandlers } from "./session-handlers"

export { PersonaAgent } from "./persona-agent"
export type { PersonaAgentDeps, PersonaAgentInput, PersonaAgentResult, WithSessionResult } from "./persona-agent"

export { resolveTurnPurpose, deriveTurnFlags } from "./turn-purpose"
export type { TurnPurpose, TurnPurposeKind } from "./turn-purpose"

export { resolveTurnModel } from "./turn-model"
export type { ResolvedTurnModel, TurnModelContext } from "./turn-model"

export { defineAgentTool, toVercelToolDefs, AgentRuntime, createSessionTraceProjector, OtelObserver } from "./runtime"
export type {
  AgentTool,
  AgentToolConfig,
  AgentToolResult,
  AgentEvent,
  NewMessageInfo,
  AgentObserver,
  AgentRuntimeConfig,
  AgentRuntimeResult,
} from "./runtime"

export {
  buildAgentContext,
  buildToolSet,
  withCompanionSession,
  truncateMessages,
  MAX_MESSAGE_CHARS,
  stripInaccessibleAgentRefs,
} from "./companion"
export type { ContextDeps, ContextParams, AgentContext, ToolSetConfig, DroppedRef, DroppedRefReason } from "./companion"

export { TraceEmitter, SessionTrace, ActiveStep } from "./trace-emitter"

export { SessionAbortRegistry } from "./session-abort-registry"
export type { SessionAbortContext } from "./session-abort-registry"

export { AgentSessionMetricsCollector } from "./session-metrics"

export { CompanionHandler } from "./companion-outbox-handler"
export type { CompanionHandlerConfig } from "./companion-outbox-handler"
export { MentionInvokeHandler } from "./mention-invoke-outbox-handler"
export type { MentionInvokeHandlerConfig } from "./mention-invoke-outbox-handler"
export { AgentMessageMutationHandler } from "./message-mutation-outbox-handler"
export type { AgentMessageMutationHandlerConfig } from "./message-mutation-outbox-handler"
export {
  ContextBagPrecomputeHandler,
  createContextBagPrecomputeWorker,
  CONTEXT_BAG_PRECOMPUTE_QUEUE,
} from "./context-bag-precompute-handler"
export type {
  ContextBagPrecomputeHandlerConfig,
  ContextBagPrecomputeWorkerDeps,
} from "./context-bag-precompute-handler"

export {
  ContextBagRepository,
  SummaryRepository,
  resolveBagForStream,
  persistSnapshot,
  loadOrCreateSummary,
  precomputeRefSummaries,
  createContextBagHandlers,
  fetchStreamBag,
  appendBagToSystemPrompt,
  getIntentConfig,
  canonicalRefKey,
  assertRefAccess,
  fetchRef,
  DiscussThreadIntent,
  ThreadResolver,
  ConversationResolver,
  fingerprintContent,
  fingerprintManifest,
  diffInputs,
  renderStable,
  renderDelta,
  buildSnapshot,
  contextBagSchema,
  contextRefSchema,
  contextIntentSchema,
  contextRefKindSchema,
} from "./context-bag"
export type { ContextBagInput, ContextRefInput } from "./context-bag"
export type {
  StoredContextBag,
  SummaryInput,
  LastRenderedSnapshot,
  RenderableMessage,
  ResolvedBag,
  DiffResult,
  IntentConfig,
  PrecomputeRefsDeps,
  PrecomputeRefsParams,
  PrecomputedRefResult,
  ContextRefSource,
  EnrichedContextRef,
  StreamContextBagResponse,
} from "./context-bag"

export { createPersonaAgentWorker, checkForUnseenMessages } from "./persona-agent-worker"
export type { PersonaAgentLike, PersonaAgentWorkerDeps } from "./persona-agent-worker"
export { AgentFollowUpService } from "./follow-up-service"
export { createAgentFollowUpHandlers } from "./follow-up-handlers"
export type { ScheduleFollowUpParams, ScheduleFollowUpResult } from "./follow-up-service"
export { createAgentFollowUpFireWorker } from "./follow-up-worker"
export { AgentFollowUpRepository } from "./follow-up-repository"
export type { AgentFollowUp } from "./follow-up-repository"
export { EpisodeSummaryService } from "./episode-summary-service"
export type { EpisodeSummaryServiceDeps } from "./episode-summary-service"
export { createEpisodeSummarizeWorker } from "./episode-summary-worker"
export { ReflectiveCaptureService } from "./reflective-capture-service"
export type { ReflectiveCaptureServiceDeps } from "./reflective-capture-service"
export { createReflectiveCaptureWorker } from "./reflective-capture-worker"
export { buildSessionDigest } from "./session-digest"
export type { SessionDigest } from "./session-digest"
export { createOrphanSessionCleanup, failSessionWithLifecycle } from "./orphan-session-cleanup"
export type { OrphanSessionCleanup } from "./orphan-session-cleanup"

export { PersonaRepository } from "./persona-repository"
export type { Persona } from "./persona-repository"
export {
  ARIADNE_AGENT_ID,
  EMPTY_AGENT_ID,
  BUILT_IN_AGENTS,
  getBuiltInAgentConfig,
  getVisibleBuiltInAgentConfig,
  isE2eCapablePersona,
  listVisibleBuiltInAgentConfigs,
  applyBuiltInAgentPatch,
  builtInAgentConfigPatchSchema,
  builtInAgentConfigSchema,
} from "./built-in-agents"
export type { BuiltInAgentConfig, BuiltInAgentConfigPatch } from "./built-in-agents"
export { AgentConfigOverrideRepository } from "./agent-config-override-repository"
export type {
  AgentConfigOverride,
  AgentConfigOverrideDetail,
  UpsertAgentConfigOverrideParams,
  UpsertAgentConfigOverrideResult,
} from "./agent-config-override-repository"
export { PersonaConfigService } from "./persona-config-service"
export type { SetPersonaOverrideResult } from "./persona-config-service"
export { createPersonaConfigHandlers } from "./persona-config-handlers"
export { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
export type {
  PersonaConfigDraftDetail,
  PersonaConfigDraftIdentity,
  UpsertPersonaConfigDraftParams,
} from "./persona-config-draft-repository"
export { PersonaConfigRevisionRepository } from "./persona-config-revision-repository"
export type {
  PersonaConfigRevisionRecord,
  InsertPersonaConfigRevisionParams,
} from "./persona-config-revision-repository"

export { hashCallbackToken } from "./callback-token"
export { assertSessionRunning, verifyCallbackToken, assertReplyKeyGeneration } from "./sealed-session-guards"

export { AgentSessionRepository, SessionStatuses } from "./session-repository"
export type {
  AgentSession,
  AgentSessionStep,
  SessionStatus,
  StepType,
  InsertSessionParams,
  UpsertStepParams,
} from "./session-repository"

export { StreamPersonaParticipantRepository } from "./stream-persona-participant-repository"
export type { StreamPersonaParticipant } from "./stream-persona-participant-repository"

export { ConversationSummaryRepository } from "./conversation-summary-repository"
export type {
  AgentConversationSummary,
  UpsertConversationSummaryParams,
  SealedSummary,
} from "./conversation-summary-repository"
export { ConversationSummaryService } from "./conversation-summary-service"

// Quote-reply resolution (used by both companion/ and researcher/)
export {
  resolveQuoteReplies,
  renderMessageWithQuoteContext,
  extractAppendedQuoteContext,
  DEFAULT_MAX_QUOTE_DEPTH,
  DEFAULT_MAX_TOTAL_RESOLVED,
} from "./quote-resolver"
export type { ResolveQuoteRepliesInput, ResolveQuoteRepliesResult } from "./quote-resolver"

// Actor name resolution (users + personas) — shared across companion,
// researcher, and context-bag thread resolution.
export { resolveActorNames } from "./actor-names"

export { buildStreamContext, enrichMessagesWithAttachments } from "./context-builder"

// Per-turn hydration policy (window budget + digest carry; the `Hydrate` seam)
export {
  resolveContextWindowPolicy,
  DEFAULT_CONTEXT_WINDOW_MESSAGES,
  CONTEXT_WINDOW_CANDIDATE_CEILING,
  DEFAULT_CONTEXT_WINDOW_CHARS,
} from "./context-window-policy"
export type { ContextWindowPolicy, ContextEpisode, ResolveContextWindowPolicyParams } from "./context-window-policy"

// Enclave system-prompt assembly (shared builder + reduced toolset) so the
// enclave runs Ariadne on the same prompt as the main app.
export { buildEnclaveSystemPrompt } from "./enclave-system-prompt"
export type {
  Participant,
  AnchorMessage,
  ThreadPathEntry,
  AttachmentContext,
  MessageWithAttachments,
  StreamContext,
  BuildStreamContextOptions,
  EnrichAttachmentsOptions,
} from "./context-builder"

// Tool trust boundary (lives in @threa/agent-runtime; re-exported for backend
// callers that still import from this barrel)
export { protectToolOutputText, protectToolOutputBlocks } from "@threa/agent-runtime"
export type { MultimodalContentBlock } from "@threa/agent-runtime"

export { WorkspaceAgent } from "./researcher"
export type { WorkspaceAgentResult, WorkspaceAgentInput, WorkspaceAgentDeps, WorkspaceSourceItem } from "./researcher"
export { computeAgentAccessSpec } from "./researcher"
export type { AgentAccessSpec, ComputeAccessSpecParams } from "./researcher"

export { GeneralResearcher } from "./general-researcher"
export type {
  GeneralResearcherDeps,
  GeneralResearchInput,
  GeneralResearchResult,
  GeneralResearchSubstep,
} from "./general-researcher"

// Config (exported for static-config-resolver)
export { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "./companion/config"
export { COMPANION_SUMMARY_MODEL_ID, COMPANION_SUMMARY_TEMPERATURE } from "./companion/config"
export {
  EPISODE_SUMMARY_MODEL_ID,
  EPISODE_SUMMARY_TEMPERATURE,
  EPISODE_SUMMARY_MAX_TOKENS,
  EPISODE_SUMMARY_INJECT_COUNT,
} from "./companion/config"
export { SUMMARIZER_MAX_TOKENS, SUMMARIZER_MODEL_ID, SUMMARIZER_TEMPERATURE } from "./context-bag/config"
export { SUPERSEDE_RESPONSE_VALIDATOR_MAX_TOKENS, SUPERSEDE_RESPONSE_VALIDATOR_TEMPERATURE } from "./config"
export { SUPERSEDE_RESPONSE_VALIDATOR_MODEL_ID } from "./config"
export {
  WORKSPACE_AGENT_MODEL_ID,
  WORKSPACE_AGENT_TEMPERATURE,
  WORKSPACE_AGENT_MAX_ITERATIONS,
  WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
  WORKSPACE_AGENT_SYSTEM_PROMPT,
} from "./researcher/config"
export {
  GENERAL_RESEARCH_MODEL_ID,
  GENERAL_RESEARCH_TEMPERATURE,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  GENERAL_RESEARCH_TOTAL_BUDGET_MS,
  GENERAL_RESEARCH_TOOL_POLICY,
} from "./general-researcher"
