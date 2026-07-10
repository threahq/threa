import type { JobHandler, AgentReflectiveCaptureJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { ReflectiveCaptureService } from "./reflective-capture-service"

/**
 * Worker handler for `agent.reflective_capture` (roadmap 6.3). Delegates to the
 * service's idempotent `capture`; the worker holds no DB connection between calls
 * (INV-41). A redelivered job for an already-captured session no-ops via the
 * `reflective_captured_at` CAS.
 */
export function createReflectiveCaptureWorker(deps: {
  reflectiveCaptureService: ReflectiveCaptureService
}): JobHandler<AgentReflectiveCaptureJobData> {
  return async (job) => {
    const { workspaceId, sessionId } = job.data
    const result = await deps.reflectiveCaptureService.capture({ workspaceId, sessionId })
    logger.debug(
      { jobId: job.id, workspaceId, sessionId, captured: result.captured },
      "reflective capture job processed"
    )
  }
}
