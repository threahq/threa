import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { ReportBackToolDeps } from "./tool-deps"

const ReportBackSchema = z.object({
  summary: z
    .string()
    .refine((value) => value.trim().length > 0, "summary must contain non-whitespace content")
    .describe("Your closing answer (markdown). Posted as your message in this thread and shown on the card."),
})

export type ReportBackInput = z.infer<typeof ReportBackSchema>

const PROMPT_BLOCK = `## Closing out this delegation

You are running as a subagent: another model handed you this question and the user is talking to you in this thread.

- Keep working with the user here until the question is actually settled. Answer follow-ups normally with \`send_message\`.
- When you are done, call \`report_back\` once with your closing answer. That posts your summary and closes the run — the card in the parent stream flips to done and you will not be woken up in this thread again.
- Do not \`report_back\` on your first turn just to acknowledge the brief, and do not report back while a question you asked the user is still unanswered.`

/**
 * The subagent closing its own run. The summary is posted as an ordinary
 * message through the turn's message path first, so the closure and the answer
 * can never disagree; the CAS then settles the run. Bound only inside a
 * subagent thread — everywhere else the tool is never built.
 */
export function createReportBackTool(deps: ReportBackToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.REPORT_BACK,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.REPORT_BACK],
    description: `Post your closing answer in this thread and close this delegation. Call it once, when the question is settled — the card in the parent stream flips to done and you stop being woken up here.`,
    inputSchema: ReportBackSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const result = await deps.reportBack({ summary: input.summary })
        if (!result.ok) {
          return {
            output: JSON.stringify({
              ok: false,
              error:
                result.reason === "already_closed"
                  ? "Your summary was posted, but this delegation had already closed (cancelled or expired). Nothing more to do."
                  : "Failed to close the delegation",
            }),
          }
        }
        return {
          output: JSON.stringify({
            ok: true,
            subagentId: result.subagentId,
            note: "Delegation closed. Your summary is posted and the card shows it as done. End your turn.",
          }),
        }
      } catch (error) {
        logger.error({ error }, "report_back failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to close the delegation" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: () => JSON.stringify({ tool: "report_back" }),
      effects: (_input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; subagentId?: string }
        if (!parsed.ok || !parsed.subagentId) return []
        return [{ kind: "subagent", target: parsed.subagentId }]
      },
    },
  })
}
