import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threa/types"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

const LoadAttachmentSchema = z.object({
  attachmentId: z.string().describe("The ID of the attachment to load for direct analysis"),
})

export type LoadAttachmentInput = z.infer<typeof LoadAttachmentSchema>

export interface LoadAttachmentResult {
  id: string
  filename: string
  mimeType: string
  dataUrl: string
}

export function createLoadAttachmentTool(deps: WorkspaceToolDeps) {
  const { workspaceId, accessibleStreamIds, attachmentService, storage } = deps

  return defineAgentTool({
    name: "load_attachment",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LOAD_ATTACHMENT],
    promptBlock: `## Loading Attachments for Analysis

You have a \`load_attachment\` tool to load an image for direct visual analysis.

When to use load_attachment:
- When the user asks you to look at or analyze an image
- When you need to understand visual content in detail
- When the caption/description from get_attachment isn't sufficient

Note: This tool returns the actual image data so you can see and describe what's in the image.`,
    description: `Load an attachment for direct visual analysis. Only use this for images when you need to:
- Analyze the actual visual content (not just the text extraction/caption)
- Identify specific visual elements, colors, or layouts
- Read text that may not have been extracted properly
- Understand diagrams, charts, or visual relationships

For text content from documents, prefer get_attachment which returns the extracted text.`,
    inputSchema: LoadAttachmentSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const attachment = await attachmentService.getAccessible(input.attachmentId, {
          workspaceId,
          accessibleStreamIds,
        })
        if (!attachment) {
          return {
            output: JSON.stringify({
              error: "Attachment not found, not accessible, or not an image",
              attachmentId: input.attachmentId,
            }),
          }
        }
        if (!attachment.mimeType.startsWith("image/")) {
          return {
            output: JSON.stringify({
              error: "Attachment not found, not accessible, or not an image",
              attachmentId: input.attachmentId,
            }),
          }
        }

        const buffer = await storage.getObject(attachment.storagePath)
        const base64 = buffer.toString("base64")
        const result: LoadAttachmentResult = {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          dataUrl: `data:${attachment.mimeType};base64,${base64}`,
        }

        logger.debug({ attachmentId: input.attachmentId, mimeType: result.mimeType }, "Attachment loaded for analysis")

        return {
          output: `Image loaded: ${result.filename} (${result.mimeType})`,
          multimodal: [{ type: "image", url: result.dataUrl }],
        }
      } catch (error) {
        logger.error({ error, attachmentId: input.attachmentId }, "Load attachment failed")
        return {
          output: JSON.stringify({
            error: `Failed to load attachment: ${error instanceof Error ? error.message : "Unknown error"}`,
            attachmentId: input.attachmentId,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input, result) => {
        if (result.multimodal && result.multimodal.length > 0) {
          return `Loaded image: ${input.attachmentId}`
        }
        return result.output
      },
    },
  })
}
