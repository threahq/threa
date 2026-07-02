import type { JobHandler, AgentFollowUpFireJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { AgentFollowUpService } from "./follow-up-service"

/**
 * Worker handler for `agent.follow_up_fire`. Delegates to the service's
 * idempotent `fire`; the worker holds no DB connection between calls (INV-41).
 * The service CASes `pending → fired` and enqueues the persona turn atomically,
 * so a cancelled row (or a duplicate delivery) simply no-ops.
 */
export function createAgentFollowUpFireWorker(deps: {
  agentFollowUpService: AgentFollowUpService
}): JobHandler<AgentFollowUpFireJobData> {
  return async (job) => {
    const { workspaceId, followUpId } = job.data
    const result = await deps.agentFollowUpService.fire({ workspaceId, followUpId })
    logger.debug({ jobId: job.id, workspaceId, followUpId, fired: result.fired }, "agent follow-up fire processed")
  }
}

export { AgentFollowUpService }
