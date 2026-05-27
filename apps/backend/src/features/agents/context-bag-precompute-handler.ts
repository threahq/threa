import type { Pool } from "pg"
import type { OutboxHandler } from "../../lib/outbox"
import { OutboxRepository, isOneOfOutboxEventType } from "../../lib/outbox"
import type { QueueManager, ContextBagPrecomputeJobData } from "../../lib/queue"
import { JobQueues, type JobHandler } from "../../lib/queue"
import type { AI } from "@threa/agent-runtime"
import { CompanionModes, StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { StreamRepository } from "../streams"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import { ContextBagRepository, persistSnapshot, resolveBagForStream } from "./context-bag"

export interface ContextBagPrecomputeHandlerConfig {
  batchSize?: number
  debounceMs?: number
  maxWaitMs?: number
  lockDurationMs?: number
  refreshIntervalMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

const DEFAULT_CONFIG = {
  batchSize: 50,
  debounceMs: 50,
  maxWaitMs: 250,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

export const CONTEXT_BAG_PRECOMPUTE_QUEUE = JobQueues.CONTEXT_BAG_PRECOMPUTE

/**
 * Outbox handler: listens for stream:created events and dispatches a
 * pre-compute job when the newly-created scratchpad has a context bag +
 * companion mode on. The job warms the shared `context_summaries` cache and
 * writes the initial `last_rendered` snapshot so the first real user turn's
 * diff is correctly anchored. No kickoff message is posted — Ariadne stays
 * silent until the user sends their first message.
 */
export class ContextBagPrecomputeHandler implements OutboxHandler {
  readonly listenerId = "context-bag-precompute"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: ContextBagPrecomputeHandlerConfig) {
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "ContextBagPrecomputeHandler debouncer error")
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
          if (!isOneOfOutboxEventType(event, ["stream:created"])) {
            seen.push(event.id)
            continue
          }

          const { workspaceId, streamId, stream } = event.payload
          if (stream.type !== StreamTypes.SCRATCHPAD) {
            seen.push(event.id)
            continue
          }
          if (stream.companionMode !== CompanionModes.ON) {
            seen.push(event.id)
            continue
          }

          const bag = await ContextBagRepository.findByStream(this.db, workspaceId, streamId)
          if (!bag) {
            seen.push(event.id)
            continue
          }

          await this.jobQueue.send(CONTEXT_BAG_PRECOMPUTE_QUEUE, {
            workspaceId,
            streamId,
            bagId: bag.id,
          })
          logger.info({ streamId, bagId: bag.id }, "context-bag precompute job dispatched")
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

export interface ContextBagPrecomputeWorkerDeps {
  pool: Pool
  ai: AI
}

/**
 * Pre-compute worker: warms the shared summary cache and persists the initial
 * render snapshot for a newly-created bag-attached scratchpad. Posts no
 * message, holds no companion-session slot, takes no persona dependency.
 *
 * Idempotency: `resolveBagForStream({ skipIfAlreadyRendered: true })` short-
 * circuits when `last_rendered` is already populated, so retries after a
 * successful run are no-ops. The summary write is `ON CONFLICT DO NOTHING`
 * on the fingerprint key (INV-20) so concurrent runs against the same bag
 * don't clobber each other. `persistSnapshot` is an idempotent UPDATE.
 *
 * Connection lifecycle (INV-41): `resolveBagForStream` releases the DB
 * connection before any AI summarization call runs, and opens a fresh
 * connection for the final snapshot write.
 */
export function createContextBagPrecomputeWorker(
  deps: ContextBagPrecomputeWorkerDeps
): JobHandler<ContextBagPrecomputeJobData> {
  const { pool, ai } = deps

  return async (job) => {
    const { workspaceId, streamId, bagId } = job.data
    logger.info({ jobId: job.id, streamId, bagId }, "Processing context-bag precompute job")

    const stream = await StreamRepository.findById(pool, streamId)
    if (!stream || stream.workspaceId !== workspaceId) {
      logger.warn({ streamId }, "context-bag precompute: stream missing, skipping")
      return
    }

    const resolved = await resolveBagForStream({ pool, ai, costContext: { workspaceId, origin: "system" } }, streamId, {
      skipIfAlreadyRendered: true,
    })
    if (!resolved) {
      logger.info({ streamId, bagId }, "context-bag precompute: already rendered, skipping")
      return
    }

    await persistSnapshot(pool, workspaceId, resolved.bagId, resolved.nextSnapshot)
    logger.info({ streamId, bagId: resolved.bagId }, "context-bag precompute: summary warmed + snapshot persisted")
  }
}
