import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import { CursorLock, DebounceWithMaxWait, ensureListenerFromLatest, type ProcessResult } from "@threa/backend-common"
import { OutboxRepository, parseMessagePayload, type OutboxHandler } from "../../../lib/outbox"
import { JobQueues, type QueueManager } from "../../../lib/queue"
import { E2eStreamActorsRepository, E2eStreamsRepository } from "../../e2e-streams"
import { logger } from "../../../lib/logger"

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
 * Dispatches an enclave-invoke job for each user message in an E2E scratchpad
 * that has the enclave actor invited. The mirror image of `CompanionHandler`:
 * companion mode is forced off on E2E streams (Ariadne can't see ciphertext via
 * the normal path), so the enclave path triggers on the invited actor instead.
 * Only user messages enqueue — the persona-authored reply never re-triggers.
 */
export class EnclaveDispatchHandler implements OutboxHandler {
  readonly listenerId = "enclave_dispatch"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager) {
    this.db = db
    this.jobQueue = jobQueue
    this.batchSize = DEFAULT_CONFIG.batchSize
    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })
    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      DEFAULT_CONFIG.debounceMs,
      DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "EnclaveDispatchHandler debouncer error")
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
      if (events.length === 0) return { status: "no_events" }

      const seen: bigint[] = []
      try {
        for (const event of events) {
          if (event.eventType !== "message:created") {
            seen.push(event.id)
            continue
          }
          const payload = parseMessagePayload(event.payload)
          if (!payload) {
            seen.push(event.id)
            continue
          }
          const { streamId, workspaceId, event: messageEvent } = payload

          // Only E2E streams (the inverse of CompanionHandler), and only user
          // turns — a persona/bot message must not trigger a reply loop.
          if (messageEvent.actorType !== AuthorTypes.USER || !messageEvent.actorId) {
            seen.push(event.id)
            continue
          }
          if (!(await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId))) {
            seen.push(event.id)
            continue
          }
          const actors = await E2eStreamActorsRepository.listForStream(this.db, workspaceId, streamId)
          if (!actors.some((a) => a.kind === "enclave")) {
            seen.push(event.id)
            continue
          }

          await this.jobQueue.send(JobQueues.ENCLAVE_INVOKE, {
            workspaceId,
            streamId,
            messageId: messageEvent.payload.messageId,
            triggeredBy: messageEvent.actorId,
          })
          logger.info(
            { workspaceId, streamId, messageId: messageEvent.payload.messageId },
            "Enclave invoke job dispatched"
          )
          seen.push(event.id)
        }
        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        return seen.length > 0 ? { status: "error", error, processedIds: seen } : { status: "error", error }
      }
    })
  }
}
