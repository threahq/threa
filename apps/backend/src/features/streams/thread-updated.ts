import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository } from "./repository"

/**
 * The fields a `thread:updated` patch reads off the thread stream. Accepts both
 * the repository's row-mapped `Stream` (dates) and the wire `Stream` (strings).
 */
export interface ThreadUpdatedSource {
  id: string
  workspaceId: string
  parentStreamId: string | null
  parentAnchorId?: string | null
  replyCount?: number
}

/**
 * Queue the projection patch for a thread whose reply stats or lifecycle just
 * changed, routed to the parent stream room where the anchor renders. No-op
 * for a stream that is not anchored under a parent.
 *
 * `includeReplyCount` (default true) carries the authoritative post-mutation
 * count. Summary-only refreshes (edits, archive/unarchive) pass false so they
 * never republish an unlocked count a concurrent create/delete already
 * advanced (INV-20).
 */
export async function publishThreadUpdated(
  client: Querier,
  thread: ThreadUpdatedSource,
  options: { includeReplyCount?: boolean } = {}
): Promise<void> {
  if (!thread.parentStreamId || !thread.parentAnchorId) return
  const includeReplyCount = options.includeReplyCount ?? true
  const threadSummary = await StreamRepository.findThreadSummaryByParentMessage(
    client,
    thread.parentStreamId,
    thread.parentAnchorId
  )
  await OutboxRepository.insert(client, "thread:updated", {
    workspaceId: thread.workspaceId,
    streamId: thread.parentStreamId,
    parentStreamId: thread.parentStreamId,
    anchorId: thread.parentAnchorId,
    threadId: thread.id,
    ...(includeReplyCount ? { replyCount: thread.replyCount ?? 0 } : {}),
    threadSummary,
  })
}
