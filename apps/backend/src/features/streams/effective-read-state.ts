import type { Querier } from "../../db"
import { sql } from "../../db"
import { ReadStateRepository } from "./read-state-repository"

export interface EffectiveReadState {
  streamId: string
  lastReadEventId: string | null
  lastReadAt: Date | null
}

/**
 * The read frontier for one user across a bounded set of streams. `stream_read_state`
 * is the sole source: every requested stream resolves to an entry, and a stream
 * with no row is never-read (NULL watermark — position before the first message).
 * A present NULL is an explicit mark-unread-to-zero and is reported as-is.
 */
export async function getEffectiveReadState(
  db: Querier,
  userId: string,
  streamIds: string[]
): Promise<Map<string, EffectiveReadState>> {
  const rows = await ReadStateRepository.getBatch(db, userId, streamIds)
  const readStateByStream = new Map(rows.map((r) => [r.streamId, r]))

  const effective = new Map<string, EffectiveReadState>()
  for (const streamId of streamIds) {
    const readState = readStateByStream.get(streamId)
    effective.set(streamId, {
      streamId,
      lastReadEventId: readState ? readState.lastReadEventId : null,
      lastReadAt: readState ? readState.lastReadAt : null,
    })
  }
  return effective
}

/**
 * Which of `userIds` have read through `sequence` in this stream — the born-read
 * gate for activity rows (`resolveAlreadyReadRecipients`). Read state is
 * user-anchored, NOT membership-gated (non-member unlock): a viewer who inherits
 * thread access from the root (INV-62) reads as born-read off their own row, which
 * closes the late-insert race where an activity row lands between their read-clear
 * and the response. A NULL watermark counts as "before the first message" and never
 * qualifies. Workspace-scoped (INV-8): the watermark event is bound to this stream
 * (not just by event id) so a stale/corrupt cross-stream watermark can't qualify.
 */
export async function usersReadThroughEffective(
  db: Querier,
  workspaceId: string,
  streamId: string,
  userIds: string[],
  sequence: bigint
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const result = await db.query<{ user_id: string }>(sql`
    SELECT rs.user_id
    FROM stream_read_state rs
    JOIN stream_events se ON se.id = rs.last_read_event_id AND se.stream_id = rs.stream_id
    WHERE rs.workspace_id = ${workspaceId}
      AND rs.stream_id = ${streamId}
      AND rs.user_id = ANY(${userIds})
      AND se.sequence >= ${sequence.toString()}
  `)
  return new Set(result.rows.map((row) => row.user_id))
}
