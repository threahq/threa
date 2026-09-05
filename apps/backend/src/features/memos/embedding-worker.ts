import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import type { EmbeddingJobData, JobHandler } from "../../lib/queue"
import { MessageRepository } from "../messaging"
import type { EmbeddingServiceLike } from "./embedding-service"
import { embedMessageWithContext } from "./message-embedding-text"
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

    if (message.authorType === AuthorTypes.SYSTEM) {
      logger.debug({ messageId }, "Skipping embedding for system message")
      return
    }

    await embedMessageWithContext({ pool, embeddingService }, workspaceId, message)

    logger.info({ jobId: job.id, messageId }, "Embedding generated and stored")
  }
}
