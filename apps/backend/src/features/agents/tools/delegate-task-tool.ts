import { z } from "zod"
import {
  AgentStepTypes,
  AgentToolNames,
  DELEGATION_BRIEF_MAX_CHARS,
  DELEGATION_CONTEXT_REFS_MAX,
  DELEGATION_TITLE_MAX_CHARS,
  TOOL_CATEGORIES_BY_NAME,
} from "@threahq/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { DelegateTaskToolDeps } from "./tool-deps"

const DelegateTaskSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(DELEGATION_TITLE_MAX_CHARS)
    .describe("Short imperative summary of the task, e.g. 'Add rate limiting to the webhook endpoint'."),
  brief: z
    .string()
    .min(1)
    .max(DELEGATION_BRIEF_MAX_CHARS)
    .describe(
      "The complete hand-off prompt (markdown). Must be self-contained: assume the executor has repo/filesystem access but ZERO Threa context. State the goal, the relevant background, concrete acceptance criteria, and any constraints. Reference workspace sources via contextRefs pointer URLs instead of pasting walls of text."
    ),
  contextRefs: z
    .array(z.string())
    .max(DELEGATION_CONTEXT_REFS_MAX)
    .default([])
    .describe(
      "Pointer URLs into the workspace backing the brief: `shared-message:streamId/messageId`, `memo:memoId`, `attachment:attachmentId`. Use the ids from pointer tags in your context. Each ref is access-checked against the requesting user; inaccessible or invented refs are dropped and reported back."
    ),
})

export type DelegateTaskInput = z.infer<typeof DelegateTaskSchema>

const PROMPT_BLOCK = `## Delegating tasks

Use \`delegate_task\` when the user describes work that is long-horizon, code-heavy, or local-filesystem-shaped — implementing a feature, fixing a bug in their repo, running a migration, batch-editing files. Do NOT attempt such work in this session: sessions are minutes-bounded; anything longer is a delegation to the user's own local agent (which has their repo, their tools, and their credentials).

- The \`brief\` is everything the executor gets. Write it self-contained: the executor has repo access but no Threa context. Include the goal, the background it needs, and explicit acceptance criteria ("done when …").
- Link sources with \`contextRefs\` pointer URLs (\`shared-message:\`, \`memo:\`, \`attachment:\`) rather than inlining long quotes — the hand-off carries the pointers.
- The delegation appears as a card in this stream that anyone can see, cancel, mark done, or copy as a ready-to-paste prompt; a local agent can also claim it programmatically. Report to the user that you've prepared the hand-off — don't promise to do the work yourself.
- Set expectations honestly: the card does not run by itself. Tell the user it waits for someone with a local coding agent (or a Threa API key) to pick it up, and that they can mark it done from the card if the work happens outside the API.
- Offer delegation when it fits; don't delegate trivia the user just wants answered in chat.`

/**
 * Compile a hand-off into a durable, lifecycle-tracked delegation (roadmap
 * 5.1). This is the half of the job where Threa has the better context — the
 * turn assembles the brief from workspace knowledge; the user's local agent
 * executes it. Identity, the source-conversation anchor, and the invoking
 * user's access reach are bound by the caller; the tool supplies only content.
 */
export function createDelegateTaskTool(deps: DelegateTaskToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.DELEGATE_TASK,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.DELEGATE_TASK],
    description: `Hand off a task to the user's local agent as a durable delegation card in this stream.

Use for work that is long-horizon, code-heavy, or needs the user's machine — never attempt such work in-session. Pass a short \`title\`, a self-contained \`brief\` (markdown, with acceptance criteria; executor has no Threa context), and \`contextRefs\` pointer URLs backing it. The card is visible to every member and claimable by the user's local agent.`,
    inputSchema: DelegateTaskSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const result = await deps.delegateTask({
          title: input.title,
          brief: input.brief,
          contextRefs: input.contextRefs ?? [],
        })
        if (!result.ok) {
          return { output: JSON.stringify({ ok: false, error: result.error }) }
        }
        return {
          output: JSON.stringify({
            ok: true,
            delegationId: result.delegationId,
            droppedRefs: result.droppedRefs,
            note:
              result.droppedRefs.length > 0
                ? "Some context refs were dropped (inaccessible to the requesting user or unresolvable) — the delegation was created without them."
                : "Delegation card posted to this stream; the user's local agent can claim it, or anyone can copy the prompt.",
          }),
        }
      } catch (error) {
        logger.error({ error }, "delegate_task failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to create delegation" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({ tool: "delegate_task", title: input.title, contextRefs: input.contextRefs ?? [] }),
      effects: (input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; delegationId?: string }
        if (!parsed.ok || !parsed.delegationId) return []
        return [{ kind: "delegation", label: input.title, target: parsed.delegationId }]
      },
    },
  })
}
