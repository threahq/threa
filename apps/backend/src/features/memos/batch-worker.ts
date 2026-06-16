import type { Pool } from "pg"
import { JobQueues, type JobHandler, type MemoBatchCheckJobData, type MemoBatchProcessJobData } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { StreamStateRepository } from "../streams"
import type { MemoServiceLike } from "./service"
import { logger } from "../../lib/logger"

const BATCH_CAP_INTERVAL_SECONDS = 300
const BATCH_QUIET_INTERVAL_SECONDS = 30

export interface MemoBatchWorkerDeps {
  pool: Pool
  memoService: MemoServiceLike
  jobQueue: QueueManager
}

/**
 * Per-stream debounce: process at most every cap interval, or after a quiet
 * interval of no new items. Dispatches a batch process job per ready stream.
 */
export function createMemoBatchCheckWorker(deps: MemoBatchWorkerDeps): JobHandler<MemoBatchCheckJobData> {
  const { pool, jobQueue } = deps

  return async (job) => {
    logger.debug({ jobId: job.id }, "Checking for streams ready for memo processing")

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
