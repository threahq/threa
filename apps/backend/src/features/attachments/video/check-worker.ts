import { JobQueues, type VideoTranscodeCheckJobData, type JobHandler } from "../../../lib/queue"
import type { QueueManager } from "../../../lib/queue"
import type { VideoTranscodingServiceLike } from "./service"
import { VIDEO_TRANSCODE_CHECK_DELAY_MS } from "./config"
import { logger } from "../../../lib/logger"

export interface VideoTranscodeCheckWorkerDeps {
  videoTranscodingService: VideoTranscodingServiceLike
  jobQueue: QueueManager
}

/**
 * Thin worker that polls MediaConvert for transcode status.
 * Re-enqueues itself with a delay if the job is still in progress.
 */
export function createVideoTranscodeCheckWorker(
  deps: VideoTranscodeCheckWorkerDeps
): JobHandler<VideoTranscodeCheckJobData> {
  const { videoTranscodingService, jobQueue } = deps

  return async (job) => {
    const { attachmentId, workspaceId } = job.data

    logger.debug({ jobId: job.id, attachmentId }, "Checking video transcode status")

    const done = await videoTranscodingService.checkStatus(attachmentId)

    if (!done) {
      await jobQueue.send(
        JobQueues.VIDEO_TRANSCODE_CHECK,
        { attachmentId, workspaceId },
        { processAfter: new Date(Date.now() + VIDEO_TRANSCODE_CHECK_DELAY_MS) }
      )
      logger.debug({ jobId: job.id, attachmentId }, "Transcode still in progress, re-enqueued check")
    } else {
      logger.info({ jobId: job.id, attachmentId }, "Video transcode check completed (terminal state)")
    }
  }
}
