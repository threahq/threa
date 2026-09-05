import type { Pool } from "pg"
import { isOutboxEventType, parseMessagePayload } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export type EmbeddingHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Embedding generation runs async - messages are immediately searchable via
 * keyword search, and become semantically searchable once the embedding is ready.
 * Conversation assignment/reassignment events re-embed the message with its
 * (now-known) conversation context.
 */
export class EmbeddingHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: EmbeddingHandlerConfig) {
    super(db, { listenerId: "embedding", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (isOutboxEventType(event, "message:created")) {
      const payload = parseMessagePayload(event.payload)
      if (!payload) {
        logger.debug({ eventId: event.id.toString() }, "EmbeddingHandler: malformed event, skipping")
        return
      }

      if (payload.event.actorType === "system") {
        return
      }

      await this.dispatch(
        payload.workspaceId,
        payload.streamId,
        payload.event.payload.messageId,
        "Embedding job dispatched"
      )
      return
    }

    if (isOutboxEventType(event, "conversation:message_assigned")) {
      const payload = event.payload
      if (!payload.isPrimary) return

      await this.dispatch(
        payload.workspaceId,
        payload.streamId,
        payload.messageId,
        "Embedding job dispatched for assigned message"
      )
      return
    }

    if (isOutboxEventType(event, "conversation:message_reassigned")) {
      const payload = event.payload
      await this.dispatch(
        payload.workspaceId,
        payload.streamId,
        payload.messageId,
        "Embedding job dispatched for reassigned message"
      )
    }
  }

  private async dispatch(workspaceId: string, streamId: string, messageId: string, logMessage: string): Promise<void> {
    // E2E streams: contentMarkdown is ciphertext, so an embedding of it
    // is meaningless. Skip without inspecting the message.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    logger.debug({ messageId }, logMessage)

    await this.jobQueue.send(JobQueues.EMBEDDING_GENERATE, { messageId, workspaceId })
  }
}
