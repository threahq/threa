import type { ImageCaptionJobData, JobHandler } from "../../../lib/queue"
import type { ImageCaptionServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface ImageCaptionWorkerDeps {
  imageCaptionService: ImageCaptionServiceLike
}

export function createImageCaptionWorker(deps: ImageCaptionWorkerDeps): JobHandler<ImageCaptionJobData> {
  const { imageCaptionService } = deps

  return async (job) => {
    const { attachmentId, filename, mimeType } = job.data

    logger.info({ jobId: job.id, attachmentId, filename, mimeType }, "Processing image caption job")

    await imageCaptionService.processImage(attachmentId)

    logger.info({ jobId: job.id, attachmentId }, "Image caption job completed")
  }
}
