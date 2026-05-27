import type { Pool } from "pg"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository } from "./repository"
import { parseMessagePayload } from "../../lib/outbox"
import { needsAutoNaming } from "./display-name"
import { logger } from "../../lib/logger"
import { AuthorTypes } from "@threa/types"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export interface NamingHandlerConfig {
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
 * Handler that dispatches auto-naming jobs for messages in streams
 * that need display name generation.
 *
 * Triggers LLM processing for:
 * - Scratchpads without a generated name
 * - Threads without a generated name
 *
 * Uses time-based cursor locking for exclusive access without
 * holding database connections during processing.
 */
export class NamingHandler implements OutboxHandler {
  readonly listenerId = "naming"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: NamingHandlerConfig) {
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "NamingHandler debouncer error")
    )
  }

  /**
   * Ensures the listener exists in the database.
   * Call this during startup before registering with the dispatcher.
   */
  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  /**
   * Called by OutboxDispatcher on notification.
   * Debounces rapid notifications and processes events.
   */
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
            logger.debug({ eventId: event.id.toString() }, "NamingHandler: malformed event, skipping")
            seen.push(event.id)
            continue
          }

          const { streamId, workspaceId, event: messageEvent } = payload
          const isAgentMessage = messageEvent.actorType !== AuthorTypes.USER

          // E2E streams: auto-naming reads message content which is ciphertext
          // on E2E streams. The client picks a name locally instead.
          if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
            seen.push(event.id)
            continue
          }

          const stream = await StreamRepository.findById(this.db, streamId)
          if (!stream) {
            logger.warn({ streamId }, "NamingHandler: stream not found")
            seen.push(event.id)
            continue
          }

          if (!needsAutoNaming(stream)) {
            seen.push(event.id)
            continue
          }

          await this.jobQueue.send(JobQueues.NAMING_GENERATE, {
            workspaceId: stream.workspaceId,
            streamId,
            requireName: isAgentMessage,
          })

          logger.info({ streamId, requireName: isAgentMessage }, "Naming job dispatched")
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
