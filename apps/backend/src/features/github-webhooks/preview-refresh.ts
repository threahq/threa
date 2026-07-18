import { logger } from "@threa/backend-common"
import type { Job, JobHandler, QueueManager } from "../../lib/queue"
import { JobQueues } from "../../lib/queue"
import type { GithubPreviewRefreshJobData } from "../../lib/queue/job-queue"
import { DEFAULT_REFRESH_DEBOUNCE_MS, refreshLinkPreview, type RefreshLinkPreviewDeps } from "../link-previews"

const log = logger.child({ module: "github-preview-refresh" })

/**
 * Small buffer added past the debounce window so the trailing job lands just
 * after the window clears rather than racing its boundary.
 */
const TRAILING_REFRESH_BUFFER_MS = 500

/**
 * Growing backoff for retrying a `fetch_empty` refresh (GitHub 5xx / timeout, or
 * the rate-limit breaker window). Indexed by the CURRENT attempt count, so the
 * first retry waits 30s, then 2m, then 10m. Its length is the retry cap.
 */
const FETCH_EMPTY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const
/** Coalesces a webhook storm, while a cycle exhausted after 12.5m always enters a later bucket. */
const FETCH_EMPTY_RETRY_CYCLE_MS = 10 * 60_000

export interface GithubPreviewRefreshDeps extends RefreshLinkPreviewDeps {
  jobQueue: Pick<QueueManager, "send">
}

/**
 * Deterministic queue-message id for a trailing refresh. Keyed on the preview's
 * current `refreshVersion` so every debounced delivery in one storm produces the
 * SAME id (they all observe the same version until a refresh actually lands) and
 * collapses into one job via `send`'s messageId dedupe. Once any write advances
 * the version, the next reschedule (and any later storm) gets a fresh id — a
 * completed/in-flight row from the previous window never blocks it.
 *
 * `hop` is 0 for the bare `_vN` id webhook-side senders use to coalesce; a trailing
 * worker that re-debounces at an unchanged version reschedules with hop+1 so the
 * suffixed id (`_vN_h1`, …) can't pkey-dedupe against the row the trailing job
 * itself already claimed when it runs on a replica behind the scheduler's clock.
 */
export function githubPreviewRefreshQueueId(previewId: string, refreshVersion: number, hop = 0): string {
  const base = `queue_ghprev_${previewId}_v${refreshVersion}`
  return hop > 0 ? `${base}_h${hop}` : base
}

/**
 * Hard cap on trailing debounce hops. Each hop reschedules ~one debounce window
 * later, so a chain this long means a real refresh landed within the window that
 * many times running (the card is fresh) — and any new webhook delivery restarts a
 * fresh bare-id chain regardless — so stopping here can't permanently drop an
 * update; it only bounds a clock-skew self-reschedule loop.
 */
const MAX_TRAILING_HOPS = 5

/**
 * Deterministic queue-message id for one `fetch_empty` retry cycle. The cycle id
 * stays stable across its bounded attempts, but a later webhook starts a fresh
 * cycle even when no successful write advanced `refreshVersion`; otherwise its
 * attempt ids would collide with completed rows from the exhausted prior cycle.
 */
export function githubPreviewRefreshRetryQueueId(
  previewId: string,
  refreshVersion: number,
  retryCycleId: string,
  attempt: number
): string {
  return `queue_ghprev_retry_${previewId}_v${refreshVersion}_${retryCycleId}_${attempt}`
}

/**
 * Force-refresh a GitHub link preview (compare-and-set against the pre-fetch
 * `fetched_at`) and reschedule ONE trailing refresh when the newest state would
 * otherwise be lost:
 * - `debounced` / `conflict`: a concurrent refresh already touched the row, so
 *   coalesce on its `fetchedAt` — every storm delivery observing the same value
 *   collapses to one job that converges once the storm ends.
 * - `fetch_empty`: the fetch failed transiently (GitHub 5xx / timeout / rate-limit
 *   breaker) and `fetched_at` did NOT advance, so with no TTL refresh for untouched
 *   messages the webhook signal would be dropped forever. Retry on a growing
 *   backoff up to a hard cap (keyed on version + retry cycle + attempt), then
 *   give up with a warn.
 *
 * Shared by the webhook worker and the trailing worker itself, so the coalescing
 * and retry logic live on a single path (INV-35).
 */
