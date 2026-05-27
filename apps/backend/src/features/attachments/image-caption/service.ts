/**
 * Image Caption Service
 *
 * Processes image attachments to extract structured information
 * that can be used by AI agents to understand visual content.
 */

import type { Pool } from "pg"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { AI } from "@threa/agent-runtime"
import { logger } from "../../../lib/logger"
import { processAttachment } from "../process-attachment"
import {
  IMAGE_CAPTION_MODEL_ID,
  IMAGE_CAPTION_TEMPERATURE,
  IMAGE_CAPTION_SYSTEM_PROMPT,
  IMAGE_CAPTION_USER_PROMPT,
  imageAnalysisSchema,
} from "./config"
import type { ImageCaptionServiceLike } from "./types"

export interface ImageCaptionServiceDeps {
  pool: Pool
  ai: AI
  storage: StorageProvider
}

export class ImageCaptionService implements ImageCaptionServiceLike {
  private readonly pool: Pool
  private readonly ai: AI
  private readonly storage: StorageProvider

  constructor(deps: ImageCaptionServiceDeps) {
    this.pool = deps.pool
    this.ai = deps.ai
    this.storage = deps.storage
  }

  async processImage(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    await processAttachment(this.pool, attachmentId, async (attachment) => {
      log.info({ filename: attachment.filename, mimeType: attachment.mimeType }, "Processing image attachment")

      try {
        // Download image from S3
        const imageBuffer = await this.storage.getObject(attachment.storagePath)
        const base64Image = imageBuffer.toString("base64")

        // Determine media type for the AI SDK
        const mediaType = attachment.mimeType.startsWith("image/") ? attachment.mimeType : "image/png" // Fallback for octet-stream

        // Call AI to analyze the image
        const { value: analysis } = await this.ai.generateObject({
          model: IMAGE_CAPTION_MODEL_ID,
          schema: imageAnalysisSchema,
          temperature: IMAGE_CAPTION_TEMPERATURE,
          messages: [
            {
              role: "system",
              content: IMAGE_CAPTION_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: [
                { type: "text", text: IMAGE_CAPTION_USER_PROMPT },
                {
                  type: "image",
                  image: base64Image,
                  mimeType: mediaType,
                },
              ],
            },
          ],
          telemetry: {
            functionId: "image-caption",
            metadata: {
              attachment_id: attachmentId,
              workspace_id: attachment.workspaceId,
              filename: attachment.filename,
              mime_type: attachment.mimeType,
            },
          },
          context: {
            workspaceId: attachment.workspaceId,
          },
        })

        log.info(
          { contentType: analysis.contentType, summaryLength: analysis.summary.length },
          "Image analysis completed"
        )

        // Build fullText from extracted text components
        const textParts: string[] = []
        if (analysis.extractedText?.headings?.length) {
          textParts.push(...analysis.extractedText.headings)
        }
        if (analysis.extractedText?.labels?.length) {
          textParts.push(...analysis.extractedText.labels)
        }
        if (analysis.extractedText?.body) {
          textParts.push(analysis.extractedText.body)
        }
        const fullText = textParts.length > 0 ? textParts.join("\n") : null

        return {
          contentType: analysis.contentType,
          summary: analysis.summary,
          fullText,
          structuredData: analysis.structuredData,
        }
      } catch (error) {
        log.error({ error }, "Image processing failed")
        throw error
      }
    })
  }
}
