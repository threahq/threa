import { z } from "zod"
import {
  AgentStepTypes,
  AgentToolNames,
  KNOWLEDGE_TYPES,
  MemoScopes,
  MEMO_ABSTRACT_MAX_CHARS,
  MEMO_KEY_POINTS_MAX,
  MEMO_TAGS_MAX,
  MEMO_TITLE_MAX_CHARS,
  TOOL_CATEGORIES_BY_NAME,
} from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { SaveMemoToolDeps } from "./tool-deps"

const SaveMemoSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(MEMO_TITLE_MAX_CHARS)
    .describe(
      "A specific title naming the one thing to remember (e.g. 'Deploys only on Fridays after the smoke suite')."
    ),
  abstract: z
    .string()
    .min(1)
    .max(MEMO_ABSTRACT_MAX_CHARS)
    .describe(
      "The knowledge itself, terse and self-contained — a few sentences at most stating the fact/decision/procedure directly, not a recap of the discussion."
    ),
  knowledgeType: z
    .enum(KNOWLEDGE_TYPES)
    .describe(`What kind of knowledge this is: ${KNOWLEDGE_TYPES.map((t) => `"${t}"`).join(" | ")}.`),
  keyPoints: z
    .array(z.string().min(1))
    .max(MEMO_KEY_POINTS_MAX)
    .default([])
    .describe("Optional supporting facts; leave empty when the abstract already stands alone."),
  tags: z.array(z.string().min(1)).max(MEMO_TAGS_MAX).default([]).describe("Optional short tags for categorization."),
  sourceMessageIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "The ids of the messages this knowledge comes from (at least one). Use ids from the conversation/context — they anchor the memo to its source."
    ),
  scope: z
    .enum([MemoScopes.USER, MemoScopes.WORKSPACE])
    .optional()
    .describe(
      'Visibility: "user" files it privately for the person you\'re helping (their "about you" tier — personal facts, preferences), "workspace" shares it. Omit to match where you are — a private scratchpad saves privately, a channel saves shared.'
    ),
})

export type SaveMemoInput = z.infer<typeof SaveMemoSchema>

const PROMPT_BLOCK = `## Saving to memory

Use \`save_memo\` to explicitly remember a durable fact, decision, procedure, or learning when the user asks you to ("remember that…", "note that…") or when something clearly worth keeping was just established and you don't want to rely on passive capture.

- Write the \`abstract\` as the knowledge itself — terse and self-contained ("We deploy on Fridays only after the smoke suite passes"), not a summary of the chat.
- Pass \`sourceMessageIds\` for the messages the knowledge came from (at least one) so the memo points back at its source.
- Pick the tightest \`knowledgeType\`; don't reach for "context" as a catch-all.
- One memo per distinct thing. Save separately if two unrelated facts came up.
- If the same knowledge is already captured, the tool tells you (\`deduped: true\`) and returns the existing memo instead of creating a duplicate — don't re-save it.
- The save is visible in the stream's timeline, so there's no need to also announce it at length.`

/**
 * `save_memo`: an explicit "remember this" that writes a persona-authored memo
 * through `MemoService.saveMemo` (roadmap 6.2) — the same dedup + embedding +
 * capture-event pipeline the passive extractor uses (INV-35). The workspace /
 * stream / session identity is bound by the caller; the tool supplies only the
 * memo content and its source-message anchors.
 */
export function createSaveMemoTool(deps: SaveMemoToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.SAVE_MEMO,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.SAVE_MEMO],
    promptBlock: PROMPT_BLOCK,
    description: `Save a durable fact, decision, procedure, or learning to workspace memory so it can be recalled later.

Use when the user asks you to remember something, or when something clearly worth keeping was just established. Write \`abstract\` as the knowledge itself (terse, self-contained), pass \`sourceMessageIds\` for where it came from, and pick the tightest \`knowledgeType\`. If the knowledge is already captured the tool returns the existing memo (\`deduped: true\`) instead of duplicating it.`,
    inputSchema: SaveMemoSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const result = await deps.saveMemo({
          title: input.title,
          abstract: input.abstract,
          keyPoints: input.keyPoints,
          tags: input.tags,
          knowledgeType: input.knowledgeType,
          sourceMessageIds: input.sourceMessageIds,
          scope: input.scope,
        })
        if (!result.ok) {
          return { output: JSON.stringify({ ok: false, error: "Failed to save memo" }) }
        }
        return {
          output: JSON.stringify({
            ok: true,
            memoId: result.memoId,
            title: result.title,
            deduped: result.deduped,
            scope: result.scope,
            ...(result.deduped
              ? { note: "This knowledge was already captured in this stream; returned the existing memo." }
              : {}),
            ...(input.scope && input.scope !== result.scope
              ? { note: `Saved at ${result.scope} scope: this stream's content never lands ${input.scope}-wide.` }
              : {}),
          }),
        }
      } catch (error) {
        logger.error({ error }, "save_memo failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to save memo" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({ tool: AgentToolNames.SAVE_MEMO, title: input.title, knowledgeType: input.knowledgeType }),
      // A deduped save wrote nothing — it returned the memo that was already
      // there — so it declares no effect rather than claiming a capture.
      effects: (_input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; memoId?: string; title?: string; deduped?: boolean }
        if (!parsed.ok || parsed.deduped || !parsed.memoId) return []
        return [{ kind: "memo", label: parsed.title, target: parsed.memoId }]
      },
    },
  })
}
