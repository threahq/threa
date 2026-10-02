import type { TextProcessJobData, JobHandler } from "../../../lib/queue"
import type { TextProcessingServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface TextProcessingWorkerDeps {
  textProcessingService: TextProcessingServiceLike
}

/**
 * Create the text processing job handler for the queue system.
 *
 * This is a thin wrapper that extracts job data and delegates to the service.
 * All business logic lives in the service for reusability and testability.
 */
export function createTextProcessingWorker(deps: TextProcessingWorkerDeps): JobHandler<TextProcessJobData> {
  const { textProcessingService } = deps

  return async (job) => {
    const { attachmentId, workspaceId, filename } = job.data

    logger.info({ jobId: job.id, attachmentId, filename }, "Processing text file job")

    await textProcessingService.processText(workspaceId, attachmentId)

    logger.info({ jobId: job.id, attachmentId }, "Text processing job completed")
  }
}
