import {
  TraceProjector,
  type TraceStepFinalize,
  type TraceStepRecord,
  type TraceStepSink,
  type TraceSubstepEntry,
} from "@threa/agent-runtime"
import type { AgentStepType } from "@threa/types"
import type { ActiveStep, SessionTrace } from "../trace-emitter"
import { logger } from "../../../lib/logger"

/**
 * The in-process companion's plaintext sink for the shared `TraceProjector`:
 * steps land via `SessionTrace` (DB persistence + session/stream socket rooms).
 * The event → step state machine itself lives in the projector — this class is
 * persistence and delivery only.
 */
export class SessionTraceStepSink implements TraceStepSink<ActiveStep> {
  constructor(private readonly trace: SessionTrace) {}

  async record(step: TraceStepRecord): Promise<void> {
    const active = await this.trace.startStep({ stepType: step.stepType, content: step.content })
    await active.complete({
      content: step.content,
      sources: step.sources,
      messageId: step.messageId,
      durationMs: step.durationMs,
    })
  }

  async open(params: { stepType: AgentStepType }): Promise<ActiveStep> {
    return this.trace.startStep({ stepType: params.stepType })
  }

  async complete(step: ActiveStep, final: TraceStepFinalize): Promise<void> {
    // final.stepType is wire framing for sinks that frame the finalize as its
    // own message — here the persisted row keeps the type it was opened with.
    await step.complete({
      content: final.content,
      sources: final.sources,
      messageId: final.messageId,
      durationMs: final.durationMs,
    })
  }

  async substep(params: {
    stepType: AgentStepType
    step: ActiveStep
    text: string
    snapshot: TraceSubstepEntry[]
    toolCallId: string
    toolName: string
  }): Promise<void> {
    // Ephemeral substep update for live clients (no DB write on its own).
    this.trace.emitSubstep({ stepType: params.stepType, substep: params.text })

    // Persisted substep log update — write the running snapshot to the step's
    // content so a refresh sees the phases collected so far. Fire-and-forget
    // because we don't want to block the event loop on a DB round-trip, and
    // the worst case on failure is the live socket path still works.
    void params.step.updateSubsteps(params.snapshot).catch((err) => {
      logger.warn({ err, toolCallId: params.toolCallId, toolName: params.toolName }, "Failed to persist substep update")
    })
  }
}

/** The companion's trace projector: the shared state machine over the plaintext sink. */
export function createSessionTraceProjector(trace: SessionTrace): TraceProjector<ActiveStep> {
  return new TraceProjector(new SessionTraceStepSink(trace))
}
