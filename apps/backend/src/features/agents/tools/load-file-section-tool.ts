import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { AttachmentRepository, AttachmentExtractionRepository } from "../../attachments"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

const MAX_LINES_PER_REQUEST = 500

const LoadFileSectionSchema = z
  .object({
    attachmentId: z.string().describe("The ID of the text file attachment"),
    startLine: z.number().int().min(0).describe("Start line number (0-indexed, inclusive)"),
    endLine: z.number().int().min(0).describe("End line number (0-indexed, exclusive)"),
  })
  .refine((data) => data.startLine < data.endLine, {
    message: "startLine must be less than endLine",
    path: ["startLine"],
  })
  .refine((data) => data.endLine - data.startLine <= MAX_LINES_PER_REQUEST, {
    message: `Cannot load more than ${MAX_LINES_PER_REQUEST} lines at once`,
    path: ["endLine"],
  })

export type LoadFileSectionInput = z.infer<typeof LoadFileSectionSchema>

export interface LoadFileSectionResult {
  attachmentId: string
  filename: string
  startLine: number
  endLine: number
  totalLines: number
  content: string
}

export function createLoadFileSectionTool(deps: WorkspaceToolDeps) {
  const { db, accessibleStreamIds, storage } = deps

  return defineAgentTool({
    name: "load_file_section",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LOAD_FILE_SECTION],
    description: `Load specific lines from a large text file. Only use this when:
- The file is large (>32KB) and injection strategy is "summary" (full content not in context)
- You need to read specific sections based on the section metadata
- The user asks about content in a specific section

The attachment extraction includes textMetadata.sections with line ranges. Use that to determine which lines to load.

For small/medium files (<32KB), full content is already available in fullText - don't use this tool.`,
    inputSchema: LoadFileSectionSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const attachment = await AttachmentRepository.findById(db, input.attachmentId)
        if (!attachment) {
          return {
            output: JSON.stringify({
              error: "File not found, not accessible, or lines not available",
              attachmentId: input.attachmentId,
              startLine: input.startLine,
              endLine: input.endLine,
            }),
          }
        }
        if (!attachment.streamId || !accessibleStreamIds.includes(attachment.streamId)) {
          return {
            output: JSON.stringify({
              error: "File not found, not accessible, or lines not available",
              attachmentId: input.attachmentId,
              startLine: input.startLine,
              endLine: input.endLine,
            }),
          }
        }

        const extraction = await AttachmentExtractionRepository.findByAttachmentId(db, input.attachmentId)
        if (!extraction || extraction.sourceType !== "text" || !extraction.textMetadata) {
          return {
            output: JSON.stringify({
              error: "File not found, not accessible, or lines not available",
              attachmentId: input.attachmentId,
              startLine: input.startLine,
              endLine: input.endLine,
            }),
          }
        }

        const totalLines = extraction.textMetadata.totalLines
        if (input.startLine >= totalLines || input.endLine > totalLines) {
          return {
            output: JSON.stringify({
              error: "File not found, not accessible, or lines not available",
              attachmentId: input.attachmentId,
              startLine: input.startLine,
              endLine: input.endLine,
            }),
          }
        }

        const fileBuffer = await storage.getObject(attachment.storagePath)
        const lines = fileBuffer.toString("utf-8").split("\n")

        const result: LoadFileSectionResult = {
          attachmentId: input.attachmentId,
          filename: attachment.filename,
          startLine: input.startLine,
          endLine: input.endLine,
          totalLines,
          content: lines.slice(input.startLine, input.endLine).join("\n"),
        }

        logger.debug(
          {
            attachmentId: input.attachmentId,
            startLine: input.startLine,
            endLine: input.endLine,
            contentLength: result.content.length,
          },
          "File section loaded"
        )

        return {
          output: JSON.stringify({
            filename: result.filename,
            lineRange: `${result.startLine}-${result.endLine - 1} of ${result.totalLines}`,
            content: result.content,
          }),
        }
      } catch (error) {
        logger.error({ error, ...input }, "Load file section failed")
        return {
          output: JSON.stringify({
            error: `Failed to load file section: ${error instanceof Error ? error.message : "Unknown error"}`,
            attachmentId: input.attachmentId,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) =>
        JSON.stringify({
          tool: "load_file_section",
          attachmentId: input.attachmentId,
          lines: `${input.startLine}-${input.endLine}`,
        }),
    },
  })
}
