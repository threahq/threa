import type { EnclavePersonaAgentJobData, JobHandler } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { EnclaveDispatcher } from "./enclave-dispatcher"

/**
 * Thin queue adapter for the enclave persona dispatcher (INV-34). All
 * orchestration lives in `EnclaveDispatcher.runJob`; this just unpacks the
 * job data and surfaces failures back to the queue for retry.
 */
export function createEnclaveDispatcherWorker(dispatcher: EnclaveDispatcher): JobHandler<EnclavePersonaAgentJobData> {
  return async (job) => {
    logger.info(
      {
        jobId: job.id,
        streamId: job.data.streamId,
        messageId: job.data.messageId,
        personaId: job.data.personaId,
      },
      "Processing enclave persona agent job"
    )
    await dispatcher.runJob(job.data)
  }
}
