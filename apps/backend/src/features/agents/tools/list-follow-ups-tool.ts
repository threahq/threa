import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import { formatLocalTime } from "./follow-up-shared"
import type { ListFollowUpsToolDeps } from "./tool-deps"

const ListFollowUpsSchema = z.object({})

export type ListFollowUpsInput = z.infer<typeof ListFollowUpsSchema>

const PROMPT_BLOCK = `## Reviewing your follow-ups

Use \`list_follow_ups\` to see the follow-ups you currently have pending in this stream — each with its \`followUpId\`, its note, and when it fires. Call it before \`cancel_follow_up\` or \`update_follow_up\` so you're acting on a real id, and when you're unsure whether you've already scheduled something (don't schedule a near-duplicate). It returns only this stream's pending follow-ups; fired or cancelled ones aren't listed.`

/**
 * List the running stream's pending follow-ups so the persona can administer
 * them (cancel/reschedule) or avoid scheduling a duplicate. Stream/workspace
 * scope is bound by the caller, so this only ever returns follow-ups the persona
 * can act on here. Read-only.
 */
export function createListFollowUpsTool(deps: ListFollowUpsToolDeps, opts?: { timezone?: string }) {
  return defineAgentTool({
    name: AgentToolNames.LIST_FOLLOW_UPS,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LIST_FOLLOW_UPS],
    description:
      "List the follow-ups you currently have pending in this stream — their ids, notes, and scheduled times. Use it before cancelling or updating one, or to check what you've already scheduled.",
    inputSchema: ListFollowUpsSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (): Promise<AgentToolResult> => {
      try {
        const followUps = await deps.listFollowUps()
        return {
          output: JSON.stringify({
            ok: true,
            count: followUps.length,
            followUps: followUps.map((f) => ({
              followUpId: f.followUpId,
              note: f.note,
              scheduledFor: f.scheduledFor.toISOString(),
              scheduledForLocal: formatLocalTime(f.scheduledFor, opts?.timezone),
            })),
          }),
        }
      } catch (error) {
        logger.error({ error }, "list_follow_ups failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to list follow-ups" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: () => JSON.stringify({ tool: "list_follow_ups" }),
    },
  })
}
