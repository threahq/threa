import { AgentReconsiderationDecisions, AgentStepTypes, type AgentStepType, type TraceSource } from "@threa/types"
import type { AgentEvent, TraceContextMessage } from "./agent-events"
import type { AgentObserver } from "./agent-observer"

/**
 * An atomic trace step: the content is known up front, so the sink opens and
 * finalizes it in one go (the in-process sink as startStep → complete; the
 * enclave sink as one seal reused for the step:started frame and the finalize,
 * so an open trace dialog sees the content the moment the step opens).
 */
export interface TraceStepRecord {
  stepType: AgentStepType
  content: string
  sources?: TraceSource[]
  messageId?: string
  durationMs?: number
}

/**
 * Finalize params for a step opened at tool:start. `stepType` is wire framing
 * for sinks that frame the finalize as its own message (the enclave's /steps
 * POST carries it; tool:error finalizes as TOOL_ERROR there) — a persisted row
 * always keeps the type it was opened with.
 */
export interface TraceStepFinalize {
  stepType: AgentStepType
  content: string
  sources?: TraceSource[]
  messageId?: string
  durationMs?: number
}

/** One entry of a tool's running substep log, accumulated per tool call. */
export interface TraceSubstepEntry {
  text: string
  at: string
}

/**
 * Where projected steps land. The projector owns the AgentEvent → step state
 * machine; sinks own persistence and delivery only — plaintext DB + socket for
 * the in-process companion, seal + POST for the enclave, append-on-complete for
 * normalized bot invocation frames. `OpenStep` is the sink's opaque handle for
 * an in-flight tool step (an ActiveStep, a minted sealed step id, …).
 */
export interface TraceStepSink<OpenStep> {
  /** Record one atomic step (content known up front). */
  record(step: TraceStepRecord): Promise<void>
  /** Open an in-flight tool step (no content yet — the result isn't known). */
  open(params: { stepType: AgentStepType }): Promise<OpenStep>
  /** Finalize a step opened via `open`, in place. */
  complete(step: OpenStep, final: TraceStepFinalize): Promise<void>
  /**
   * Deliver one mid-run phase text for an open tool step, plus the running
   * snapshot (this phase included) for refresh recovery. The ephemeral phase
   * drives the live "Ariadne is …" indicator; the snapshot persists onto the
   * step row so opening the trace mid-run replays the phases so far.
   */
  substep(params: {
    stepType: AgentStepType
    step: OpenStep
    text: string
    snapshot: TraceSubstepEntry[]
    toolCallId: string
    toolName: string
  }): Promise<void>
}

/**
 * The single AgentEvent → user-facing-trace-step state machine, shared by every
 * surface that projects an agent turn into `agent_session_steps`: the in-process
 * companion, the E2E enclave, and normalized bot invocation frames. Hosts differ
 * only in the injected sink, so an event handled on one surface cannot silently
 * diverge (or go unhandled) on another.
 *
 * Tool lifecycle vs. persistence:
 * - `tool:start` opens the step immediately so a refresh mid-execution sees the
 *   in-progress step instead of a gap. The open handle is cached by toolCallId.
 *   Hidden tools (trace.hidden) skip the user-facing trace entirely — they
 *   appear in OTEL/Langfuse only.
 * - `tool:progress` delivers the phase text plus the running snapshot through
 *   the sink. Empty/whitespace phases and phases with no open step (hidden
 *   tools) are skipped.
 * - `tool:complete` finalizes the cached step with the tool's full trace
 *   content and sources.
 * - `tool:error` finalizes the cached step with the error message. With no
 *   cached step and no hidden marker (the runtime emits tool:error without a
 *   preceding tool:start for unknown tools), a synthetic TOOL_ERROR step is
 *   recorded so the error is visible in the trace.
 *
 * Orchestration-driven steps that the runtime never emits as events (the
 * trailing TURN_DIGEST step) go through `record` directly — same vocabulary,
 * same sink. The leading CONTEXT step is no longer one of them: the runtime
 * emits `context:received` itself at turn start from `config.initialContext`.
 */
export class TraceProjector<OpenStep = unknown> implements AgentObserver {
  private readonly openByToolCallId = new Map<string, OpenStep>()
  /**
   * Accumulated substep log per in-flight tool call, so each phase delivery can
   * carry the full running list without every event carrying the history.
   */
  private readonly substepsByToolCallId = new Map<string, TraceSubstepEntry[]>()
  /** Tool calls hidden at tool:start. Lets tool:error distinguish
   *  "hidden tool, skip" from "unknown tool, record synthetic error step". */
  private readonly hiddenToolCallIds = new Set<string>()

