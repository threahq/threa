import type { Pool } from "pg"
import { parseMessagePayload } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export type BoundaryExtractionHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Dispatches boundary-extraction jobs for messages arriving via the outbox.
 * User messages are LLM-clustered; agent (persona/bot) replies are assigned
 * deterministically to the conversation they reply within (handled in
 * `BoundaryExtractionService.processMessage`) — both flow through this dispatch.
 */
export class BoundaryExtractionHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: BoundaryExtractionHandlerConfig) {
    super(db, { listenerId: "boundary-extraction", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "message:created") {
      return
    }

    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      logger.debug({ eventId: event.id.toString() }, "BoundaryExtractionHandler: malformed event, skipping")
      return
    }

    const { streamId, workspaceId, event: messageEvent } = payload

    // E2E streams: boundary extraction inspects message content, which
    // is ciphertext on E2E streams and useless to the LLM.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    // Every message — user or agent (persona/bot) — belongs to a conversation.
    // User messages are LLM-clustered; agent replies are assigned
    // deterministically in processMessage. Skip only malformed actorless events.
    if (!messageEvent.actorId) {
      return
    }

    logger.debug({ streamId, messageId: messageEvent.payload.messageId }, "Boundary extraction job dispatched")

    await this.jobQueue.send(JobQueues.BOUNDARY_EXTRACT, {
      messageId: messageEvent.payload.messageId,
      streamId,
      workspaceId,
    })
  }
}
