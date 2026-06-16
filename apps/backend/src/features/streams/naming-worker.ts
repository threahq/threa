import type { NamingJobData, JobHandler } from "../../lib/queue"
import { logger } from "../../lib/logger"

export interface StreamNamingServiceLike {
  attemptAutoNaming(streamId: string, requireName: boolean): Promise<boolean>
}

export interface NamingWorkerDeps {
  streamNamingService: StreamNamingServiceLike
}

export function createNamingWorker(deps: NamingWorkerDeps): JobHandler<NamingJobData> {
  const { streamNamingService } = deps

  return async (job) => {
    const { streamId, requireName } = job.data

    logger.info({ jobId: job.id, streamId, requireName }, "Processing naming job")

    const named = await streamNamingService.attemptAutoNaming(streamId, requireName)

    logger.info({ jobId: job.id, streamId, requireName, named }, "Naming job completed")
  }
}
