import type { WordProcessJobData, JobHandler } from "../../../lib/queue"
import type { WordProcessingServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface WordProcessingWorkerDeps {
  wordProcessingService: WordProcessingServiceLike
}

export function createWordProcessingWorker(deps: WordProcessingWorkerDeps): JobHandler<WordProcessJobData> {
  const { wordProcessingService } = deps

  return async (job) => {
    const { attachmentId, filename } = job.data

    logger.info({ jobId: job.id, attachmentId, filename }, "Processing Word document job")

    await wordProcessingService.processWord(attachmentId)

    logger.info({ jobId: job.id, attachmentId }, "Word processing job completed")
  }
}
