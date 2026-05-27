import type { Pool } from "pg"
import { OutboxRepository } from "../../lib/outbox"
import { parseMessagePayload } from "../../lib/outbox"
import { AuthorTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export interface BoundaryExtractionHandlerConfig {
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
 * Handler that dispatches jobs for messages to detect conversational boundaries.
 *
 * Flow:
 * 1. Message arrives (via outbox)
 * 2. Check if it's a user message (persona messages can be added later)
 * 3. Dispatch queue job for LLM processing
 */
export class BoundaryExtractionHandler implements OutboxHandler {
  readonly listenerId = "boundary-extraction"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: BoundaryExtractionHandlerConfig) {
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "BoundaryExtractionHandler debouncer error")
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
          if (event.eventType !== "message:created") {
            seen.push(event.id)
            continue
          }

          const payload = parseMessagePayload(event.payload)
          if (!payload) {
            logger.debug({ eventId: event.id.toString() }, "BoundaryExtractionHandler: malformed event, skipping")
            seen.push(event.id)
            continue
          }

          const { streamId, workspaceId, event: messageEvent } = payload

          // E2E streams: boundary extraction inspects message content, which
          // is ciphertext on E2E streams and useless to the LLM.
          if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
            seen.push(event.id)
            continue
          }

          if (messageEvent.actorType !== AuthorTypes.USER) {
            seen.push(event.id)
            continue
          }

          logger.debug({ streamId, messageId: messageEvent.payload.messageId }, "Boundary extraction job dispatched")

          await this.jobQueue.send(JobQueues.BOUNDARY_EXTRACT, {
            messageId: messageEvent.payload.messageId,
            streamId,
            workspaceId,
          })

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
