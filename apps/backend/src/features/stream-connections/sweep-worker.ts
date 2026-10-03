import type { JobHandler, StreamConnectionSweepJobData } from "../../lib/queue"
import type { StreamConnectionImportService } from "./import"

export function createStreamConnectionSweepWorker(deps: {
  streamConnectionImportService: StreamConnectionImportService
}): JobHandler<StreamConnectionSweepJobData> {
  return async () => {
    await deps.streamConnectionImportService.enqueueAllPulls()
  }
}
