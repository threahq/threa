import type { Pool } from "pg"
import { OutboxRepository, parseMessagePayload } from "../../lib/outbox"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import { logger } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

const LINK_PREVIEW_EVENT_TYPES = new Set(["message:created", "message:edited"])

export interface LinkPreviewHandlerConfig {
  batchSize?: number
  debounceMs?: number
  maxWaitMs?: number
  lockDurationMs?: number
  refreshIntervalMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

/**
 * Outbox handler that dispatches link preview extraction jobs
 * when messages are created or edited.
 */
export class LinkPreviewOutboxHandler implements OutboxHandler {
  readonly listenerId = "link_preview"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: LinkPreviewHandlerConfig) {
    this.db = db
    this.jobQueue = jobQueue
    this.batchSize = config?.batchSize ?? DEFAULT_CONFIG.batchSize

    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: config?.lockDurationMs ?? DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: config?.refreshIntervalMs ?? DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: config?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: config?.baseBackoffMs ?? DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })

    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      config?.debounceMs ?? DEFAULT_CONFIG.debounceMs,
      config?.maxWaitMs ?? DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "LinkPreviewOutboxHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  handle(): void {
    this.debouncer.trigger()
  }

  private async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.db, cursor, this.batchSize, processedIds)

      if (events.length === 0) {
        return { status: "no_events" }
      }

      const seen: bigint[] = []

      try {
        for (const event of events) {
          if (!LINK_PREVIEW_EVENT_TYPES.has(event.eventType)) {
            seen.push(event.id)
            continue
          }

          const payload = parseMessagePayload(event.payload)
          if (!payload) {
            seen.push(event.id)
            continue
          }

          const isEdit = event.eventType === "message:edited"
          const { workspaceId, streamId, event: messageEvent } = payload
          const { messageId, contentMarkdown } = messageEvent.payload

          // E2E streams: contentMarkdown is ciphertext, so the URL scanner
          // would find nothing useful. Skip without inspecting the message.
          if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
            seen.push(event.id)
            continue
          }

          // For creates, skip if no content. For edits, always enqueue
          // so stale previews are cleared even when all URLs are removed.
          if (!isEdit && !contentMarkdown) {
            seen.push(event.id)
            continue
          }

          await this.jobQueue.send(JobQueues.LINK_PREVIEW_EXTRACT, {
            workspaceId,
            streamId,
            messageId,
            contentMarkdown,
            isEdit,
          })

          logger.debug({ messageId, isEdit }, "Link preview extraction job dispatched")
          seen.push(event.id)
        }

        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (seen.length > 0) {
          return { status: "error", error, processedIds: seen }
        }
        return { status: "error", error }
      }
    })
  }
}
