import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import { MAX_FOLLOW_UP_HORIZON_DAYS } from "../config"
import type { FollowUpToolDeps } from "./tool-deps"

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
      "When to revisit, as an ISO 8601 timestamp (e.g. 2026-07-03T09:00:00Z). Must be in the future and no more than " +
        `${MAX_FOLLOW_UP_HORIZON_DAYS} days out.`
    ),
})

export type ScheduleFollowUpInput = z.infer<typeof ScheduleFollowUpSchema>

const HORIZON_MS = MAX_FOLLOW_UP_HORIZON_DAYS * 24 * 60 * 60 * 1000

const PROMPT_BLOCK = `## Scheduling follow-ups

Use \`schedule_follow_up\` when something genuinely needs revisiting later — "check tomorrow whether the deploy landed", "revisit this decision next week" — instead of trying to do long-horizon work in the current turn. It creates a durable reminder that wakes you up at the chosen time to take another look at this stream.

- \`note\` is written to your future self and is the only context that survives, so make it self-contained.
- \`scheduledFor\` must be in the future and within ${MAX_FOLLOW_UP_HORIZON_DAYS} days.
- There is a cap on how many follow-ups a stream can have pending at once; the tool result reports the current count and the limit, so don't stack up near-duplicates. Prefer one good follow-up over several.`

/**
 * Schedule a follow-up: a durable, cancellable reminder that wakes the running
 * persona later to revisit this stream. The identity (workspace/stream/persona/
 * session and the source-conversation anchor) is bound by the caller; the tool
 * supplies only the note and target time.
 *
 * This is the pathfinder durable-write tool — it creates persistent state, gated
 * only by the per-stream pending cap (surfaced in the result so the model
 * self-regulates), not by data-privacy categories.
 */
export function createScheduleFollowUpTool(deps: FollowUpToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.SCHEDULE_FOLLOW_UP,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.SCHEDULE_FOLLOW_UP],
    description: `Schedule a follow-up — a reminder that wakes you up at a chosen future time to take another look at this stream.

Use this instead of attempting long-horizon work in one turn: "check back tomorrow on X", "revisit next week". It produces a durable reminder. Pass a self-contained \`note\` (the only context that survives) and \`scheduledFor\` (ISO 8601, future, within ${MAX_FOLLOW_UP_HORIZON_DAYS} days). A per-stream cap limits how many can be pending; the result reports the count and limit.`,
    inputSchema: ScheduleFollowUpSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      const scheduledFor = new Date(input.scheduledFor)
      if (Number.isNaN(scheduledFor.getTime())) {
        return {
          output: JSON.stringify({
            ok: false,
            error: "Invalid scheduledFor — expected an ISO 8601 timestamp",
            scheduledFor: input.scheduledFor,
          }),
        }
      }

      const now = Date.now()
      if (scheduledFor.getTime() <= now) {
        return {
          output: JSON.stringify({ ok: false, error: "scheduledFor must be in the future" }),
        }
      }
      if (scheduledFor.getTime() > now + HORIZON_MS) {
        return {
          output: JSON.stringify({
            ok: false,
            error: `scheduledFor must be within ${MAX_FOLLOW_UP_HORIZON_DAYS} days`,
          }),
        }
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
    },
  })
}
