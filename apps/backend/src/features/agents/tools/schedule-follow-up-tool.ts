import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import { MAX_FOLLOW_UP_HORIZON_DAYS } from "../config"
import { formatLocalTime, validateScheduledFor } from "./follow-up-shared"
import type { ScheduleFollowUpToolDeps } from "./tool-deps"

const ScheduleFollowUpSchema = z.object({
  note: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "What you intend to do or check when you revisit — written to yourself, e.g. 'follow up on whether the deploy went out' or 'check if Kris decided on the pricing tiers'. This is the only context the follow-up carries, so make it self-contained."
    ),
  scheduledFor: z
    .string()
    .describe(
      "When to revisit, as an ISO 8601 timestamp resolved to an absolute instant — include the offset (e.g. 2026-07-03T09:00:00+02:00) or use Z for UTC. Ground it on the current time in the '## Current Time' section. Must be in the future and no more than " +
        `${MAX_FOLLOW_UP_HORIZON_DAYS} days out.`
    ),
})

export type ScheduleFollowUpInput = z.infer<typeof ScheduleFollowUpSchema>

const PROMPT_BLOCK = `## Scheduling follow-ups

Use \`schedule_follow_up\` when something genuinely needs revisiting later — "check tomorrow whether the deploy landed", "revisit this decision next week" — instead of trying to do long-horizon work in the current turn. It creates a durable reminder that wakes you up at the chosen time to take another look at this stream.

- \`note\` is written to your future self and is the only context that survives, so make it self-contained.
- \`scheduledFor\` must be in the future and within ${MAX_FOLLOW_UP_HORIZON_DAYS} days. Compute it against the current time shown in "## Current Time" (the user's local time).
- When you tell the user when you'll check back, use the \`scheduledForLocal\` field from the tool result — it is already rendered in the user's timezone. Never quote the raw UTC time to the user.
- There is a cap on how many follow-ups a stream can have pending at once; the tool result reports the current count and the limit, so don't stack up near-duplicates. Prefer one good follow-up over several.`

/**
 * Schedule a follow-up: a durable, cancellable reminder that wakes the running
 * persona later to revisit this stream. The identity (workspace/stream/persona/
 * session and the source-conversation anchor) is bound by the caller; the tool
 * supplies only the note and target time.
 *
 * `timezone`/`currentTime` come from the turn's temporal context: the result
 * echoes the scheduled time in the user's zone (so the model doesn't quote UTC),
 * and validation grounds "future/within-horizon" on the injected time so evals
 * are deterministic (falls back to wall-clock when unset).
 *
 * This is the pathfinder durable-write tool — it creates persistent state, gated
 * only by the per-stream pending cap (surfaced in the result so the model
 * self-regulates), not by data-privacy categories.
 */
export function createScheduleFollowUpTool(
  deps: ScheduleFollowUpToolDeps,
  opts?: { timezone?: string; currentTime?: string }
) {
  const parsedNow = opts?.currentTime ? Date.parse(opts.currentTime) : NaN
  if (opts?.currentTime && Number.isNaN(parsedNow)) {
    // Loud on malformed injected time (INV-11): we still fall back to wall-clock
    // so scheduling keeps working, but a bad temporal.currentTime shouldn't
    // silently defeat deterministic validation in evals.
    logger.warn({ currentTime: opts.currentTime }, "schedule_follow_up: unparseable currentTime; using wall-clock")
  }
  const nowMs = Number.isNaN(parsedNow) ? undefined : parsedNow
  return defineAgentTool({
    name: AgentToolNames.SCHEDULE_FOLLOW_UP,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.SCHEDULE_FOLLOW_UP],
    description: `Schedule a follow-up — a reminder that wakes you up at a chosen future time to take another look at this stream.

Use this instead of attempting long-horizon work in one turn: "check back tomorrow on X", "revisit next week". It produces a durable reminder. Pass a self-contained \`note\` (the only context that survives) and \`scheduledFor\` (ISO 8601, future, within ${MAX_FOLLOW_UP_HORIZON_DAYS} days). A per-stream cap limits how many can be pending; the result reports the count and limit.`,
    inputSchema: ScheduleFollowUpSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      const scheduledFor = new Date(input.scheduledFor)
      const validationError = validateScheduledFor(scheduledFor, nowMs ?? Date.now())
      if (validationError) {
        return { output: JSON.stringify({ ok: false, error: validationError }) }
      }

      try {
        const result = await deps.scheduleFollowUp({ note: input.note, scheduledFor })
        if (!result.ok) {
          return {
            output: JSON.stringify({
              ok: false,
              error: "Pending follow-up limit reached for this stream — cancel one or wait before scheduling more",
              pendingCount: result.pendingCount,
              limit: result.limit,
            }),
          }
        }
        return {
          output: JSON.stringify({
            ok: true,
            followUpId: result.followUpId,
            scheduledFor: result.scheduledFor.toISOString(),
            scheduledForLocal: formatLocalTime(result.scheduledFor, opts?.timezone),
            pendingCount: result.pendingCount,
            limit: result.limit,
          }),
        }
      } catch (error) {
        logger.error({ error }, "schedule_follow_up failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to schedule follow-up" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({ tool: "schedule_follow_up", note: input.note, scheduledFor: input.scheduledFor }),
      effects: (input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; followUpId?: string }
        if (!parsed.ok || !parsed.followUpId) return []
        return [{ kind: "follow_up", label: input.note, target: parsed.followUpId }]
      },
    },
  })
}
