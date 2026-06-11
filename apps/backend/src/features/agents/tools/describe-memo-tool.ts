import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

const DescribeMemoSchema = z.object({
  memoId: z.string().describe("The ID of the memo to describe (e.g. memo_xyz from a workspace_research result)"),
})

export type DescribeMemoInput = z.infer<typeof DescribeMemoSchema>

/**
 * Look up a memo by id and return its abstract + key points + the
 * resolved source-message ids (with stream/author info) so the agent can
 * forward or quote those messages with `shared-message:` / `quote:` pointer
 * URLs.
 *
 * Access scope: gated by `accessibleStreamIds` inside `MemoExplorerService.getById`,
 * which rejects memos whose source stream is outside the invoking user's reach
 * and filters per-source-message access. Outputs only ids the caller could have
 * obtained directly via `search_messages`, so emitting them as pointer URLs
 * does not widen the access surface.
 */
export function createDescribeMemoTool(deps: WorkspaceToolDeps) {
  const { workspaceId, accessibleStreamIds, memoExplorer } = deps

  return defineAgentTool({
    name: "describe_memo",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.DESCRIBE_MEMO],
    promptBlock: `## Describing Memos

You have a \`describe_memo\` tool to look up a memo by id and return its abstract, key points, tags, and the source messages it was derived from.

When to use describe_memo:
- After \`workspace_research\` surfaces a memo id (look for \`memo:…\` in retrieved-knowledge entries) and you want to forward or quote one of the source messages directly
- When the abstract is too lossy and you need the original wording from a specific source message
- To find the conversation that produced a memo so you can reference it with \`shared-message:\` / \`quote:\` pointer URLs

The tool returns each source message's \`messageId\`, \`streamId\`, and \`authorId\` — exactly the ids you need to compose a pointer URL per the "Referring to messages and attachments" section.`,
    description: `Describe a memo by id: returns its abstract, key points, tags, and the source messages it was derived from.

Use this after \`workspace_research\` surfaces a memo id (look for \`memo:…\` in retrieved-knowledge entries) when you need to:
- Quote or forward a specific source message that backs the memo
- See the original wording rather than the abstract
- Resolve the conversation that produced the memo

Returns the source messages with their \`messageId\`, \`streamId\`, and \`authorId\` so you can build \`shared-message:\` / \`quote:\` pointer URLs.`,
    inputSchema: DescribeMemoSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const detail = await memoExplorer.getById(workspaceId, input.memoId, { accessibleStreamIds })
        if (!detail) {
          return {
            output: JSON.stringify({
              error: "Memo not found, archived, or you don't have access to its source stream",
              memoId: input.memoId,
            }),
          }
        }

        const { memo, sourceStream, rootStream, sourceMessages } = detail

        return {
          output: JSON.stringify({
            id: memo.id,
            title: memo.title,
            abstract: memo.abstract,
            keyPoints: memo.keyPoints,
            tags: memo.tags,
            knowledgeType: memo.knowledgeType,
            memoType: memo.memoType,
            sourceStream: sourceStream
              ? { id: sourceStream.id, type: sourceStream.type, name: sourceStream.name }
              : null,
            rootStream: rootStream ? { id: rootStream.id, type: rootStream.type, name: rootStream.name } : null,
            sources: sourceMessages.map((m) => ({
              messageId: m.id,
              streamId: m.streamId,
              streamName: m.streamName,
              authorId: m.authorId,
              authorType: m.authorType,
              authorName: m.authorName,
              contentMarkdownPreview: truncate(m.content, 400),
              createdAt: m.createdAt.toISOString(),
            })),
          }),
        }
      } catch (error) {
        // Log the full exception for operator triage; return a stable, generic
        // message to the model so DB / service internals can't leak through
        // the tool output (which is also persisted on the trace).
        logger.error({ error, memoId: input.memoId }, "describe_memo failed")
        return {
          output: JSON.stringify({
            error: "Failed to describe memo",
            memoId: input.memoId,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: "describe_memo", memoId: input.memoId }),
    },
  })
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + "..."
}
