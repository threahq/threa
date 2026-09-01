import { z } from "zod"
import {
  AgentStepTypes,
  AgentToolNames,
  SUBAGENT_BRIEF_MAX_CHARS,
  SUBAGENT_TITLE_MAX_CHARS,
  TOOL_CATEGORIES_BY_NAME,
} from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { StartSubagentToolDeps } from "./tool-deps"

const StartSubagentSchema = z.object({
  model: z.string().min(1).describe("Model id for the subagent, exactly as listed in this tool's description."),
  title: z
    .string()
    .min(1)
    .max(SUBAGENT_TITLE_MAX_CHARS)
    .describe("Short label for the card in this stream, e.g. 'Second opinion on the migration plan'."),
  brief: z
    .string()
    .min(1)
    .max(SUBAGENT_BRIEF_MAX_CHARS)
    .describe(
      "The complete brief (markdown) for the delegated model. It has the same workspace tools you do but has NOT read this conversation: state the question, the background it needs, what the user already tried or ruled out, and what a good answer looks like."
    ),
})

export type StartSubagentInput = z.infer<typeof StartSubagentSchema>

function buildPromptBlock(allowedModels: string[]): string {
  return `## Delegating to another model

\`start_subagent\` opens a subagent: you post a card in this stream and another model picks up the question in a thread hanging off it, talking to the user there directly.

- Available models: ${allowedModels.join(", ")}.
- Start one when the user asks for a second opinion, names a model they want, or the task visibly exceeds what you can do well. Never for work you can simply do — a subagent costs the user time and money.
- The \`brief\` is everything the subagent gets. It has your workspace tools but has not read this conversation: write the question, the context, and what would count as an answer.
- One subagent at a time per conversation surface (a channel or scratchpad, including its threads). If one is already running, say so instead of trying again.
- After delegating, tell the user the card is there and that the other model will talk to them in its thread. Do not narrate on its behalf or answer the question yourself in parallel.`
}

/**
 * Whether this turn may offer `start_subagent` at all. Four independent
 * conditions, each for its own reason: the delegation path must be wired, a
 * human must have triggered the turn (the run carries that user's authority —
 * INV-50), the stream must not be sealed (a server-built plaintext brief cannot
 * egress an E2E stream), and the turn must not itself be inside a subagent
 * thread — that last one IS the no-nesting rule, enforced by never building the
 * tool rather than by refusing it at execution.
 */
export function canOfferSubagentDelegation(params: {
  wired: boolean
  invokingUserId: string | undefined
  e2eEnabled: boolean
  insideSubagentThread: boolean
}): boolean {
  return params.wired && Boolean(params.invokingUserId) && !params.e2eEnabled && !params.insideSubagentThread
}

/**
 * Hand a question to a second model as a subagent: a card in this stream plus a
 * thread where that model talks to the user directly. The workspace's governed
 * model set is checked at execution, not just described here, and the stream's
 * one-live-subagent rule is decided by a unique index — so both refusals below
 * are real outcomes, not advisory prose.
 */
export function createStartSubagentTool(deps: StartSubagentToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.START_SUBAGENT,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.START_SUBAGENT],
    description: `Start a subagent: hand this question to another model, which answers the user in a thread off a card in this stream.

Allowed models: ${deps.allowedModels.join(", ")}. Pass the \`model\` id, a short \`title\` for the card, and a self-contained \`brief\` (the delegated model has your workspace tools but has not read this conversation). One subagent at a time per conversation surface (a channel or scratchpad, including its threads).`,
    inputSchema: StartSubagentSchema,
    promptBlock: buildPromptBlock(deps.allowedModels),

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const result = await deps.delegateToModel({ model: input.model, title: input.title, brief: input.brief })
        if (!result.ok) {
          if (result.reason === "already_active") {
            return {
              output: JSON.stringify({
                ok: false,
                error:
                  "A subagent is already running in this stream. Wait for it to finish, or ask the user to cancel it.",
              }),
            }
          }
          if (result.reason === "model_not_allowed") {
            return {
              output: JSON.stringify({
                ok: false,
                error: `That model is not available for delegation in this workspace.`,
                allowedModels: result.allowedModels,
              }),
            }
          }
          return { output: JSON.stringify({ ok: false, error: "Failed to start the subagent" }) }
        }
        return {
          output: JSON.stringify({
            ok: true,
            subagentId: result.subagentId,
            threadStreamId: result.threadStreamId,
            model: result.model,
            note: "Subagent card posted; the delegated model is picking the question up in its thread. Tell the user where it is and let it answer.",
          }),
        }
      } catch (error) {
        logger.error({ error }, "start_subagent failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to start the subagent" }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: "start_subagent", model: input.model, title: input.title }),
      effects: (input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; subagentId?: string }
        if (!parsed.ok || !parsed.subagentId) return []
        return [{ kind: "subagent", label: input.title, target: parsed.subagentId }]
      },
    },
  })
}
