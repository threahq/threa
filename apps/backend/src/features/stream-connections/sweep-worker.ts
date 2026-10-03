import type { JobHandler, StreamConnectionSweepJobData } from "../../lib/queue"
import type { StreamConnectionImportService } from "./import"

/** The longest a change waits when its poke is lost. */
export const STREAM_CONNECTION_SWEEP_INTERVAL_SECONDS = 300

export function createStreamConnectionSweepWorker(deps: {
  streamConnectionImportService: StreamConnectionImportService
}): JobHandler<StreamConnectionSweepJobData> {
  return async () => {
    await deps.streamConnectionImportService.enqueueAllPulls()
  }
}
