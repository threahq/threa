import type { Pool } from "pg"
import { parseMessagePayload } from "../../lib/outbox"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { logger } from "@threa/backend-common"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

const LINK_PREVIEW_EVENT_TYPES = new Set(["message:created", "message:edited"])

export type LinkPreviewHandlerConfig = DebouncedOutboxHandlerConfig

export class LinkPreviewOutboxHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: LinkPreviewHandlerConfig) {
    super(db, { listenerId: "link_preview", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!LINK_PREVIEW_EVENT_TYPES.has(event.eventType)) {
      return
    }

    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      return
    }

    const isEdit = event.eventType === "message:edited"
    const { workspaceId, streamId, event: messageEvent } = payload
    const { messageId, contentJson, contentMarkdown } = messageEvent.payload

    // E2E streams: contentMarkdown is ciphertext, so the URL scanner
    // would find nothing useful. Skip without inspecting the message.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    // For creates, skip if no content. For edits, always enqueue
    // so stale previews are cleared even when all URLs are removed.
    if (!isEdit && !contentMarkdown) {
      return
    }

    await this.jobQueue.send(JobQueues.LINK_PREVIEW_EXTRACT, {
      workspaceId,
      streamId,
      messageId,
      contentMarkdown,
      contentJson,
      isEdit,
    })

    logger.debug({ messageId, isEdit }, "Link preview extraction job dispatched")
  }
}
