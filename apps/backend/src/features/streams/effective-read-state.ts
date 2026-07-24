import type { Querier } from "../../db"
import { sql } from "../../db"
import { ReadStateRepository } from "./read-state-repository"

export interface EffectiveReadState {
  streamId: string
  lastReadEventId: string | null
  lastReadAt: Date | null
}

/**
 * The effective read frontier for one user across a bounded set of member
 * streams (read cutover): a `stream_read_state` row wins whenever it EXISTS —
 * including a row whose watermark is NULL (explicit unread-to-zero) — and the
 * membership columns fill only streams with no row yet (rolling-deploy window,
 * pre-cutover rows). Row presence, not field nullability, selects the source:
 * a present NULL must never fall through to a stale non-null membership
 * watermark. The cutover therefore converges regressed rows UPWARD only.
 */
export async function getEffectiveReadState(
  db: Querier,
  userId: string,
  memberships: Array<{ streamId: string; lastReadEventId: string | null; lastReadAt: Date | null }>
): Promise<Map<string, EffectiveReadState>> {
  const rows = await ReadStateRepository.getBatch(
    db,
    userId,
    memberships.map((m) => m.streamId)
  )
  const readStateByStream = new Map(rows.map((r) => [r.streamId, r]))

  const effective = new Map<string, EffectiveReadState>()
  for (const membership of memberships) {
    const readState = readStateByStream.get(membership.streamId)
    effective.set(membership.streamId, {
      streamId: membership.streamId,
      lastReadEventId: readState ? readState.lastReadEventId : membership.lastReadEventId,
      lastReadAt: readState ? readState.lastReadAt : membership.lastReadAt,
    })
  }
  return effective
}

/**
 * Which of `userIds` have effectively read through `sequence` in this stream —
 * the born-read gate for activity rows (`resolveAlreadyReadRecipients`). A
 * `stream_read_state` row is consulted first and is authoritative when present
 * (a NULL watermark counts as "before the first message" and never falls
 * through to a non-null membership column); the membership watermark fills only
 * users with no read-state row. The candidate universe is the caller's
 * (member-filtered) — this changes the read-truth source, not the recipients.
 *
 * Chunk 2 scope: the read-state branch ALSO requires a current `stream_members`
 * row for (stream_id, user_id) — a retained row for a removed/non-member is
 * excluded from the born-read set. Row presence stays authoritative within the
 * member universe (a present NULL still joins no event and reads as unread).
 * Chunk 3 deliberately removes this current-membership gate.
 */
export async function usersReadThroughEffective(
  db: Querier,
  streamId: string,
  userIds: string[],
  sequence: bigint
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const result = await db.query<{ user_id: string }>(sql`
    SELECT rs.user_id
    FROM stream_read_state rs
    JOIN stream_members sm ON sm.stream_id = rs.stream_id AND sm.member_id = rs.user_id
    JOIN stream_events se ON se.id = rs.last_read_event_id
    WHERE rs.stream_id = ${streamId}
      AND rs.user_id = ANY(${userIds})
      AND se.sequence >= ${sequence.toString()}
    UNION
    SELECT sm.member_id
    FROM stream_members sm
    JOIN stream_events se ON se.id = sm.last_read_event_id
    WHERE sm.stream_id = ${streamId}
      AND sm.member_id = ANY(${userIds})
      AND se.sequence >= ${sequence.toString()}
      AND NOT EXISTS (
        SELECT 1 FROM stream_read_state rs
        WHERE rs.stream_id = ${streamId} AND rs.user_id = sm.member_id
      )
  `)
  return new Set(result.rows.map((row) => row.user_id))
}