  constructor(private readonly sink: TraceStepSink<OpenStep>) {}

  /**
   * Record one atomic step outside the runtime's event stream — the
   * orchestration layer drives the trailing TURN_DIGEST step through this.
   */
  async record(step: TraceStepRecord): Promise<void> {
    await this.sink.record(step)
  }

  async handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "thinking": {
        await this.sink.record({
          stepType: AgentStepTypes.THINKING,
          content: event.content,
          durationMs: event.durationMs,
        })
        break
      }

      case "tool:start": {
        if (event.hidden) {
          this.hiddenToolCallIds.add(event.toolCallId)
          break
        }
        const step = await this.sink.open({ stepType: event.stepType })
        this.openByToolCallId.set(event.toolCallId, step)
        this.substepsByToolCallId.set(event.toolCallId, [])
        break
      }

      case "tool:progress": {
        const text = event.substep?.trim()
        if (!text) break
        const step = this.openByToolCallId.get(event.toolCallId)
        const log = this.substepsByToolCallId.get(event.toolCallId)
        // No open step — the tool was hidden (or never started); its phases
        // stay out of the user-facing trace like the rest of its lifecycle.
        if (!step || !log) break
        log.push({ text, at: new Date().toISOString() })
        await this.sink.substep({
          stepType: event.stepType,
          step,
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
        this.substepsByToolCallId.delete(event.toolCallId)
        this.hiddenToolCallIds.delete(event.toolCallId)
        if (!step) break // hidden tool — no step was opened
        await this.sink.complete(step, {
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
        this.openByToolCallId.delete(event.toolCallId)
        this.substepsByToolCallId.delete(event.toolCallId)
        if (step) {
          await this.sink.complete(step, {
            stepType: AgentStepTypes.TOOL_ERROR,
            content,
            durationMs: event.durationMs,
          })
        } else if (!this.hiddenToolCallIds.has(event.toolCallId)) {
          await this.sink.record({
            stepType: AgentStepTypes.TOOL_ERROR,
            content,
            durationMs: event.durationMs,
          })
        }
        this.hiddenToolCallIds.delete(event.toolCallId)
        break
      }

      case "message:sent": {
        await this.sink.record({
          stepType: AgentStepTypes.MESSAGE_SENT,
          content: event.content,
          messageId: event.messageId,
          sources: event.sources,
        })
        break
      }

      case "message:edited": {
        await this.sink.record({
          stepType: AgentStepTypes.MESSAGE_EDITED,
          content: event.content,
          messageId: event.messageId,
          sources: event.sources,
        })
        break
      }

      case "response:kept": {
        await this.sink.record({
          stepType: AgentStepTypes.RECONSIDERING,
          content: JSON.stringify({
            decision: AgentReconsiderationDecisions.KEPT_PREVIOUS_RESPONSE,
            reason: event.reason,
          }),
        })
        break
      }

      case "context:received": {
        await this.sink.record({
          stepType: AgentStepTypes.CONTEXT_RECEIVED,
          content: JSON.stringify({ messages: event.messages.map(toTraceMessage), ...event.extras }),
        })
        break
      }

      case "reconsidering": {
        await this.sink.record({
          stepType: AgentStepTypes.RECONSIDERING,
          content: JSON.stringify({
            draftResponse: event.draft,
            newMessages: event.newMessages.map(toTraceMessage),
          }),
        })
        break
      }

      // Lifecycle events produce no trace steps — listed explicitly (not
      // dropped through a default) so adding a new AgentEvent variant is a
      // compile error here instead of a silently unprojected event.
      case "session:start":
      case "session:end":
      case "session:error":
        break

      default: {
        const unhandled: never = event
        throw new Error(`Unhandled AgentEvent: ${JSON.stringify(unhandled)}`)
      }
    }
  }
}

function toTraceMessage(m: TraceContextMessage) {
  // changeType (mid-turn injections) and isTrigger (turn-start context) are
  // each absent on the other shape; JSON.stringify drops the undefined key.
  return {
    messageId: m.messageId,
    changeType: m.changeType,
    authorName: m.authorName,
    authorType: m.authorType,
    createdAt: m.createdAt,
    content: m.content.slice(0, 300),
    isTrigger: m.isTrigger,
  }
}
