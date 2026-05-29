import type { Pool } from "pg"
import { JobQueues, type JobHandler, type MemoBatchCheckJobData, type MemoBatchProcessJobData } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { StreamStateRepository } from "../streams"
import type { MemoServiceLike } from "./service"
import { logger } from "../../lib/logger"

const BATCH_CAP_INTERVAL_SECONDS = 300 // 5 minutes
const BATCH_QUIET_INTERVAL_SECONDS = 30 // 30 seconds

export interface MemoBatchWorkerDeps {
  pool: Pool
  memoService: MemoServiceLike
  jobQueue: QueueManager
}

/**
 * Create the memo batch check job handler.
 *
 * This runs on a schedule (every 30s) and checks which streams have
 * pending items ready to process based on debounce logic:
 * - Cap: process at most every 5 minutes per stream
 * - Quick: process after 30s quiet per stream
 *
 * For each stream ready, it dispatches a batch process job.
 */
export function createMemoBatchCheckWorker(deps: MemoBatchWorkerDeps): JobHandler<MemoBatchCheckJobData> {
  const { pool, jobQueue } = deps

  return async (job) => {
    logger.debug({ jobId: job.id }, "Checking for streams ready for memo processing")

    // Single query, INV-30
    const streamsToProcess = await StreamStateRepository.findStreamsReadyToProcess(pool, {
      capIntervalSeconds: BATCH_CAP_INTERVAL_SECONDS,
      quietIntervalSeconds: BATCH_QUIET_INTERVAL_SECONDS,
    })

    if (streamsToProcess.length === 0) {
      logger.debug({ jobId: job.id }, "No streams ready for memo processing")
      return
    }

    logger.info({ jobId: job.id, streamCount: streamsToProcess.length }, "Dispatching memo batch process jobs")

    for (const { workspaceId, streamId } of streamsToProcess) {
      await jobQueue.send(JobQueues.MEMO_BATCH_PROCESS, { workspaceId, streamId })
    }
  }
}

/**
 * Create the memo batch process job handler.
 *
 * This processes all pending items for a specific stream.
 */
export function createMemoBatchProcessWorker(deps: MemoBatchWorkerDeps): JobHandler<MemoBatchProcessJobData> {
  const { memoService } = deps

  return async (job) => {
    const { workspaceId, streamId } = job.data

    logger.info({ jobId: job.id, workspaceId, streamId }, "Processing memo batch")

    const result = await memoService.processBatch(workspaceId, streamId)

    logger.info(
      {
        jobId: job.id,
        workspaceId,
        streamId,
        processed: result.processed,
        memosCreated: result.memosCreated,
      },
      "Memo batch processing completed"
    )
  }
}

// scheduleMemoBatchCheck moved to server.ts - uses QueueManager.schedule()
