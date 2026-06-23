import type { PoolClient } from "pg"
import { OutboxRepository } from "../../lib/outbox"
import { ActivityRepository } from "./repository"

interface UserStreamPair {
  userId: string
  streamId: string
}

function dedupePairs(pairs: UserStreamPair[]): UserStreamPair[] {
  const seen = new Set<string>()
  const out: UserStreamPair[] = []
  for (const p of pairs) {
    const key = `${p.userId}:${p.streamId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * Recompute the absolute unread counts for the given (user, stream) pairs and
 * emit one `activity:counts` per affected user, inside the caller's transaction
 * (INV-7). The shared tail of every path that LOWERS or re-homes `user_activity`
 * truth without creating a row — reaction removal, message move — so the badge
 * converges on every session instead of stranding above the truth.
 */
export async function emitActivityCountsForPairs(
  client: PoolClient,
  workspaceId: string,
  pairs: UserStreamPair[]
): Promise<void> {
  const unique = dedupePairs(pairs)
  if (unique.length === 0) return

  const counts = await ActivityRepository.countUnreadForPairs(client, workspaceId, unique)

  const byUser = new Map<string, Array<{ streamId: string; mentionCount: number; activityCount: number }>>()
  for (const { userId, streamId } of unique) {
    const c = counts.get(`${userId}:${streamId}`)
    const list = byUser.get(userId) ?? []
    list.push({ streamId, mentionCount: c?.mentionCount ?? 0, activityCount: c?.totalCount ?? 0 })
    byUser.set(userId, list)
  }

  for (const [userId, streamCounts] of byUser) {
    await OutboxRepository.insert(client, "activity:counts", {
      workspaceId,
      targetUserId: userId,
      counts: streamCounts,
    })
  }
}
