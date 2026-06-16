import type { PdfAssembleJobData, JobHandler } from "../../../lib/queue"
import type { PdfProcessingServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface PdfAssembleWorkerDeps {
  pdfProcessingService: PdfProcessingServiceLike
}

/** Phase 3: combine page results into the final document extraction. */
export function createPdfAssembleWorker(deps: PdfAssembleWorkerDeps): JobHandler<PdfAssembleJobData> {
  const { pdfProcessingService } = deps

  return async (job) => {
    const { attachmentId, pdfJobId } = job.data

    logger.info({ jobId: job.id, attachmentId, pdfJobId }, "Starting PDF assemble job")

    await pdfProcessingService.assemble(attachmentId, pdfJobId)

    logger.info({ jobId: job.id, attachmentId }, "PDF assemble job completed")
  }
}
