import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type ExtractionContentType } from "@threa/types"
import { logger } from "../../../lib/logger"
import { AttachmentRepository } from "../../attachments"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

const SearchAttachmentsSchema = z.object({
  query: z.string().describe("Search query to find attachments by filename or content"),
  contentTypes: z
    .array(z.string())
    .optional()
    .describe("Filter by content types: chart, table, diagram, screenshot, photo, document, other"),
  limit: z.number().optional().default(10).describe("Maximum number of results to return (default: 10)"),
})

export type SearchAttachmentsInput = z.infer<typeof SearchAttachmentsSchema>

export interface AttachmentSearchResult {
  id: string
  filename: string
  mimeType: string
  contentType: string | null
  summary: string | null
  streamId: string | null
  messageId: string | null
  createdAt: string
}

const MAX_RESULTS = 20

export function createSearchAttachmentsTool(deps: WorkspaceToolDeps) {
  const { db, workspaceId, accessibleStreamIds } = deps

  return defineAgentTool({
    name: "search_attachments",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.SEARCH_ATTACHMENTS],
    promptBlock: `## Searching Attachments

You have a \`search_attachments\` tool to search for files shared in the workspace.

When to use search_attachments:
- When the user asks about previously shared files or documents
- To find relevant attachments by name or content
- To discover what files exist in a conversation or workspace`,
    description: `Search for attachments (images, documents, files) in the workspace. Use this to find:
- Images or screenshots shared in conversations
- Documents uploaded to streams
- Files matching a specific name or content description

The search matches against filenames and extracted content summaries.`,
    inputSchema: SearchAttachmentsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const limit = Math.min(input.limit ?? 10, MAX_RESULTS)

        const dbResults = await AttachmentRepository.searchWithExtractions(db, {
          workspaceId,
          streamIds: accessibleStreamIds,
          query: input.query,
          contentTypes: input.contentTypes as ExtractionContentType[] | undefined,
          limit,
        })

        const results: AttachmentSearchResult[] = dbResults.map((r) => ({
          id: r.id,
          filename: r.filename,
          mimeType: r.mimeType,
          contentType: r.extraction?.contentType ?? null,
          summary: r.extraction?.summary ?? null,
          streamId: r.streamId,
          messageId: r.messageId,
          createdAt: r.createdAt.toISOString(),
        }))

        if (results.length === 0) {
          return {
            output: JSON.stringify({
              query: input.query,
              contentTypes: input.contentTypes,
              results: [],
              message: "No matching attachments found",
            }),
          }
        }

        logger.debug({ query: input.query, resultCount: results.length }, "Attachment search completed")

        return {
          output: JSON.stringify({
            query: input.query,
            contentTypes: input.contentTypes,
            results: results.map((r) => ({
              id: r.id,
              filename: r.filename,
              mimeType: r.mimeType,
              contentType: r.contentType,
              summary: r.summary ? truncate(r.summary, 200) : null,
              streamId: r.streamId,
              messageId: r.messageId,
              date: r.createdAt,
            })),
          }),
        }
      } catch (error) {
        logger.error({ error, query: input.query }, "Attachment search failed")
        return {
          output: JSON.stringify({
            error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            query: input.query,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: "search_attachments", query: input.query }),
    },
  })
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + "..."
}
