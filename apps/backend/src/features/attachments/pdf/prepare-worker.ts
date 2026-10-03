import type { PdfPrepareJobData, JobHandler } from "../../../lib/queue"
import type { PdfProcessingServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface PdfPrepareWorkerDeps {
  pdfProcessingService: PdfProcessingServiceLike
}

/** Phase 1: extract text/images, classify pages, fan out per-page jobs. */
export function createPdfPrepareWorker(deps: PdfPrepareWorkerDeps): JobHandler<PdfPrepareJobData> {
  const { pdfProcessingService } = deps

  return async (job) => {
    const { attachmentId, workspaceId, filename } = job.data

    logger.info({ jobId: job.id, attachmentId, filename }, "Starting PDF prepare job")

    await pdfProcessingService.prepare(workspaceId, attachmentId)

    logger.info({ jobId: job.id, attachmentId }, "PDF prepare job completed")
  }
}