export async function refreshGithubPreviewWithTrailing(
  deps: GithubPreviewRefreshDeps,
  params: {
    workspaceId: string
    previewId: string
    attempt?: number
    retryCycleId?: string
    /** Hop count of the CURRENTLY-running job; only the trailing worker sets it. */
    hop?: number
    /** True when invoked from the trailing worker, so a re-debounce bumps the hop. */
    isTrailing?: boolean
  }
): Promise<void> {
  const { workspaceId, previewId } = params
  const result = await refreshLinkPreview(deps, { workspaceId, previewId })
  if (result.refreshed || result.reason === "not_found") return
  // Conditional-mode-only outcome; this path never passes `conditional`, the
  // check just narrows the union for the branches below.
  if (result.reason === "not_modified") return

  if (result.reason === "debounced" || result.reason === "conflict") {
    // Coalesce on the row's current fetch time. A debounced result carries the
    // remaining window directly; a conflict has none, so derive the trailing time
    // from the winner's `fetchedAt` plus a full debounce window (a refresh right
    // now would just debounce again against that write).
    const processAfter =
      result.reason === "debounced"
        ? new Date(Date.now() + result.retryAfterMs + TRAILING_REFRESH_BUFFER_MS)
        : new Date(
            (result.fetchedAt?.getTime() ?? Date.now()) + DEFAULT_REFRESH_DEBOUNCE_MS + TRAILING_REFRESH_BUFFER_MS
          )
    // Webhook-side senders (isTrailing false) always schedule the bare hop-0 id so
    // a storm coalesces. A trailing worker re-scheduling itself bumps the hop so the
    // new id differs from the one it already claimed — otherwise a replica behind the
    // scheduler's clock re-debounces at the same version, re-sends its own id, and the
    // pkey dedupe drops it forever (PR #1358 clock skew).
    const nextHop = params.isTrailing ? (params.hop ?? 0) + 1 : 0
    if (nextHop > MAX_TRAILING_HOPS) {
      log.warn(
        { workspaceId, previewId, hop: nextHop },
        "Giving up trailing GitHub preview refresh after too many debounce hops (clock skew?)"
      )
      return
    }
    const messageId = githubPreviewRefreshQueueId(previewId, result.refreshVersion, nextHop)

    await deps.jobQueue.send(
      JobQueues.GITHUB_PREVIEW_REFRESH,
      { workspaceId, previewId, hop: nextHop },
      { processAfter, messageId }
    )
    log.debug(
      { workspaceId, previewId, messageId, processAfter, reason: result.reason },
      "Scheduled trailing GitHub preview refresh"
    )
    return
  }

  // fetch_empty: transient failure. Retry with backoff until the cap.
  const attempt = params.attempt ?? 0
  if (attempt >= FETCH_EMPTY_RETRY_DELAYS_MS.length) {
    log.warn({ workspaceId, previewId, attempt }, "Giving up GitHub preview refresh after repeated empty fetches")
    return
  }

  const nextAttempt = attempt + 1
  const retryCycleId = params.retryCycleId ?? Math.floor(Date.now() / FETCH_EMPTY_RETRY_CYCLE_MS).toString(36)
  const processAfter = new Date(Date.now() + FETCH_EMPTY_RETRY_DELAYS_MS[attempt]!)
  const messageId = githubPreviewRefreshRetryQueueId(previewId, result.refreshVersion, retryCycleId, nextAttempt)

  await deps.jobQueue.send(
    JobQueues.GITHUB_PREVIEW_REFRESH,
    { workspaceId, previewId, attempt: nextAttempt, retryCycleId },
    { processAfter, messageId }
  )
  log.debug(
    { workspaceId, previewId, messageId, processAfter, attempt: nextAttempt },
    "Scheduled trailing GitHub preview refresh (fetch failed)"
  )
}

/**
 * Worker for the trailing refresh job. Re-runs the coalescing refresh: on a
 * successful refresh it completes; if it debounces/conflicts again it reschedules
 * on the fresh `fetchedAt`, and on a repeated empty fetch it retries with backoff —
 * converging or giving up once the storm/outage ends.
 */
export function createGithubPreviewRefreshWorker(
  deps: GithubPreviewRefreshDeps
): JobHandler<GithubPreviewRefreshJobData> {
  return async (job: Job<GithubPreviewRefreshJobData>) => {
    await refreshGithubPreviewWithTrailing(deps, {
      workspaceId: job.data.workspaceId,
      previewId: job.data.previewId,
      attempt: job.data.attempt,
      retryCycleId: job.data.retryCycleId,
      hop: job.data.hop,
      isTrailing: true,
    })
  }
}
