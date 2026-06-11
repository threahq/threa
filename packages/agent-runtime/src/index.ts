// Runtime
export { defineAgentTool, toVercelToolDefs } from "./runtime/agent-tool"
export type { AgentTool, AgentToolConfig, AgentToolResult, ExecutionPhase } from "./runtime/agent-tool"
export type { AgentEvent, NewMessageInfo } from "./runtime/agent-events"
export type { AgentObserver } from "./runtime/agent-observer"
export { OtelObserver } from "./runtime/otel-observer"
export { AgentRuntime, mergeSourceItems } from "./runtime/agent-runtime"
export type { AgentRuntimeConfig, AgentRuntimeResult, NewMessageAwareness } from "./runtime/agent-runtime"
export {
  TurnDigestCollector,
  generateTurnDigest,
  parseTurnDigestStepContent,
  formatTurnDigestsForPrompt,
  TURN_DIGEST_INJECT_COUNT,
  type ToolWorkRecord,
  type TurnDigestPromptEntry,
} from "./runtime/turn-digest"

// Tools (web + internal)
export { createWebSearchTool, type WebSearchInput, type WebSearchResult } from "./tools/web-search-tool"
export { createReadUrlTool, type ReadUrlInput, type ReadUrlResult } from "./tools/read-url-tool"

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

// AI wrapper
export {
  createAI,
  parseModelId,
  isAbortError,
  AIBudgetExceededError,
  type AI,
  type AIConfig,
  type AIOrigin,
  type BudgetEnforcer,
  type BudgetStatus,
  type CostContext,
  type CostRecorder,
  type EmbedManyOptions,
  type EmbedOptions,
  type GenerateObjectOptions,
  type GenerateTextOptions,
  type GenerateTextWithToolsOptions,
  type GenerateTextWithToolsResult,
  type ImageContentPart,
  type LangChainModelResult,
  type ManyEmbedResult,
  type Message,
  type MessageContent,
  type MessageRole,
  type ObjectResult,
  type ParsedModel,
  type RepairFunction,
  type SingleEmbedResult,
  type TelemetryConfig,
  type TextContentPart,
  type TextResult,
  type UsageWithCost,
} from "./ai/ai"
export { CostTracker, type CapturedUsage } from "./ai/openrouter-cost-interceptor"
export { getCostTrackingCallbacks, CostTrackingCallback } from "./ai/cost-tracking-callback"
export { DebugCallback, getDebugCallbacks, isDebugEnabled } from "./ai/debug-callback"

// Text helpers
export { stripMarkdownFences, createJsonRepair, type SemanticFieldMapping } from "./ai/text-utils"

// Model registry
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

// Trust boundary helpers
export {
  protectToolOutputText,
  protectToolOutputBlocks,
  type MultimodalContentBlock,
} from "./runtime/tool-trust-boundary"
