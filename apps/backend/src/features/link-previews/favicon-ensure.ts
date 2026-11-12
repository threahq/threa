import type { Querier } from "../../db"
import { JobQueues, QueueRepository, type Job, type JobHandler } from "../../lib/queue"
import type { LinkFaviconEnsureJobData } from "../../lib/queue/job-queue"
import { getAppOrigins } from "./config"
import { LinkFaviconRepository } from "./favicon-repository"
import type { LinkFaviconService } from "./favicon-service"
import { fetchGenericMetadata } from "./worker"

const FAVICON_ENSURE_WINDOW_MS = 10 * 60_000

// Each job fetches a page and up to two icons; one pasted link list must not queue hundreds of them. Hosts past the
// cap are picked up when their blocks are next edited.
const MAX_ENSURES_PER_DOC_UPDATE = 20

/** Collapses ensure jobs per workspace+host within one window; completed rows persist, so the id carries the bucket. */
export function linkFaviconEnsureQueueId(workspaceId: string, host: string, nowMs: number): string {
  return `queue_lfav_${workspaceId}_${host}_b${Math.floor(nowMs / FAVICON_ENSURE_WINDOW_MS)}`
}

export async function enqueueDocLinkFaviconEnsures(
  db: Querier,
  params: { workspaceId: string; docId: string; blockIds: string[] }
): Promise<void> {
  const { workspaceId, docId, blockIds } = params
  if (blockIds.length === 0) return

  const uncached = await LinkFaviconRepository.listUncachedDocLinkOrigins(db, workspaceId, docId, blockIds)
  // Links to the app itself draw no site icon.
  const appOrigins = new Set(getAppOrigins())
  const external = uncached.filter(({ origin }) => !appOrigins.has(origin)).slice(0, MAX_ENSURES_PER_DOC_UPDATE)
  const now = Date.now()
  await QueueRepository.batchInsert(
    db,
    external.map(({ host, origin }) => {
      const payload: LinkFaviconEnsureJobData = { workspaceId, pageUrl: `${origin}/` }
      return {
        id: linkFaviconEnsureQueueId(workspaceId, host, now),
        queueName: JobQueues.LINK_FAVICON_ENSURE,
        workspaceId,
        payload,
        processAfter: new Date(now),
        insertedAt: new Date(now),
      }
    })
  )
}

export function createLinkFaviconEnsureWorker(deps: {
  linkFaviconService: LinkFaviconService
}): JobHandler<LinkFaviconEnsureJobData> {
  return async (job: Job<LinkFaviconEnsureJobData>) => {
    const { workspaceId, pageUrl } = job.data
    const { faviconUrl } = await fetchGenericMetadata(pageUrl)
    await deps.linkFaviconService.ensureForPage(workspaceId, pageUrl, faviconUrl ?? null)
  }
}
