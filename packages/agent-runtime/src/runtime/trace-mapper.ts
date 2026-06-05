import { AgentReconsiderationDecisions, AgentStepTypes, type AgentStepType, type TraceSource } from "@threa/types"
import type { AgentEvent, NewMessageInfo } from "./agent-events"
import type { AgentObserver } from "./agent-observer"

/**
 * The single canonical AgentEvent → trace-step state machine, shared by every
 * host. Before this existed, the backend's SessionTraceObserver and the
 * enclave's EnclaveTraceObserver hand-mirrored the same lifecycle and silently
 * diverged on which event types they handled (the enclave dropped
 * `message:edited`/`response:kept`/`reconsidering`/`context:received`). Now the
 * mapper owns the lifecycle — including the exact JSON content shapes for
 * reconsider/context steps, so both hosts persist render-identical steps — and
 * a host only supplies a {@link TraceStepSink}: where an opened step goes (DB +
 * socket for the companion; seal + POST for the enclave).
 *
 * The `default: assertNever` arm makes the switch exhaustive over the
 * AgentEvent union: adding a new event variant fails to compile here instead of
 * degrading silently in whichever host forgot it.
 *
 * Step lifecycle (identical to the previous two implementations):
 * - `thinking` / `message:sent` / `message:edited` / `response:kept` /
 *   `context:received` / `reconsidering`: content is known up front — the step
 *   opens with its content and finalizes immediately (the finalize carries
 *   `messageId`/`sources`/`durationMs` where the event provides them).
 * - `tool:start` → `tool:progress`* → `tool:complete`/`tool:error`: the real
 *   in-flight window. The step opens contentless at tool:start (a refresh
 *   mid-execution sees the in-progress step instead of a gap), substeps stream
 *   the phase text plus a running snapshot for refresh recovery, and the
 *   finalize carries the tool's result (or error) content.
 * - Hidden tools (`tool:start` with `hidden`) never open a step; their
 *   progress is forwarded as a detached substep so a sink that can render
 *   unanchored phase text (the enclave) may, and one that cannot (the
 *   companion's step-anchored trace) drops it.
 * - `tool:error` with no preceding `tool:start` and no hidden marker is the
 *   unknown-tool path: a synthetic TOOL_ERROR step is opened + finalized so
 *   the error is visible in the trace.
 */
export interface TraceStepSink {
  /**
   * Open a step. The sink persists/transmits the started frame and returns a
   * handle the mapper uses for that step's substeps and finalize.
   */
  openStep(op: { stepType: AgentStepType; content?: string }): Promise<TraceStepHandle>

  /**
   * A substep with no open step to anchor to (hidden tool). Sinks that can
   * only render step-anchored substeps implement this as a no-op.
   */
  emitDetachedSubstep(sub: { stepType: AgentStepType; text: string }): void | Promise<void>
}

/** Handle for one opened step — returned by {@link TraceStepSink.openStep}. */
export interface TraceStepHandle {
  /**
   * One phase-text update for the in-flight step. `snapshot` is the full
   * running substep log including this entry, so the sink can persist a
   * refresh-recoverable record without the mapper re-sending history.
   */
  substep(update: TraceSubstepUpdate): void | Promise<void>

  /**
   * Finalize the step. `content` is present only when the finalize carries new
   * content (tool results, errors, message bodies); when absent, the content
   * given at open stands.
   */
  finalize(fin: TraceStepFinalize): Promise<void>
}

export interface TraceSubstepUpdate {
  stepType: AgentStepType
  text: string
  snapshot: Array<{ text: string; at: string }>
  /** For sink-side diagnostics (e.g. logging a failed snapshot persist). */
  toolCallId: string
  toolName: string
}

export interface TraceStepFinalize {
  stepType: AgentStepType
  content?: string
  sources?: TraceSource[]
  messageId?: string
  durationMs?: number
}

export class TraceMapper implements AgentObserver {
  /** In-flight step handles by tool call, so completion finalizes the same step. */
  private readonly openByToolCallId = new Map<string, TraceStepHandle>()
  /** Running substep log per in-flight tool call — each progress event sends the full snapshot. */
  private readonly substepLogByToolCallId = new Map<string, Array<{ text: string; at: string }>>()
  /** Tool calls hidden at tool:start — distinguishes "hidden, skip" from "unknown, synthesize error step". */
  private readonly hiddenToolCallIds = new Set<string>()

  constructor(private readonly sink: TraceStepSink) {}

  async handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "thinking": {
        const step = await this.sink.openStep({ stepType: AgentStepTypes.THINKING, content: event.content })
        await step.finalize({ stepType: AgentStepTypes.THINKING, durationMs: event.durationMs })
        break
      }

      case "tool:start": {
        // Hidden tools (e.g. individual workspace search helpers) are recorded
        // in OTEL but never surface in the user-facing trace.
        if (event.hidden) {
          this.hiddenToolCallIds.add(event.toolCallId)
          break
        }
        // Open the in-flight step with no content (the result isn't known yet);
        // cache the handle so tool:complete/tool:error finalizes the same step.
        const step = await this.sink.openStep({ stepType: event.stepType })
        this.openByToolCallId.set(event.toolCallId, step)
        this.substepLogByToolCallId.set(event.toolCallId, [])
        break
      }

