import type { Pool } from "pg"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import type { AI } from "@threahq/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { logger } from "../../../lib/logger"
import { processAttachment } from "../process-attachment"
import { analyzeImage, flattenExtractedText } from "./analyze"
import type { ImageCaptionServiceLike } from "./types"

export interface ImageCaptionServiceDeps {
  pool: Pool
  ai: AI
  storage: StorageProvider
  configResolver: ConfigResolver
}

export class ImageCaptionService implements ImageCaptionServiceLike {
  private readonly pool: Pool
  private readonly ai: AI
  private readonly storage: StorageProvider
  private readonly configResolver: ConfigResolver

  constructor(deps: ImageCaptionServiceDeps) {
    this.pool = deps.pool
    this.ai = deps.ai
    this.storage = deps.storage
    this.configResolver = deps.configResolver
  }

  async processImage(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    await processAttachment(this.pool, attachmentId, async (attachment) => {
      log.info({ filename: attachment.filename, mimeType: attachment.mimeType }, "Processing image attachment")

      try {
        const imageBuffer = await this.storage.getObject(attachment.storagePath)

        const analysis = await analyzeImage(
          { ai: this.ai, configResolver: this.configResolver },
          imageBuffer,
          attachment.mimeType,
          { workspaceId: attachment.workspaceId, attachmentId, filename: attachment.filename }
        )

        log.info(
          { contentType: analysis.contentType, summaryLength: analysis.summary.length },
          "Image analysis completed"
        )

        return {
          contentType: analysis.contentType,
          summary: analysis.summary,
          fullText: flattenExtractedText(analysis),
          structuredData: analysis.structuredData,
        }
      } catch (error) {
        log.error({ error }, "Image processing failed")
        throw error
      }
    })
  }
}
