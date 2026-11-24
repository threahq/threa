import type { JobHandler, VideoStoryboardJobData } from "../../../lib/queue"
import type { VideoStoryboardService } from "./service"

export interface VideoStoryboardWorkerDeps {
  videoStoryboardService: VideoStoryboardService
}

export function createVideoStoryboardWorker(deps: VideoStoryboardWorkerDeps): JobHandler<VideoStoryboardJobData> {
  return async (job) => {
    await deps.videoStoryboardService.process(job.data.workspaceId, job.data.attachmentId)
  }
}