      case "tool:progress": {
        const text = event.substep
        if (!text || !text.trim()) break
        const step = this.openByToolCallId.get(event.toolCallId)
        if (!step) {
          // No open step to anchor to (hidden tool) — sink decides whether
          // unanchored phase text is renderable.
          await this.sink.emitDetachedSubstep({ stepType: event.stepType, text })
          break
        }
        const log = this.substepLogByToolCallId.get(event.toolCallId) ?? []
        log.push({ text, at: new Date().toISOString() })
        await step.substep({
          stepType: event.stepType,
          text,
          snapshot: [...log],
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        })
        break
      }

      case "tool:complete": {
        const step = this.openByToolCallId.get(event.toolCallId)
        // Clear all per-tool-call state up front so nothing leaks.
        this.openByToolCallId.delete(event.toolCallId)
        this.substepLogByToolCallId.delete(event.toolCallId)
        this.hiddenToolCallIds.delete(event.toolCallId)
        if (!step) break // hidden tool — no step was opened
        await step.finalize({
          stepType: event.trace.stepType,
          content: event.trace.content,
          sources: event.trace.sources,
          durationMs: event.durationMs,
        })
        break
      }

      case "tool:error": {
        const content = `${event.toolName} failed: ${event.error}`
        const step = this.openByToolCallId.get(event.toolCallId)
        if (step) {
          // Finalize the in-flight step with the error.
          this.openByToolCallId.delete(event.toolCallId)
          this.substepLogByToolCallId.delete(event.toolCallId)
          await step.finalize({ stepType: AgentStepTypes.TOOL_ERROR, content, durationMs: event.durationMs })
        } else if (!this.hiddenToolCallIds.has(event.toolCallId)) {
          // Unknown tool: the runtime emits tool:error with no preceding
          // tool:start. Synthesize an opened + finalized error step so it's
          // still visible.
          const synthetic = await this.sink.openStep({ stepType: AgentStepTypes.TOOL_ERROR, content })
          await synthetic.finalize({ stepType: AgentStepTypes.TOOL_ERROR, durationMs: event.durationMs })
        }
        this.hiddenToolCallIds.delete(event.toolCallId)
        break
      }

      case "message:sent": {
        const step = await this.sink.openStep({ stepType: AgentStepTypes.MESSAGE_SENT, content: event.content })
        await step.finalize({
          stepType: AgentStepTypes.MESSAGE_SENT,
          content: event.content,
          messageId: event.messageId,
          sources: event.sources,
        })
        break
      }

      case "message:edited": {
        const step = await this.sink.openStep({ stepType: AgentStepTypes.MESSAGE_EDITED, content: event.content })
        await step.finalize({
          stepType: AgentStepTypes.MESSAGE_EDITED,
          content: event.content,
          messageId: event.messageId,
          sources: event.sources,
        })
        break
      }

      case "response:kept": {
        const step = await this.sink.openStep({
          stepType: AgentStepTypes.RECONSIDERING,
          content: JSON.stringify({
            decision: AgentReconsiderationDecisions.KEPT_PREVIOUS_RESPONSE,
            reason: event.reason,
          }),
        })
        await step.finalize({ stepType: AgentStepTypes.RECONSIDERING })
        break
      }

      case "context:received": {
        const step = await this.sink.openStep({
          stepType: AgentStepTypes.CONTEXT_RECEIVED,
          content: JSON.stringify({ messages: event.messages.map(toMessageSnippet) }),
        })
        await step.finalize({ stepType: AgentStepTypes.CONTEXT_RECEIVED })
        break
      }

      case "reconsidering": {
        const step = await this.sink.openStep({
          stepType: AgentStepTypes.RECONSIDERING,
          content: JSON.stringify({
            draftResponse: event.draft,
            newMessages: event.newMessages.map(toMessageSnippet),
          }),
        })
        await step.finalize({ stepType: AgentStepTypes.RECONSIDERING })
        break
      }

      // Session lifecycle events are not trace steps — hosts surface them via
      // their own session lifecycle (started/completed/failed), not the trace.
      case "session:start":
      case "session:end":
      case "session:error":
        break

      default:
        assertNever(event)
    }
  }
}

/** The persisted shape for one message inside a context/reconsider step. */
function toMessageSnippet(m: NewMessageInfo): {
  messageId: string
  changeType: NewMessageInfo["changeType"]
  authorName: string
  authorType: NewMessageInfo["authorType"]
  createdAt: string
  content: string
} {
  return {
    messageId: m.messageId,
    changeType: m.changeType,
    authorName: m.authorName,
    authorType: m.authorType,
    createdAt: m.createdAt,
    content: m.content.slice(0, 300),
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled AgentEvent in TraceMapper: ${JSON.stringify(value)}`)
}
