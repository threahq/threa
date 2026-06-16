import type { ExcelProcessJobData, JobHandler } from "../../../lib/queue"
import type { ExcelProcessingServiceLike } from "./types"
import { logger } from "../../../lib/logger"

export interface ExcelProcessingWorkerDeps {
  excelProcessingService: ExcelProcessingServiceLike
}

export function createExcelProcessingWorker(deps: ExcelProcessingWorkerDeps): JobHandler<ExcelProcessJobData> {
  const { excelProcessingService } = deps

  return async (job) => {
    const { attachmentId, filename } = job.data

    logger.info({ jobId: job.id, attachmentId, filename }, "Processing Excel workbook job")

    await excelProcessingService.processExcel(attachmentId)

    logger.info({ jobId: job.id, attachmentId }, "Excel processing job completed")
  }
}
