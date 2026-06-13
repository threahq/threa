import type { Pool } from "pg"
import { logger } from "../../lib/logger"
import { JobQueues, type QueueManager } from "../../lib/queue"
import {
  isOutboxEventType,
  DebouncedOutboxHandler,
  type DebouncedOutboxHandlerConfig,
  type OutboxEvent,
  type AttachmentExtractionCompletedOutboxPayload,
} from "../../lib/outbox"
import { isContentTypeEmbeddable } from "./embedding-config"

export type AttachmentEmbeddingHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Watches the outbox for `attachment:extraction_completed` events and
 * enqueues `ATTACHMENT_EMBED` jobs so the embedding worker can populate
 * `attachment_extractions.summary_embedding` out-of-band.
 *
 * Enqueue is filtered by `contentType` from the event payload so we don't
 * pay for queue churn on `photo`/`other` extractions; the worker re-checks
 * the same eligibility against the freshly-fetched extraction as a defence
 * against reprocessed content.
 */
export class AttachmentEmbeddingHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: AttachmentEmbeddingHandlerConfig) {
    super(db, { listenerId: "attachment-embedding", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!isOutboxEventType(event, "attachment:extraction_completed")) {
      return
    }

    const payload: AttachmentExtractionCompletedOutboxPayload = event.payload

    if (!isContentTypeEmbeddable(payload.contentType)) {
      logger.debug(
        { attachmentId: payload.attachmentId, contentType: payload.contentType },
        "Skipping embedding job for ineligible content type"
      )
      return
    }

    await this.jobQueue.send(JobQueues.ATTACHMENT_EMBED, {
      attachmentId: payload.attachmentId,
      workspaceId: payload.workspaceId,
    })
  }
}
