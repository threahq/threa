// Re-export the shared agent runtime from @threa/agent-runtime so existing
// backend imports (`../runtime`, `../../runtime`) keep working.
export {
  defineAgentTool,
  toVercelToolDefs,
  type AgentTool,
  type AgentToolConfig,
  type AgentToolResult,
  type ExecutionPhase,
  type AgentEvent,
  type NewMessageInfo,
  type AgentObserver,
  OtelObserver,
  AgentRuntime,
  mergeSourceItems,
  type AgentRuntimeConfig,
  type AgentRuntimeResult,
  type NewMessageAwareness,
  runGeneralResearch,
  type GeneralResearchResult,
} from "@threa/agent-runtime"

// Backend-only observer: stays here because it writes to PostgreSQL via the
// session trace emitter.
export { SessionTraceObserver } from "./session-trace-observer"
