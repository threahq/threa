import { logger } from "@threa/backend-common"
import type { Job, JobHandler, QueueManager } from "../../lib/queue"
import { JobQueues } from "../../lib/queue"
import type { GithubPreviewRefreshJobData } from "../../lib/queue/job-queue"
import { refreshLinkPreview, type RefreshLinkPreviewDeps } from "../link-previews"

const log = logger.child({ module: "github-preview-refresh" })

/**
 * Small buffer added past the debounce window so the trailing job lands just
 * after the window clears rather than racing its boundary.
 */
const TRAILING_REFRESH_BUFFER_MS = 500

export interface GithubPreviewRefreshDeps extends RefreshLinkPreviewDeps {
  jobQueue: Pick<QueueManager, "send">
}

/**
 * Deterministic queue-message id for a trailing refresh. Keyed on the preview's
 * current `fetchedAt` so every debounced delivery in one storm produces the SAME
 * id (they all observe the same `fetchedAt` until a refresh actually lands) and
 * collapses into one job via `send`'s messageId dedupe. Once the trailing job
 * refreshes the row, `fetchedAt` advances, so the next reschedule (and any later
 * storm) gets a fresh id — a completed/in-flight row from the previous window
 * never blocks it.
 */
export function githubPreviewRefreshQueueId(previewId: string, fetchedAt: Date): string {
  return `queue_ghprev_${previewId}_${fetchedAt.getTime()}`
}

/**
 * Force-refresh a GitHub link preview and, if the refresh is dropped as debounced
 * (a webhook storm already refreshed it inside the window), schedule ONE trailing
 * refresh so the newest state isn't lost. Shared by the webhook worker (which sees
 * the first debounced result) and the trailing worker itself (which reschedules if
 * it debounces again), so the coalescing lives on a single path (INV-35).
 */
export async function refreshGithubPreviewWithTrailing(
  deps: GithubPreviewRefreshDeps,
  params: { workspaceId: string; previewId: string }
): Promise<void> {
  const result = await refreshLinkPreview(deps, params)
  if (result.refreshed || result.reason !== "debounced") return

  const processAfter = new Date(Date.now() + result.retryAfterMs + TRAILING_REFRESH_BUFFER_MS)
  const messageId = githubPreviewRefreshQueueId(params.previewId, result.fetchedAt)

  await deps.jobQueue.send(
    JobQueues.GITHUB_PREVIEW_REFRESH,
    { workspaceId: params.workspaceId, previewId: params.previewId },
    { processAfter, messageId }
  )
  log.debug({ ...params, messageId, processAfter }, "Scheduled trailing GitHub preview refresh (debounced)")
}

/**
 * Worker for the trailing refresh job. Re-runs the coalescing refresh: on a
 * successful refresh it completes; if it debounces again it reschedules once more
 * on the fresh `fetchedAt`, converging once the storm ends.
 */
export function createGithubPreviewRefreshWorker(
  deps: GithubPreviewRefreshDeps
): JobHandler<GithubPreviewRefreshJobData> {
  return async (job: Job<GithubPreviewRefreshJobData>) => {
    await refreshGithubPreviewWithTrailing(deps, {
      workspaceId: job.data.workspaceId,
      previewId: job.data.previewId,
    })
  }
}
