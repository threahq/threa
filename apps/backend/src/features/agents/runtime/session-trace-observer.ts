import { AgentReconsiderationDecisions, AgentStepTypes } from "@threa/types"
import type { ActiveStep, SessionTrace } from "../trace-emitter"
import { logger } from "../../../lib/logger"
import type { AgentEvent, AgentObserver } from "@threa/agent-runtime"

/**
 * Maps agent runtime events to SessionTrace calls (DB + socket).
 * This is the user-facing trace that appears in the UI.
 *
 * Tool lifecycle vs. persistence:
 * - `tool:start` creates the persisted step row immediately so a refresh
 *   mid-execution sees the in-progress step instead of a gap. The ActiveStep
 *   handle is cached by toolCallId. Hidden tools (trace.hidden) skip this
 *   entirely — they appear in Langfuse but not in the user-facing trace.
 * - `tool:progress` persists a running `{ substeps }` JSON to the step's
 *   content field (so a refresh recovers the phases collected so far) AND
 *   emits the ephemeral substep socket event for clients already watching.
 *   Skipped when no cached step exists (hidden tool).
 * - `tool:complete` finalises the cached step with the tool's full result
 *   content (which overwrites the intermediate substep-only content).
 * - `tool:error` finalises the cached step with the error message. When no
 *   cached step exists (e.g. unknown tool name — the runtime emits
 *   tool:error without a preceding tool:start), a synthetic TOOL_ERROR
 *   step is created so the error is visible in the trace.
 */
export class SessionTraceObserver implements AgentObserver {
  private readonly stepsByToolCallId = new Map<string, ActiveStep>()
  /**
   * Accumulated substep log per in-flight tool call. Parallel to
   * `stepsByToolCallId` so the observer can persist the full running list on
   * every `tool:progress` event without needing each event to carry the full
   * history.
   */
  private readonly substepsByToolCallId = new Map<string, Array<{ text: string; at: string }>>()
  /** Tool calls that were hidden at tool:start. Used by tool:error to distinguish
   *  "hidden tool, skip" from "unknown tool, show synthetic error step". */
  private readonly hiddenToolCallIds = new Set<string>()

  constructor(private readonly trace: SessionTrace) {}

  async handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "thinking": {
        const step = await this.trace.startStep({
          stepType: AgentStepTypes.THINKING,
          content: event.content,
        })
        await step.complete({ durationMs: event.durationMs })
        break
      }

      case "tool:start": {
        // Hidden tools (e.g. individual workspace search helpers) are recorded in
        // Langfuse but not in the user-facing trace. Skip step creation so they
        // don't clutter the trace dialog.
        if (event.hidden) {
          this.hiddenToolCallIds.add(event.toolCallId)
          break
        }

        // Create the persisted step row at tool start so mid-execution refresh
        // recovers the in-progress step. Cached by toolCallId so later progress
        // and completion events can reference the same row.
        const step = await this.trace.startStep({ stepType: event.stepType })
        this.stepsByToolCallId.set(event.toolCallId, step)
        this.substepsByToolCallId.set(event.toolCallId, [])
        break
      }

      case "tool:progress": {
        // Skip if no step was created (hidden tool).
        if (!this.stepsByToolCallId.has(event.toolCallId)) break

        // Ephemeral substep update for live clients (no DB write on its own).
        this.trace.emitSubstep({ stepType: event.stepType, substep: event.substep })

        // Persisted substep log update — append to the cached list and write
        // the running array to step.content so a refresh sees the phases
        // collected so far. Fire-and-forget because we don't want to block the
        // event loop on a DB round-trip, and the worst case on failure is the
        // live socket path still works.
        const substeps = this.substepsByToolCallId.get(event.toolCallId)
        const step = this.stepsByToolCallId.get(event.toolCallId)
        if (substeps && step) {
          substeps.push({ text: event.substep, at: new Date().toISOString() })
          const snapshot = [...substeps]
          void step.updateSubsteps(snapshot).catch((err) => {
            logger.warn(
              { err, toolCallId: event.toolCallId, toolName: event.toolName },
              "Failed to persist substep update"
            )
          })
        }
        break
      }

      case "tool:complete": {
        // Prefer finalising the cached step (created at tool:start) so the
        // step row keeps its original started_at and the content is updated
        // in place. If no cached step exists, the tool was hidden — skip
        // creating a user-facing step entirely (OTEL still records it).
        const cached = this.stepsByToolCallId.get(event.toolCallId)
        if (cached) {
          await cached.complete({
            content: event.trace.content,
            sources: event.trace.sources,
            durationMs: event.durationMs,
          })
          this.stepsByToolCallId.delete(event.toolCallId)
          this.substepsByToolCallId.delete(event.toolCallId)
        }
        this.hiddenToolCallIds.delete(event.toolCallId)
        break
      }

      case "tool:error": {
        // Finalise the cached step with error content when it exists.
        // When no cached step exists AND the tool wasn't hidden, this is
        // the unknown-tool path (the runtime emits tool:error without a
        // preceding tool:start). Create a synthetic TOOL_ERROR step so the
        // error is visible in the trace.
        const cached = this.stepsByToolCallId.get(event.toolCallId)
        if (cached) {
          await cached.complete({
            content: `${event.toolName} failed: ${event.error}`,
            durationMs: event.durationMs,
          })
          this.stepsByToolCallId.delete(event.toolCallId)
          this.substepsByToolCallId.delete(event.toolCallId)
        } else if (!this.hiddenToolCallIds.has(event.toolCallId)) {
          const step = await this.trace.startStep({
            stepType: AgentStepTypes.TOOL_ERROR,
            content: `${event.toolName} failed: ${event.error}`,
          })
          await step.complete({ durationMs: event.durationMs })
        }
        this.hiddenToolCallIds.delete(event.toolCallId)
        break
      }

      case "message:sent": {
        const step = await this.trace.startStep({
          stepType: AgentStepTypes.MESSAGE_SENT,
          content: event.content,
        })
        await step.complete({
          content: event.content,
          messageId: event.messageId,
          sources: event.sources,
        })
        break
      }

      case "message:edited": {
        const step = await this.trace.startStep({
          stepType: AgentStepTypes.MESSAGE_EDITED,
          content: event.content,
        })
        await step.complete({
          content: event.content,
          messageId: event.messageId,
          sources: event.sources,
        })
        break
      }

      case "response:kept": {
        const step = await this.trace.startStep({
          stepType: AgentStepTypes.RECONSIDERING,
          content: JSON.stringify({
            decision: AgentReconsiderationDecisions.KEPT_PREVIOUS_RESPONSE,
            reason: event.reason,
          }),
        })
        await step.complete({})
        break
      }

      case "context:received": {
        const step = await this.trace.startStep({
          stepType: AgentStepTypes.CONTEXT_RECEIVED,
          content: JSON.stringify({
            messages: event.messages.map((m) => ({
              messageId: m.messageId,
              changeType: m.changeType,
              authorName: m.authorName,
              authorType: m.authorType,
              createdAt: m.createdAt,
              content: m.content.slice(0, 300),
            })),
          }),
        })
        await step.complete({})
        break
      }

      case "reconsidering": {
        const step = await this.trace.startStep({
          stepType: AgentStepTypes.RECONSIDERING,
          content: JSON.stringify({
            draftResponse: event.draft,
            newMessages: event.newMessages.map((m) => ({
              messageId: m.messageId,
              changeType: m.changeType,
              authorName: m.authorName,
              authorType: m.authorType,
              createdAt: m.createdAt,
              content: m.content.slice(0, 300),
            })),
          }),
        })
        await step.complete({})
        break
      }
    }
  }
}
