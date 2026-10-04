import type { JobHandler, StreamConnectionPullJobData } from "../../lib/queue"
import type { StreamConnectionPullService } from "./pull"

export function createStreamConnectionPullWorker(deps: {
  streamConnectionPullService: StreamConnectionPullService
}): JobHandler<StreamConnectionPullJobData> {
  return async (job) => {
    await deps.streamConnectionPullService.pull(job.data)
  }
}
