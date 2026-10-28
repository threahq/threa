import { logger } from "../../lib/logger"
import { DocActivityRollupJobSchema, type DocActivityRollupJobData, type JobHandler } from "../../lib/queue"
import type { DocActivityService } from "./activity-service"

export function createDocActivityWorker(service: DocActivityService): JobHandler<DocActivityRollupJobData> {
  return async (job) => {
    const data = DocActivityRollupJobSchema.parse(job.data)
    const result = await service.rollUp(data)
    logger.debug({ jobId: job.id, docId: data.docId, status: result.status }, "Doc activity roll-up completed")
  }
}
