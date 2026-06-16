import type { PdfProcessPageJobData, JobHandler } from "../../../lib/queue"
import type { PdfProcessingServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface PdfPageWorkerDeps {
  pdfProcessingService: PdfProcessingServiceLike
}

/** Phase 2: process a single page based on its classification. */
export function createPdfPageWorker(deps: PdfPageWorkerDeps): JobHandler<PdfProcessPageJobData> {
  const { pdfProcessingService } = deps

  return async (job) => {
    const { attachmentId, pageNumber, pdfJobId } = job.data

    logger.info({ jobId: job.id, attachmentId, pageNumber, pdfJobId }, "Processing PDF page job")

    await pdfProcessingService.processPage(attachmentId, pageNumber, pdfJobId)

    logger.info({ jobId: job.id, attachmentId, pageNumber }, "PDF page job completed")
  }
}
