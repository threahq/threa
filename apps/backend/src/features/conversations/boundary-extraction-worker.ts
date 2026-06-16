import type { BoundaryExtractionJobData, JobHandler } from "../../lib/queue"
import type { BoundaryExtractionService } from "./boundary-extraction-service"
import { logger } from "../../lib/logger"

export interface BoundaryExtractionWorkerDeps {
  service: BoundaryExtractionService
}

export function createBoundaryExtractionWorker(
  deps: BoundaryExtractionWorkerDeps
): JobHandler<BoundaryExtractionJobData> {
  const { service } = deps

  return async (job) => {
    const { messageId, streamId, workspaceId } = job.data

    logger.info({ jobId: job.id, messageId, streamId }, "Processing boundary extraction job")

    const conversation = await service.processMessage(messageId, streamId, workspaceId)

    if (conversation) {
      logger.info({ jobId: job.id, conversationId: conversation.id, messageId }, "Boundary extraction job completed")
    } else {
      logger.warn({ jobId: job.id, messageId }, "Boundary extraction produced no conversation")
    }
  }
}
