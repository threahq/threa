import type { AgentStepType, TraceSource, AuthorType } from "@threa/types"

// ---------------------------------------------------------------------------
// NewMessageInfo — shared type for new-message checking
// ---------------------------------------------------------------------------

export interface NewMessageInfo {
  sequence: bigint
  messageId: string
  changeType: "message_created" | "message_edited" | "message_deleted"
  content: string
  authorId: string
  authorName: string
  authorType: AuthorType
  createdAt: string
}

// ---------------------------------------------------------------------------
// AgentEvent — emitted by the runtime, consumed by observers
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "session:start"; sessionId: string; inputSummary?: string }
  | { type: "thinking"; content: string; durationMs: number }
  | {
      type: "tool:start"
      toolCallId: string
      toolName: string
      /**
       * Trace step type the tool produces. Carried here so the observer can
       * create the persisted step row at tool:start rather than deferring to
       * tool:complete — a refresh mid-execution then sees the in-progress step
       * instead of a gap.
       */
      stepType: AgentStepType
      input: unknown
      /** When true, SessionTraceObserver skips the user-facing step row (OTEL still records it). */
      hidden?: boolean
    }
  | {
      type: "tool:progress"
      toolCallId: string
      toolName: string
      stepType: AgentStepType
      substep: string
    }
  | {
      type: "tool:complete"
      toolCallId: string
      toolName: string
      input: unknown
      output: string
      durationMs: number
      trace: { stepType: AgentStepType; content: string; sources?: TraceSource[] }
    }
  | { type: "tool:error"; toolCallId: string; toolName: string; error: string; durationMs: number }
  | { type: "message:sent"; messageId: string; content: string; sources?: TraceSource[] }
  | { type: "message:edited"; messageId: string; content: string; sources?: TraceSource[] }
  | { type: "response:kept"; reason: string }
  | { type: "context:received"; messages: NewMessageInfo[] }
  | { type: "reconsidering"; draft: string; newMessages: NewMessageInfo[] }
  | { type: "session:end"; messagesSent: number; sourceCount: number; lastContent?: string }
  | { type: "session:error"; error: string }
