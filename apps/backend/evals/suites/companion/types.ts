/**
 * Types for Companion Agent Evaluation
 */

import type { CompanionInput, CompanionExpected } from "./cases"
import type { AgentStepType, SourceItem } from "@threa/types"

/**
 * A message sent by the companion agent.
 */
export interface CompanionMessage {
  /** Message content */
  content: string
  /** Optional sources (from web search, workspace search) */
  sources?: SourceItem[]
}

/**
 * One step of the turn's trace, as the model comparison reads it: which tool
 * the agent reached for, whether the step finished, and what it cited.
 */
export interface CompanionTrajectoryStep {
  stepType: AgentStepType
  completed: boolean
  /** URLs the step attached as sources — the citation trail behind the reply. */
  sourceUrls: string[]
  /** Truncated step content, kept only for tool_call/tool_error steps. */
  content?: string | null
}

/**
 * Output from the companion agent evaluation task.
 */
export interface CompanionOutput {
  /** The input that was provided */
  input: CompanionInput
  /** Messages sent by the agent (may be empty if agent decided not to respond) */
  messages: CompanionMessage[]
  /** Whether the agent decided to respond */
  responded: boolean
  /** Tool calls made during processing */
  toolCalls?: Array<{
    name: string
    args: Record<string, unknown>
  }>
  /** Every trace step the turn produced, in order. */
  trajectory?: CompanionTrajectoryStep[]
  /** Error if the task failed */
  error?: string
}

// Re-export input and expected types
export type { CompanionInput, CompanionExpected }
