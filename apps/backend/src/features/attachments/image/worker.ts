import type { ImageThumbnailJobData, JobHandler } from "../../../lib/queue"
import type { ImageThumbnailServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface ImageThumbnailWorkerDeps {
  imageThumbnailService: ImageThumbnailServiceLike
}

export function createImageThumbnailWorker(deps: ImageThumbnailWorkerDeps): JobHandler<ImageThumbnailJobData> {
  const { imageThumbnailService } = deps

  return async (job) => {
    const { attachmentId, filename, mimeType } = job.data

    logger.info({ jobId: job.id, attachmentId, filename, mimeType }, "Processing image thumbnail job")

    await imageThumbnailService.generateThumbnail(attachmentId)

    logger.info({ jobId: job.id, attachmentId }, "Image thumbnail job completed")
  }
}
