import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import { MessageRepository } from "../../messaging"
import { toShortcode } from "../../emoji"
import type { ReactionToolDeps, WorkspaceToolDeps } from "./tool-deps"

const ReactToMessageSchema = z.object({
  messageId: z
    .string()
    .describe("The id of the message to react to (e.g. msg_xyz from a [msg:…] tag in the conversation)"),
  emoji: z
    .string()
    .describe(
      "The emoji to react with — either a unicode emoji (👍) or a shortcode (:+1:). Normalized to a shortcode."
    ),
  action: z
    .enum(["add", "remove"])
    .optional()
    .describe("Whether to add the reaction (default) or remove a reaction the persona previously added."),
})

export type ReactToMessageInput = z.infer<typeof ReactToMessageSchema>

/**
 * Add or remove an emoji reaction on a message, acting as the running persona.
 *
 * Runs inline like any other tool — when the model calls it the reaction is
 * applied immediately and the result is fed back into the same turn, so the
 * agent can react at any point in a tool chain (not just as a terminal action
 * like `send_message`).
 *
 * Access scope: the persona may only react to messages whose stream is within
 * its invocation-bounded `accessibleStreamIds` (the same gate the workspace
 * search/quote surfaces use). A message outside that reach — or a deleted /
 * cross-workspace id — is rejected without writing.
 */
export function createReactToMessageTool(workspace: WorkspaceToolDeps, reactions: ReactionToolDeps) {
  const { db, workspaceId, accessibleStreamIds } = workspace
  const { addReaction, removeReaction } = reactions
  const accessible = new Set(accessibleStreamIds)

  return defineAgentTool({
    name: "react_to_message",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.REACT_TO_MESSAGE],
    description: `React to a message with an emoji (or remove your reaction), acting as yourself.

Use this to acknowledge or respond to a message lightweightly — a 👍 on a decision, a ✅ on a completed task, a 🎉 to celebrate — instead of (or in addition to) sending a message. You can react to any message in the current conversation or in another stream you can see; pass its \`messageId\` (the id in a \`[msg:…]\` tag).

- \`action: "add"\` (default) adds the reaction.
- \`action: "remove"\` removes a reaction you previously added.

This is a side-effect tool: it applies immediately and does not end your turn, so you can react and still send a message in the same turn.`,
    inputSchema: ReactToMessageSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const action = input.action ?? "add"
      try {
        const shortcode = toShortcode(input.emoji)
        if (!shortcode) {
          return { output: JSON.stringify({ ok: false, error: "Unrecognized emoji", emoji: input.emoji }) }
        }

        // Resolve the target message within the workspace and gate on access.
        const byId = await MessageRepository.findByIdsInWorkspace(db, workspaceId, [input.messageId])
        const message = byId.get(input.messageId)
        if (!message || message.deletedAt) {
          return { output: JSON.stringify({ ok: false, error: "Message not found", messageId: input.messageId }) }
        }
        if (!accessible.has(message.streamId)) {
          return {
            output: JSON.stringify({
              ok: false,
              error: "You don't have access to that message",
              messageId: input.messageId,
            }),
          }
        }

        const result =
          action === "remove"
            ? await removeReaction({ streamId: message.streamId, messageId: input.messageId, emoji: shortcode })
            : await addReaction({ streamId: message.streamId, messageId: input.messageId, emoji: shortcode })

        if (!result) {
          return { output: JSON.stringify({ ok: false, error: "Message not found", messageId: input.messageId }) }
        }

        return { output: JSON.stringify({ ok: true, action, messageId: input.messageId, emoji: shortcode }) }
      } catch (error) {
        logger.error({ error, messageId: input.messageId, action }, "react_to_message failed")
        return { output: JSON.stringify({ ok: false, error: "Failed to apply reaction", messageId: input.messageId }) }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({
          tool: "react_to_message",
          action: input.action ?? "add",
          messageId: input.messageId,
          emoji: input.emoji,
        }),
    },
  })
}
