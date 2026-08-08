import type { DynamicNamingEvaluateJobData, JobHandler } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { DynamicNamingService } from "./service"

export function createDynamicNamingWorker(service: DynamicNamingService): JobHandler<DynamicNamingEvaluateJobData> {
  return async (job) => {
    const result = await service.evaluate(job.data, job.id)
    logger.info(
      {
        jobId: job.id,
        targetKind: job.data.targetKind,
        targetId: job.data.targetId,
        status: result.status,
      },
      "Dynamic naming evaluation completed"
    )
  }
}
