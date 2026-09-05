import type { Pool } from "pg"
import { logger } from "../../lib/logger"
import { JobQueues, type QueueManager } from "../../lib/queue"
import {
  isOutboxEventType,
  DebouncedOutboxHandler,
  type DebouncedOutboxHandlerConfig,
  type OutboxEvent,
  type ConversationCreatedOutboxPayload,
  type ConversationUpdatedOutboxPayload,
} from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"
import { isConversationEmbeddable } from "./embedding-text"

export type ConversationEmbeddingHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Enqueues `CONVERSATION_EMBEDDING_GENERATE` when a conversation is created or
 * updated with a topic summary or summary. Pure status fades from the
 * staleness sweep carry no new text and are skipped; the worker's source hash
 * dedupes everything else.
 */
export class ConversationEmbeddingHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: ConversationEmbeddingHandlerConfig) {
    super(db, { listenerId: "conversation-embedding", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!isOutboxEventType(event, "conversation:created") && !isOutboxEventType(event, "conversation:updated")) {
      return
    }

    const payload: ConversationCreatedOutboxPayload | ConversationUpdatedOutboxPayload = event.payload
    if ("origin" in payload && payload.origin === "staleness-sweep") {
      return
    }
    if (!isConversationEmbeddable(payload.conversation)) {
      return
    }
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      logger.debug({ conversationId: payload.conversationId }, "Skipping embedding for sealed stream conversation")
      return
    }

    await this.jobQueue.send(JobQueues.CONVERSATION_EMBEDDING_GENERATE, {
      conversationId: payload.conversationId,
      workspaceId: payload.workspaceId,
    })
  }
}
