import { JobQueues, type VideoTranscodeSubmitJobData, type JobHandler } from "../../../lib/queue"
import type { QueueManager } from "../../../lib/queue"
import type { VideoTranscodingServiceLike } from "./service"
import { VIDEO_TRANSCODE_CHECK_DELAY_MS } from "./config"
import { logger } from "../../../lib/logger"

export interface VideoTranscodeSubmitWorkerDeps {
  videoTranscodingService: VideoTranscodingServiceLike
  jobQueue: QueueManager
}

/**
 * Thin worker that submits a video for transcoding, then enqueues the first status check.
 */
export function createVideoTranscodeSubmitWorker(
  deps: VideoTranscodeSubmitWorkerDeps
): JobHandler<VideoTranscodeSubmitJobData> {
  const { videoTranscodingService, jobQueue } = deps

  return async (job) => {
    const { attachmentId, workspaceId, filename } = job.data

    logger.info({ jobId: job.id, attachmentId, filename }, "Submitting video transcode job")

    await videoTranscodingService.submit(attachmentId)

    await jobQueue.send(
      JobQueues.VIDEO_TRANSCODE_CHECK,
      { attachmentId, workspaceId },
      { processAfter: new Date(Date.now() + VIDEO_TRANSCODE_CHECK_DELAY_MS) }
    )

    logger.info({ jobId: job.id, attachmentId }, "Video transcode submit job completed")
  }
}
