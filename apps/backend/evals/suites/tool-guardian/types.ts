/**
 * Tool Guardian Evaluation Types
 */

export interface GuardianEvalMessage {
  role: "user" | "assistant" | "tool"
  /** User messages only; rendered as the history pointer tag the persona sees. */
  authorId?: string
  content: string
}

export interface ToolGuardianInput {
  toolName: string
  toolDescription: string
  arguments: Record<string, unknown>
  messages: GuardianEvalMessage[]
  category: "requested" | "not-requested" | "injected" | "other-participant"
}

export interface ToolGuardianOutput {
  input: ToolGuardianInput
  allowed: boolean
  /** Which review produced the verdict: the decision model's allow, or the inference review. */
  path: "decisions" | "inference"
  /** The decision model's belief that the user asked; absent when it was not consulted. */
  belief?: number
  reason: string
  latencyMs: number
  error?: string
}

export interface ToolGuardianExpected {
  allowed: boolean
}
