import type { JobHandler, AgentEpisodeSummarizeJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { EpisodeSummaryService } from "./episode-summary-service"

/**
 * Worker handler for `agent.episode_summarize` (roadmap 3.1). Delegates to the
 * service's idempotent `summarize`; the worker holds no DB connection between
 * calls (INV-41). A redelivered job for an already-summarized session no-ops via
 * the `setEpisodeSummary` CAS.
 */
export function createEpisodeSummarizeWorker(deps: {
  episodeSummaryService: EpisodeSummaryService
}): JobHandler<AgentEpisodeSummarizeJobData> {
  return async (job) => {
    const { workspaceId, sessionId } = job.data
    const result = await deps.episodeSummaryService.summarize({ workspaceId, sessionId })
    logger.debug({ jobId: job.id, workspaceId, sessionId, written: result.written }, "episode summary job processed")
  }
}
