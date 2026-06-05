import type { ActiveStep, SessionTrace } from "../trace-emitter"
import { logger } from "../../../lib/logger"
import { TraceMapper, type TraceStepHandle, type TraceStepSink } from "@threa/agent-runtime"
import type { AgentEvent, AgentObserver } from "@threa/agent-runtime"

/**
 * Maps agent runtime events to SessionTrace calls (DB + socket).
 * This is the user-facing trace that appears in the UI.
 *
 * The event→step lifecycle lives in the shared `TraceMapper` (one state
 * machine for every host — the enclave's sealing observer runs the same one);
 * this file only supplies the sink: where an opened step goes.
 *
 * Sink semantics:
 * - `openStep` creates the persisted step row immediately so a refresh
 *   mid-execution sees the in-progress step instead of a gap.
 * - `substep` persists a running `{ substeps }` JSON to the step's content
 *   field (so a refresh recovers the phases collected so far) AND emits the
 *   ephemeral substep socket event for clients already watching. The persist
 *   is fire-and-forget: we don't block the event loop on a DB round-trip, and
 *   the worst case on failure is the live socket path still works.
 * - `finalize` completes the step row in place (the tool's full result content
 *   overwrites the intermediate substep-only content).
 * - Detached substeps (hidden tools) are dropped: the backend trace renders
 *   only step-anchored substeps, and hidden tools have no step (OTEL still
 *   records them).
 */
export class SessionTraceObserver implements AgentObserver {
  private readonly mapper: TraceMapper

  constructor(trace: SessionTrace) {
    this.mapper = new TraceMapper(new SessionTraceStepSink(trace))
  }

  async handle(event: AgentEvent): Promise<void> {
    await this.mapper.handle(event)
  }
}

class SessionTraceStepSink implements TraceStepSink {
  constructor(private readonly trace: SessionTrace) {}

  async openStep(op: Parameters<TraceStepSink["openStep"]>[0]): Promise<TraceStepHandle> {
    const step: ActiveStep = await this.trace.startStep(
      op.content !== undefined ? { stepType: op.stepType, content: op.content } : { stepType: op.stepType }
    )
    return {
      substep: ({ stepType, text, snapshot, toolCallId, toolName }) => {
        // Ephemeral substep update for live clients (no DB write on its own).
        this.trace.emitSubstep({ stepType, substep: text })
        // Persisted substep log — fire-and-forget (see class comment).
        void step.updateSubsteps(snapshot).catch((err) => {
          logger.warn({ err, toolCallId, toolName }, "Failed to persist substep update")
        })
      },
      finalize: async (fin) => {
        await step.complete({
          content: fin.content,
          sources: fin.sources,
          messageId: fin.messageId,
          durationMs: fin.durationMs,
        })
      },
    }
  }

  emitDetachedSubstep(): void {
    // Hidden tools' phase text never surfaces in the backend trace — there is
    // no step row to anchor it to (OTEL records the tool call instead).
  }
}
