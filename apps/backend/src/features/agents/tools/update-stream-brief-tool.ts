import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, STREAM_BRIEF_MAX_CHARS } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { UpdateStreamBriefToolDeps } from "./tool-deps"

const UpdateStreamBriefSchema = z.object({
  content: z
    .string()
    .max(STREAM_BRIEF_MAX_CHARS)
    .describe(
      "The complete new brief in markdown — a full replacement, not a patch, so include everything that should remain plus your change. Keep it tight (durable facts: goals, decisions, preferences, conventions); it is capped at " +
        `${STREAM_BRIEF_MAX_CHARS} characters.`
    ),
  reason: z
    .string()
    .min(1)
    .max(280)
    .describe(
      "A short note on what changed and why, shown on the timeline row members see (e.g. 'recorded the decision to ship weekly'). One sentence."
    ),
})

export type UpdateStreamBriefInput = z.infer<typeof UpdateStreamBriefSchema>

const PROMPT_BLOCK = `## Maintaining the stream brief

The stream brief is the durable working document for this stream — standing context (goals, decisions, preferences, conventions) that shapes every turn here. Use \`update_stream_brief\` to keep it current when a durable fact changes, e.g. "actually, we decided to ship weekly" or a stated preference you should remember.

- It is a **full replacement**: pass the complete brief you want to stand, including the parts you're keeping. **Prefer editing the existing brief over appending** — restate it with your change folded in, don't tack paragraphs on the end.
- Record only durable facts. Not chit-chat, not transient status, and **never secrets** (tokens, passwords, private keys) — the brief is visible to every stream member.
- \`reason\` is a one-line note shown on the timeline row members see, so make it describe the change.
- A concurrent human edit can move the brief between your read and your write; the tool tells you when that happens and hands you the current content — reconcile and call again if your change still applies.`

/**
 * Maintain the stream's durable brief (roadmap 4.2). Full-replacement write
 * through the 4.1 `StreamBriefService`, attributed to the running persona and
 * appended as a visible `brief_updated` timeline row (INV-62 spirit — brief
 * changes are never silent).
 *
 * Optimistic concurrency: the tool writes against the version the turn read at
 * context time (`opts.currentVersion`), advancing its own `knownVersion` after
 * each write so a follow-up write in the same turn targets the fresh version. A
 * concurrent human edit yields a `version_conflict` carrying the current
 * content; the tool surfaces that to the model (with the fresh version already
 * armed) so it can reconcile and retry once rather than blindly clobbering an
 * edit it never saw.
 */
export function createUpdateStreamBriefTool(deps: UpdateStreamBriefToolDeps, opts: { currentVersion: number }) {
  let knownVersion = opts.currentVersion
  return defineAgentTool({
    name: AgentToolNames.UPDATE_STREAM_BRIEF,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.UPDATE_STREAM_BRIEF],
    description: `Update this stream's durable brief — the standing working document (goals, decisions, preferences, conventions) that shapes every turn here. Pass the complete replacement \`content\` (markdown, full replacement not a patch, ≤${STREAM_BRIEF_MAX_CHARS} chars) and a one-line \`reason\`. The change is visible to all stream members. Use it when a durable fact changes; prefer editing over appending, and never store secrets.`,
    inputSchema: UpdateStreamBriefSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const result = await deps.updateBrief({
          content: input.content,
          reason: input.reason,
          expectedVersion: knownVersion,
        })
        if (!result.ok) {
          // Arm the fresh version so an immediate retry writes on top of the
          // human edit instead of re-conflicting on the stale version.
          knownVersion = result.currentVersion
          return {
            output: JSON.stringify({
              ok: false,
              error:
                "The brief was edited by someone else since you read it. Review their current version below and, if your change still applies, call update_stream_brief again to re-apply it on top.",
              currentVersion: result.currentVersion,
              currentContent: result.currentContent,
            }),
          }
        }
        knownVersion = result.version
        return { output: JSON.stringify({ ok: true, version: result.version }) }
      } catch (error) {
        logger.error({ error }, "update_stream_brief failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to update the brief" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: "update_stream_brief", reason: input.reason }),
      // Target-less: the write lands on the stream the trace is already in.
      // `before` is the version written against — the repo advances the brief by
      // exactly one per accepted write (`version = version + 1`, creation at 1
      // from an expected 0), so it is derivable from the result alone.
      effects: (_input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; version?: number }
        if (!parsed.ok || parsed.version === undefined) return []
        return [{ kind: "brief", before: String(parsed.version - 1), after: String(parsed.version) }]
      },
    },
  })
}
