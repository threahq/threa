import type { Pool } from "pg"
import { AttachmentRepository } from "../repository"
import { ProcessingStatuses } from "@threahq/types"
import { logger } from "../../../lib/logger"
import type { ImageCaptionServiceLike } from "./types"

/**
 * Stub implementation of ImageCaptionService for testing.
 * Marks images as skipped instead of processing them.
 */
export class StubImageCaptionService implements ImageCaptionServiceLike {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async processImage(attachmentId: string): Promise<void> {
    logger.debug({ attachmentId }, "Stub image caption service - marking as skipped")
    await AttachmentRepository.updateProcessingStatus(this.pool, attachmentId, ProcessingStatuses.SKIPPED)
  }
}
