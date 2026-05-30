// Enclave-facing barrel: the agent loop and its tool primitives, with NO pull
// on the AI provider layer (`createAI` → LangChain/OpenRouter SDK) or the OTEL
// observer. The enclave runs the same loop next to decrypted plaintext, so it
// must keep its dependency (and egress) surface minimal — it supplies its own
// `AgentRuntimeAI` over a single OpenRouter connection and emits no telemetry.
// The `.` and `./runtime` barrels intentionally keep exporting OtelObserver and
// createAI for the backend; this entry point is the curated subset that does not.
export { AgentRuntime } from "./agent-runtime"
export type { AgentRuntimeAI, AgentRuntimeConfig, AgentRuntimeResult, NewMessageAwareness } from "./agent-runtime"
export { defineAgentTool, toVercelToolDefs } from "./agent-tool"
export type { AgentTool, AgentToolConfig, AgentToolResult, ExecutionPhase } from "./agent-tool"
export type { AgentEvent, NewMessageInfo } from "./agent-events"
export type { AgentObserver } from "./agent-observer"
export { MAX_MESSAGE_CHARS, truncateMessages } from "./truncation"
export { protectToolOutputText, protectToolOutputBlocks, type MultimodalContentBlock } from "./tool-trust-boundary"
export { mergeSourceItems } from "./agent-runtime"

// Web primitives + bounded research — enclave-safe (call external services
// directly, no backend callback, no AI provider layer / OTEL pull).
export { createWebSearchTool, type WebSearchInput, type WebSearchResult } from "../tools/web-search-tool"
export { createReadUrlTool, type ReadUrlInput, type ReadUrlResult } from "../tools/read-url-tool"
export {
  runGeneralResearch,
  ResearchProgressObserver,
  composeAbortSignal,
  type ComposedAbortSignal,
  type RunGeneralResearchDeps,
  type GeneralResearchRunInput,
  type GeneralResearchResult,
  type GeneralResearchSubstep,
  createGeneralResearchTool,
  type GeneralResearchCallbacks,
  type RunGeneralResearchOptions,
  GENERAL_RESEARCH_TOTAL_BUDGET_MS,
} from "../research"
