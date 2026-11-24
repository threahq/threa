import type { OnDLQHook, VideoStoryboardJobData } from "../../../lib/queue"
import { VideoStoryboardRepository } from "./repository"

export function createVideoStoryboardOnDLQ(): OnDLQHook<VideoStoryboardJobData> {
  return async (querier, job, error) => {
    await VideoStoryboardRepository.markFailed(querier, job.data.workspaceId, job.data.attachmentId, error.message)
  }
}
