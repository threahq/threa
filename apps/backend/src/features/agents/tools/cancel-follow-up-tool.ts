import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { CancelFollowUpToolDeps } from "./tool-deps"

const CancelFollowUpSchema = z.object({
  followUpId: z
    .string()
    .min(1)
    .describe("The id of the pending follow-up to cancel, as returned by `list_follow_ups` or `schedule_follow_up`."),
})

export type CancelFollowUpInput = z.infer<typeof CancelFollowUpSchema>

const PROMPT_BLOCK = `## Cancelling a follow-up

Use \`cancel_follow_up\` to drop a pending follow-up you no longer need — the thing you meant to revisit already resolved, or the plan changed. Pass the \`followUpId\` from \`list_follow_ups\`. Only pending follow-ups can be cancelled; one that already fired or was cancelled returns \`ok: false\` (re-list to see the current state). Cancelling is visible to the stream, so don't narrate it unless it's worth a word.`

/**
 * Cancel one of the running stream's pending follow-ups. Workspace/stream scope
 * is bound by the caller, so a turn can only cancel its own stream's follow-ups.
 * A non-pending / unknown / other-stream id collapses to `ok: false` — the model
 * should re-list rather than guess.
 */
export function createCancelFollowUpTool(deps: CancelFollowUpToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.CANCEL_FOLLOW_UP,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.CANCEL_FOLLOW_UP],
    description:
      "Cancel a pending follow-up you scheduled in this stream, by its id. Only works while the follow-up is still pending.",
    inputSchema: CancelFollowUpSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const result = await deps.cancelFollowUp({ followUpId: input.followUpId })
        if (!result.ok) {
          return {
            output: JSON.stringify({
              ok: false,
              error: "No pending follow-up with that id in this stream — it may have already fired or been cancelled.",
              followUpId: input.followUpId,
            }),
          }
        }
        return { output: JSON.stringify({ ok: true, followUpId: result.followUpId, status: "cancelled" }) }
      } catch (error) {
        logger.error({ error }, "cancel_follow_up failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to cancel follow-up" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: "cancel_follow_up", followUpId: input.followUpId }),
      effects: (_input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; followUpId?: string }
        if (!parsed.ok || !parsed.followUpId) return []
        return [{ kind: "follow_up", target: parsed.followUpId }]
      },
    },
  })
}
