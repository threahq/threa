import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import { MAX_FOLLOW_UP_HORIZON_DAYS } from "../config"
import { formatLocalTime, validateScheduledFor } from "./follow-up-shared"
import type { UpdateFollowUpToolDeps } from "./tool-deps"

const UpdateFollowUpSchema = z
  .object({
    followUpId: z
      .string()
      .min(1)
      .describe("The id of the pending follow-up to update, as returned by `list_follow_ups` or `schedule_follow_up`."),
    note: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe("New note (replaces the old one). Omit to keep the current note. Make it self-contained."),
    scheduledFor: z
      .string()
      .optional()
      .describe(
        "New time to fire, as an ISO 8601 timestamp with offset (or Z for UTC). Omit to keep the current time. Must be in the future and within " +
          `${MAX_FOLLOW_UP_HORIZON_DAYS} days.`
      ),
  })
  .refine((v) => v.note !== undefined || v.scheduledFor !== undefined, {
    message: "Provide at least one of `note` or `scheduledFor` to update.",
  })

export type UpdateFollowUpInput = z.infer<typeof UpdateFollowUpSchema>

const PROMPT_BLOCK = `## Updating a follow-up

Use \`update_follow_up\` to change a pending follow-up's note, its fire time, or both — "push that check to next week", "also look at the rollback when I revisit". Pass the \`followUpId\` from \`list_follow_ups\` plus whichever of \`note\`/\`scheduledFor\` you're changing (at least one). \`note\` fully replaces the old note; \`scheduledFor\` must be in the future and within ${MAX_FOLLOW_UP_HORIZON_DAYS} days, grounded on "## Current Time". Only pending follow-ups can be updated. Prefer updating an existing follow-up over cancelling and re-scheduling.`

/**
 * Update a pending follow-up's note and/or time. Workspace/stream scope is bound
 * by the caller (a turn only touches its own stream's follow-ups). `scheduledFor`
 * is validated against the same future/horizon rules as scheduling, grounded on
 * the injected `currentTime` so evals are deterministic. A non-pending / unknown
 * / other-stream id returns a specific error so the model can react.
 */
export function createUpdateFollowUpTool(
  deps: UpdateFollowUpToolDeps,
  opts?: { timezone?: string; currentTime?: string }
) {
  const parsedNow = opts?.currentTime ? Date.parse(opts.currentTime) : NaN
  if (opts?.currentTime && Number.isNaN(parsedNow)) {
    logger.warn({ currentTime: opts.currentTime }, "update_follow_up: unparseable currentTime; using wall-clock")
  }
  const nowMs = Number.isNaN(parsedNow) ? undefined : parsedNow
  return defineAgentTool({
    name: AgentToolNames.UPDATE_FOLLOW_UP,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.UPDATE_FOLLOW_UP],
    description: `Update a pending follow-up you scheduled in this stream — change its note, its fire time, or both. Pass the followUpId and at least one of note/scheduledFor. Only works while the follow-up is still pending.`,
    inputSchema: UpdateFollowUpSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      let scheduledFor: Date | undefined
      if (input.scheduledFor !== undefined) {
        scheduledFor = new Date(input.scheduledFor)
        const validationError = validateScheduledFor(scheduledFor, nowMs ?? Date.now())
        if (validationError) {
          return { output: JSON.stringify({ ok: false, error: validationError }) }
        }
      }

      try {
        const result = await deps.updateFollowUp({ followUpId: input.followUpId, note: input.note, scheduledFor })
        if (!result.ok) {
          const error =
            result.reason === "not_found"
              ? "No follow-up with that id in this stream."
              : "That follow-up is no longer pending (already fired or cancelled), so it can't be updated."
          return { output: JSON.stringify({ ok: false, error, followUpId: input.followUpId }) }
        }
        return {
          output: JSON.stringify({
            ok: true,
            followUpId: result.followUpId,
            note: result.note,
            scheduledFor: result.scheduledFor.toISOString(),
            scheduledForLocal: formatLocalTime(result.scheduledFor, opts?.timezone),
          }),
        }
      } catch (error) {
        logger.error({ error }, "update_follow_up failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to update follow-up" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({
          tool: "update_follow_up",
          followUpId: input.followUpId,
          note: input.note,
          scheduledFor: input.scheduledFor,
        }),
      // No `before`: the callback returns the stored row after the write and
      // nothing from before it, so only the new time is declarable.
      effects: (input, result) => {
        const parsed = JSON.parse(result.output) as {
          ok: boolean
          followUpId?: string
          note?: string
          scheduledForLocal?: string
        }
        if (!parsed.ok || !parsed.followUpId) return []
        return [
          {
            kind: "follow_up",
            label: parsed.note,
            target: parsed.followUpId,
            ...(input.scheduledFor !== undefined ? { after: parsed.scheduledForLocal } : {}),
          },
        ]
      },
    },
  })
}
