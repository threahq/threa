import type { AudioProcessJobData, JobHandler } from "../../../lib/queue"
import type { AudioProcessingServiceLike } from "./service"

export interface AudioProcessWorkerDeps {
  audioProcessingService: AudioProcessingServiceLike
}

export function createAudioProcessWorker(deps: AudioProcessWorkerDeps): JobHandler<AudioProcessJobData> {
  return async (job) => {
    await deps.audioProcessingService.process(job.data.workspaceId, job.data.attachmentId)
  }
}
