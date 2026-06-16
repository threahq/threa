import { AvatarUploadRepository } from "./avatar-upload-repository"
import { logger } from "../../lib/logger"
import type { AvatarProcessJobData, JobHandler, OnDLQHook } from "../../lib/queue"
import type { AvatarProcessingService } from "./avatar-processing-service"

export interface AvatarProcessWorkerDeps {
  avatarProcessingService: AvatarProcessingService
}

export function createAvatarProcessWorker(deps: AvatarProcessWorkerDeps): JobHandler<AvatarProcessJobData> {
  const { avatarProcessingService } = deps

  return async (job) => {
    logger.info({ jobId: job.id, avatarUploadId: job.data.avatarUploadId }, "Processing avatar job")
    await avatarProcessingService.processUpload(job.data.avatarUploadId)
    logger.info({ jobId: job.id, avatarUploadId: job.data.avatarUploadId }, "Avatar job completed")
  }
}

export function createAvatarProcessOnDLQ(): OnDLQHook<AvatarProcessJobData> {
  return async (querier, job, error) => {
    const { avatarUploadId } = job.data
    logger.warn(
      { jobId: job.id, avatarUploadId, error: error.message },
      "Avatar processing moved to DLQ, deleting upload row"
    )

    // Raw S3 file is deliberately kept for debugging/reprocessing.
    await AvatarUploadRepository.deleteById(querier, avatarUploadId)
  }
}
