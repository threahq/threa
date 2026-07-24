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
 * users with no read-state row. The candidate universe stays the caller's
 * access/recipient set — read state is user-anchored, NOT membership-gated
 * (non-member unlock): a viewer who inherits thread access from the root
 * (INV-62) reads as born-read off their own row, which closes the late-insert
 * race where an activity row lands between their read-clear and the response.
 * The membership fallback leg is workspace-scoped (INV-8): it joins `streams`
 * on the membership's stream and requires `streams.workspace_id` match, and
 * binds the watermark event to that same stream (not just by event id) so a
 * stale/corrupt cross-workspace watermark can't qualify a member.
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
    JOIN stream_events se ON se.id = rs.last_read_event_id
    WHERE rs.workspace_id = ${workspaceId}
      AND rs.stream_id = ${streamId}
      AND rs.user_id = ANY(${userIds})
      AND se.sequence >= ${sequence.toString()}
    UNION
    SELECT sm.member_id
    FROM stream_members sm
    JOIN streams s ON s.id = sm.stream_id
    JOIN stream_events se ON se.id = sm.last_read_event_id AND se.stream_id = sm.stream_id
    WHERE sm.stream_id = ${streamId}
      AND s.workspace_id = ${workspaceId}
      AND sm.member_id = ANY(${userIds})
      AND se.sequence >= ${sequence.toString()}
      AND NOT EXISTS (
        SELECT 1 FROM stream_read_state rs
        WHERE rs.stream_id = ${streamId} AND rs.user_id = sm.member_id AND rs.workspace_id = ${workspaceId}
      )
  `)
  return new Set(result.rows.map((row) => row.user_id))
}
