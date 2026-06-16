import type { Pool } from "pg"
import { parseMessagePayload } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export type EmbeddingHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Embedding generation runs async - messages are immediately searchable via
 * keyword search, and become semantically searchable once the embedding is ready.
 */
export class EmbeddingHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: EmbeddingHandlerConfig) {
    super(db, { listenerId: "embedding", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "message:created") {
      return
    }

    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      logger.debug({ eventId: event.id.toString() }, "EmbeddingHandler: malformed event, skipping")
      return
    }

    // E2E streams: contentMarkdown is ciphertext, so an embedding of it
    // is meaningless. Skip without inspecting the message.
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      return
    }

    if (payload.event.actorType === "system") {
      return
    }

    logger.debug({ messageId: payload.event.payload.messageId }, "Embedding job dispatched")

    await this.jobQueue.send(JobQueues.EMBEDDING_GENERATE, {
      messageId: payload.event.payload.messageId,
      workspaceId: payload.workspaceId,
    })
  }
}
