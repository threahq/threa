export { defineAgentTool, tierOfBuiltTool, toVercelToolDefs, buildToolPromptSections } from "./runtime/agent-tool"
export type { AgentTool, AgentToolConfig, AgentToolResult, ExecutionPhase } from "./runtime/agent-tool"
export type { ToolGuardian, ToolGuardianRequest, ToolGuardianVerdict } from "./runtime/tool-guardian"
export { stripEchoedPointerTag } from "./runtime/output-guard"
export {
  negotiateCapabilities,
  resolveDeliveryVerdict,
  TrustTiers,
  EXTERNAL_SEALED_DELIVERY,
} from "./runtime/negotiate-capabilities"
export type {
  NegotiateCapabilitiesParams,
  NegotiatedCapabilities,
  TrustTier,
  SealingContext,
  DeliveryVerdict,
} from "./runtime/negotiate-capabilities"
export type { AgentEvent, NewMessageInfo, TraceContextMessage } from "./runtime/agent-events"
export type { AgentObserver } from "./runtime/agent-observer"
export { AgentRuntime, mergeSourceItems } from "./runtime/agent-runtime"
export type { AgentRuntimeConfig, AgentRuntimeResult, NewMessageAwareness } from "./runtime/agent-runtime"
export {
  InProcessTurnDriver,
  EnclaveTurnDriver,
  TurnDeliveries,
  declaredUnsupported,
  isDeclaredUnsupported,
} from "./runtime/turn-driver"
export type {
  AnyTurnDriver,
  BaseTurnDriver,
  DispatchedTurnDriver,
  DispatchedTurnRequest,
  ExternalContextHandle,
  ExternalHistoryMessage,
  SynchronousTurnDriver,
  TurnCommit,
  TurnCommitReceipt,
  TurnDelivery,
  TurnDispatchBinding,
  TurnDispatchReceipt,
  TurnDriver,
  TurnRequest,
  TurnResult,
  TurnSink,
  TurnSinkResolution,
  TurnTrigger,
  DeclaredUnsupported,
} from "./runtime/turn-driver"
export {
  TurnDigestCollector,
  generateTurnDigest,
  parseTurnDigestStepContent,
  formatTurnDigestsForPrompt,
  TURN_DIGEST_INJECT_COUNT,
  type ToolWorkRecord,
  type TurnDigestPromptEntry,
} from "./runtime/turn-digest"
export {
  foldRollingSummary,
  clampRollingSummary,
  formatConversationMemoryForPrompt,
  ROLLING_SUMMARY_MAX_CHARS,
  ROLLING_SUMMARY_MAX_TOKENS,
  ROLLING_SUMMARY_TEMPERATURE,
  ROLLING_SUMMARY_BATCH_SIZE,
  ROLLING_SUMMARY_MAX_BATCHES,
  type RollingSummaryMessage,
  type FoldRollingSummaryParams,
} from "./runtime/rolling-summary"
export {
  TraceProjector,
  type TraceStepSink,
  type TraceStepRecord,
  type TraceStepFinalize,
  type TraceSubstepEntry,
} from "./runtime/trace-projector"

export {
  createWebSearchTool,
  type WebPageOpener,
  type WebSearchInput,
  type WebSearchJudge,
  type WebSearchResult,
  type WebSearchVerdict,
} from "./tools/web-search-tool"
export {
  createExaEngine,
  createSerperEngine,
  createWebSearchEngines,
  WebSearchEngineNames,
  type WebPage,
  type WebSearchEngine,
  type WebSearchEngineKeys,
  type WebSearchEngineName,
} from "./tools/web-search-engines"
export {
  createReadUrlTool,
  createWebPageOpener,
  type ReadUrlInput,
  type ReadUrlResult,
  type ReadUrlVia,
} from "./tools/read-url-tool"
export { createBrowserbasePageBrowser, type PageBrowser } from "./tools/page-browser"

// Bounded research sub-agent (shared by backend personas + the enclave)
export {
  runGeneralResearch,
  ResearchProgressObserver,
  composeAbortSignal,
  normalizeSourceType,
  readStringField,
  type ComposedAbortSignal,
  type RunGeneralResearchDeps,
  type GeneralResearchRunInput,
  type GeneralResearchResult,
  type GeneralResearchSubstep,
  createGeneralResearchTool,
  type GeneralResearchToolInput,
  type GeneralResearchCallbacks,
  type RunGeneralResearchOptions,
  GENERAL_RESEARCH_MODEL_ID,
  GENERAL_RESEARCH_TEMPERATURE,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  GENERAL_RESEARCH_TOTAL_BUDGET_MS,
  GENERAL_RESEARCH_MAX_BRIEF_CHARS,
  GENERAL_RESEARCH_SYSTEM_PROMPT,
} from "./research"
export {
  createSendMessageTool,
  type SendMessageInput,
  type SendMessageInputWithSources,
  type SendMessageResult,
} from "./tools/send-message-tool"
export { createKeepResponseTool } from "./tools/keep-response-tool"

export {
  createAI,
  extractUsageWithCost,
  parseModelId,
  providerRequiresCacheBreakpoints,
  applyCacheBreakpoints,
  isAbortError,
  AISpendDeniedError,
  type AccessLogSink,
  type AI,
  type AIConfig,
  type AIOrigin,
  type CostContext,
  type CostRecorder,
  type SpendAdmissionRequest,
  type SpendDecision,
  type SpendGate,
  type EmbedManyOptions,
  type EmbedOptions,
  type GenerateDecisionsOptions,
  type GenerateObjectOptions,
  type GenerateTextOptions,
  type GenerateTextWithToolsOptions,
  type GenerateTextWithToolsResult,
  type ImageContentPart,
  type ManyEmbedResult,
  type Message,
  type MessageContent,
  type MessageRole,
  type ObjectResult,
  type ParsedModel,
  type ReasoningEffort,
  type RepairFunction,
  type SingleEmbedResult,
  type TelemetryConfig,
  type TelemetryMetadataValue,
  type TextContentPart,
  type TextResult,
  type UsageWithCost,
} from "./ai/ai"
export { DecisionsAvailability } from "./ai/decisions-availability"
export {
  choiceAnswer,
  DecisionsRequestError,
  noulAnswer,
  rescaleScore,
  isDecisionsModel,
  scoreAnswer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionsResult,
  type NoulAnswer,
  type NoulQuestion,
  type ScoreAnswer,
  type ScoreQuestion,
} from "./ai/decisions"

export { DebugCallback, getDebugCallbacks, isDebugEnabled } from "./ai/debug-callback"

export { stripMarkdownFences, createJsonRepair, type SemanticFieldMapping } from "./ai/text-utils"

export {
  createModelRegistry,
  type ModelRegistry,
  type ModelCapabilities,
  type InputModality,
  type OutputModality,
  type StreamingCapability,
} from "./ai/model-registry"

// Truncation helpers (used by enclave-side orchestrator + backend personas)
export { MAX_MESSAGE_CHARS, truncateMessages } from "./runtime/truncation"

export { screenWebToolOutput, type ToolOutputScreen } from "./runtime/tool-trust-boundary"
