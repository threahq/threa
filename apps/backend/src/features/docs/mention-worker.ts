import { logger } from "../../lib/logger"
import { DocMentionSettleJobSchema, type DocMentionSettleJobData, type JobHandler } from "../../lib/queue"
import type { DocMentionService } from "./mention-service"

export function createDocMentionWorker(service: DocMentionService): JobHandler<DocMentionSettleJobData> {
  return async (job) => {
    const data = DocMentionSettleJobSchema.parse(job.data)
    const result = await service.settle(data)
    logger.debug({ jobId: job.id, docId: data.docId, status: result.status }, "Doc mention settle completed")
  }
}
