// Internal package barrel so tool files can keep their existing
// `import { defineAgentTool, type AgentToolResult } from "../runtime"` shape.
export { defineAgentTool, toVercelToolDefs, buildToolPromptSections } from "./agent-tool"
export type { AgentTool, AgentToolConfig, AgentToolResult, ExecutionPhase } from "./agent-tool"
export { negotiateCapabilities } from "./negotiate-capabilities"
export type { NegotiateCapabilitiesParams, NegotiatedCapabilities } from "./negotiate-capabilities"
export type { AgentEvent, NewMessageInfo, TraceContextMessage } from "./agent-events"
export type { AgentObserver } from "./agent-observer"
export { OtelObserver } from "./otel-observer"
export { AgentRuntime } from "./agent-runtime"
export type { AgentRuntimeConfig, AgentRuntimeResult, NewMessageAwareness } from "./agent-runtime"
export {
  InProcessTurnDriver,
  EnclaveTurnDriver,
  TurnDeliveries,
  declaredUnsupported,
  isDeclaredUnsupported,
} from "./turn-driver"
export type {
  TurnCommit,
  TurnCommitReceipt,
  TurnDelivery,
  TurnDriver,
  TurnRequest,
  TurnResult,
  TurnSink,
  DeclaredUnsupported,
} from "./turn-driver"
export {
  TurnDigestCollector,
  generateTurnDigest,
  parseTurnDigestStepContent,
  formatTurnDigestsForPrompt,
  TURN_DIGEST_INJECT_COUNT,
  type ToolWorkRecord,
  type TurnDigestPromptEntry,
} from "./turn-digest"
export {
  TraceProjector,
  type TraceStepSink,
  type TraceStepRecord,
  type TraceStepFinalize,
  type TraceSubstepEntry,
} from "./trace-projector"
