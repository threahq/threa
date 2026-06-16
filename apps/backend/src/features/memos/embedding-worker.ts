import type { Pool } from "pg"
import type { EmbeddingJobData, JobHandler } from "../../lib/queue"
import { MessageRepository } from "../messaging"
import type { EmbeddingServiceLike } from "./embedding-service"
import { logger } from "../../lib/logger"

export interface EmbeddingWorkerDeps {
  pool: Pool
  embeddingService: EmbeddingServiceLike
}

/**
 * Three-phase fetch / embed / save so no DB connection is held during the
 * AI call, which can take 200-500ms (INV-41).
 */
export function createEmbeddingWorker(deps: EmbeddingWorkerDeps): JobHandler<EmbeddingJobData> {
  const { pool, embeddingService } = deps

  return async (job) => {
    const { messageId, workspaceId } = job.data

    logger.info({ jobId: job.id, messageId, workspaceId }, "Processing embedding job")

    const message = await MessageRepository.findById(pool, messageId)

    if (!message) {
      logger.warn({ messageId }, "Message not found for embedding generation")
      return
    }

    if (message.deletedAt) {
      logger.debug({ messageId }, "Skipping embedding for deleted message")
      return
    }

    if (message.contentMarkdown.trim().length < 10) {
      logger.debug({ messageId }, "Skipping embedding for very short message")
      return
    }

    const embedding = await embeddingService.embed(message.contentMarkdown, {
      workspaceId,
      functionId: "message-embedding",
    })

    await MessageRepository.updateEmbedding(pool, messageId, embedding)

    logger.info({ jobId: job.id, messageId }, "Embedding generated and stored")
  }
}
