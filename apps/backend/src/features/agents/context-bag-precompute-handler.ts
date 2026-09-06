import type { Pool } from "pg"
import { isOneOfOutboxEventType } from "../../lib/outbox"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import type { QueueManager, ContextBagPrecomputeJobData } from "../../lib/queue"
import { JobQueues, type JobHandler } from "../../lib/queue"
import type { AI } from "@threahq/agent-runtime"
import { CompanionModes, StreamTypes } from "@threahq/types"
import { logger } from "../../lib/logger"
import { StreamRepository } from "../streams"
import { ContextBagRepository, persistSnapshot, resolveBagForStream } from "./context-bag"

export type ContextBagPrecomputeHandlerConfig = DebouncedOutboxHandlerConfig

// Smaller batch + slightly longer max-wait than the canonical defaults:
// stream:created bursts are bursty and each event does a stream lookup.
const HANDLER_CONFIG: DebouncedOutboxHandlerConfig = {
  batchSize: 50,
  maxWaitMs: 250,
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
export class ContextBagPrecomputeHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: ContextBagPrecomputeHandlerConfig) {
    super(db, { listenerId: "context-bag-precompute", ...HANDLER_CONFIG, ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!isOneOfOutboxEventType(event, ["stream:created"])) {
      return
    }

    const { workspaceId, streamId, stream } = event.payload
    if (stream.type !== StreamTypes.SCRATCHPAD && stream.type !== StreamTypes.ASIDE) {
      return
    }
    if (stream.companionMode !== CompanionModes.ON) {
      return
    }

    const bag = await ContextBagRepository.findByStream(this.db, workspaceId, streamId)
    if (!bag) {
      return
    }

    await this.jobQueue.send(CONTEXT_BAG_PRECOMPUTE_QUEUE, {
      workspaceId,
      streamId,
      bagId: bag.id,
    })
    logger.info({ streamId, bagId: bag.id }, "context-bag precompute job dispatched")
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
