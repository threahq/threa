import type { JobHandler, StreamConnectionProfilesJobData } from "../../lib/queue"
import type { StreamConnectionProfileService } from "./profiles"

export function createStreamConnectionProfilesWorker(deps: {
  streamConnectionProfileService: StreamConnectionProfileService
}): JobHandler<StreamConnectionProfilesJobData> {
  return async (job) => {
    await deps.streamConnectionProfileService.refresh(job.data)
  }
}
