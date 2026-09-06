import { logger } from "@threahq/backend-common"
import { GITHUB_PREVIEW_TYPES } from "@threahq/types"
import type { Job, JobHandler, QueueManager } from "../../lib/queue"
import { JobQueues } from "../../lib/queue"
import type { LinkPreviewVisibleRefreshJobData } from "../../lib/queue/job-queue"
import { refreshLinkPreview, type RefreshLinkPreviewDeps } from "./refresh"

const log = logger.child({ module: "link-preview-visible-refresh" })

/**
 * Debounce for viewport-nudged refreshes. Deliberately longer than the webhook
 * path's 10s: a webhook KNOWS something changed, a visible card is speculative.
 * With the ETag gate a nudge that passes this window and finds nothing new
 * costs no rate limit (304), so the window prices only the gate round-trip.
 */
export const VISIBLE_REFRESH_DEBOUNCE_MS = 15_000

/** Per-frame id cap: one viewport of preview cards, with headroom. */
export const VISIBLE_REFRESH_MAX_IDS = 50

/**
 * Per-connection floor between accepted `previews:visible` frames. Clients
 * flush on a slower cadence, so a compliant client never trips this; it only
 * bounds how fast a hostile socket can make us enqueue.
 */
export const VISIBLE_REPORT_MIN_INTERVAL_MS = 5_000

/**
 * Provider preview types the viewport nudge may refresh. Opt-in by design: a
 * type belongs here only when its refresh path is conditional-fetch aware, so
 * a nudge for anything else is dropped instead of burning provider quota.
 */
const VISIBLE_REFRESHABLE_PREVIEW_TYPES: ReadonlySet<string> = new Set(GITHUB_PREVIEW_TYPES)

/**
 * Deterministic queue-message id, keyed on the debounce-window time bucket so
 * every nudge for one preview within one window — across sockets, users, and
 * replicas — collapses into a single job via `send`'s messageId dedupe. The
 * next window gets a fresh bucket, so a persisted completed row never blocks a
 * later nudge.
 */
export function visibleRefreshQueueId(previewId: string, nowMs: number): string {
  return `queue_lpviz_${previewId}_b${Math.floor(nowMs / VISIBLE_REFRESH_DEBOUNCE_MS)}`
}

/**
 * Fan a client's visible-preview report into per-preview refresh jobs.
 * Same-window duplicates collapse inside `send` (idempotent message-id insert);
 * any other enqueue failure is only logged — the next viewport pass re-nudges.
 */
export async function enqueueVisiblePreviewRefreshes(
  jobQueue: Pick<QueueManager, "send">,
  workspaceId: string,
  previewIds: string[]
): Promise<void> {
  const now = Date.now()
  await Promise.all(
    previewIds.map(async (previewId) => {
      try {
        await jobQueue.send(
          JobQueues.LINK_PREVIEW_VISIBLE_REFRESH,
          { workspaceId, previewId },
          { messageId: visibleRefreshQueueId(previewId, now) }
        )
      } catch (error) {
        log.debug({ err: error, workspaceId, previewId }, "Failed to enqueue visible preview refresh; dropping")
      }
    })
  )
}

/**
 * Worker for viewport-nudged refreshes: conditional (ETag-gated) refresh of one
 * preview. Every non-refreshed outcome is terminal — `not_modified` and
 * `debounced` are the expected steady states, and transient failures are not
 * retried because the nudge source (a user looking at the card) re-fires.
 */
export function createLinkPreviewVisibleRefreshWorker(
  deps: RefreshLinkPreviewDeps
): JobHandler<LinkPreviewVisibleRefreshJobData> {
  return async (job: Job<LinkPreviewVisibleRefreshJobData>) => {
    const { workspaceId, previewId } = job.data

    const preview = await deps.linkPreviewService.getPreviewById(workspaceId, previewId)
    if (!preview || preview.status !== "completed") return
    if (!preview.previewType || !VISIBLE_REFRESHABLE_PREVIEW_TYPES.has(preview.previewType)) return

    const result = await refreshLinkPreview(deps, {
      workspaceId,
      previewId,
      debounceMs: VISIBLE_REFRESH_DEBOUNCE_MS,
      conditional: true,
    })
    log.debug(
      { workspaceId, previewId, refreshed: result.refreshed },
      `Visible preview refresh ${result.refreshed ? "applied" : `skipped (${result.reason})`}`
    )
  }
}
