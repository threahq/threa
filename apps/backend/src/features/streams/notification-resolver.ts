import type { Querier } from "../../db"
import { sql } from "../../db"
import { NOTIFICATION_INHERIT_DEPTH, resolveInheritedNotificationLevel, type NotificationLevel } from "@threahq/types"
import type { Stream } from "./repository"
import type { StreamMember } from "./member-repository"

export interface ResolvedNotification {
  memberId: string
  effectiveLevel: NotificationLevel
  source: "explicit" | "inherited" | "default"
}

/**
 * Batch-resolve notification levels for all members of a stream.
 */
export async function resolveNotificationLevelsForStream(
  db: Querier,
  stream: Stream,
  members: StreamMember[]
): Promise<ResolvedNotification[]> {
  if (members.length === 0) return []

  const resolved: ResolvedNotification[] = []
  const needsResolution: StreamMember[] = []

  for (const member of members) {
    if (member.notificationLevel) {
      resolved.push({ memberId: member.memberId, effectiveLevel: member.notificationLevel, source: "explicit" })
    } else {
      needsResolution.push(member)
    }
  }

  if (needsResolution.length === 0) return resolved

  const ancestorIds = await getAncestorIds(db, stream.workspaceId, stream.parentStreamId, NOTIFICATION_INHERIT_DEPTH)
  const memberIds = needsResolution.map((m) => m.memberId)
  const ancestorMemberships = await getAncestorMemberships(db, stream.workspaceId, ancestorIds, memberIds)

  for (const member of needsResolution) {
    const { level, from } = resolveInheritedNotificationLevel(
      stream.type,
      ancestorIds.map((id) => ({ level: ancestorMemberships.get(id)?.get(member.memberId) }))
    )
    resolved.push({ memberId: member.memberId, effectiveLevel: level, source: from ? "inherited" : "default" })
  }

  return resolved
}

/** Ordered ancestor stream IDs (nearest first) via one recursive CTE. */
async function getAncestorIds(
  db: Querier,
  workspaceId: string,
  parentStreamId: string | null,
  maxHops: number
): Promise<string[]> {
  if (!parentStreamId) return []

  const result = await db.query<{ id: string }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_stream_id, 1 AS depth
      FROM streams
      WHERE workspace_id = ${workspaceId} AND id = ${parentStreamId}

      UNION ALL

      SELECT s.id, s.parent_stream_id, a.depth + 1
      FROM ancestors a
      JOIN streams s ON s.id = a.parent_stream_id AND s.workspace_id = ${workspaceId}
      WHERE a.depth < ${maxHops}
    )
    SELECT id FROM ancestors ORDER BY depth
  `)
  return result.rows.map((r) => r.id)
}

/** Returns Map<ancestorId, Map<memberId, notificationLevel>> for the given members. */
async function getAncestorMemberships(
  db: Querier,
  workspaceId: string,
  ancestorIds: string[],
  memberIds: string[]
): Promise<Map<string, Map<string, NotificationLevel>>> {
  if (ancestorIds.length === 0) return new Map()
  const result = await db.query<{ stream_id: string; member_id: string; notification_level: string }>(sql`
    SELECT stream_id, member_id, notification_level
    FROM stream_members
    WHERE workspace_id = ${workspaceId}
      AND stream_id = ANY(${ancestorIds})
      AND member_id = ANY(${memberIds})
      AND notification_level IS NOT NULL
  `)

  const map = new Map<string, Map<string, NotificationLevel>>()
  for (const row of result.rows) {
    let memberMap = map.get(row.stream_id)
    if (!memberMap) {
      memberMap = new Map()
      map.set(row.stream_id, memberMap)
    }
    memberMap.set(row.member_id, row.notification_level as NotificationLevel)
  }
  return map
}

/**
 * One member's effective level on each of `streamIds`, set-based: their own
 * level, else what their levels on the stream's ancestors carry down.
 */
export async function resolveNotificationLevelsForMember(
  db: Querier,
  workspaceId: string,
  memberId: string,
  streamIds: string[]
): Promise<Map<string, NotificationLevel>> {
  if (streamIds.length === 0) return new Map()

  const result = await db.query<{
    stream_id: string
    type: Stream["type"]
    depth: number
    notification_level: NotificationLevel | null
  }>(sql`
    WITH RECURSIVE chain AS (
      SELECT s.id AS stream_id, s.type, s.id AS node_id, s.parent_stream_id AS next_id, 0 AS depth
      FROM streams s
      WHERE s.workspace_id = ${workspaceId} AND s.id = ANY(${streamIds})

      UNION ALL

      SELECT c.stream_id, c.type, p.id, p.parent_stream_id, c.depth + 1
      FROM chain c
      JOIN streams p ON p.workspace_id = ${workspaceId} AND p.id = c.next_id
      WHERE c.depth < ${NOTIFICATION_INHERIT_DEPTH}
    )
    SELECT c.stream_id, c.type, c.depth, sm.notification_level
    FROM chain c
    LEFT JOIN stream_members sm
      ON sm.workspace_id = ${workspaceId} AND sm.stream_id = c.node_id AND sm.member_id = ${memberId}
    ORDER BY c.stream_id, c.depth
  `)

  const chains = new Map<
    string,
    { type: Stream["type"]; own: NotificationLevel | null; ancestors: { level: NotificationLevel | null }[] }
  >()
  for (const row of result.rows) {
    if (row.depth === 0) {
      chains.set(row.stream_id, { type: row.type, own: row.notification_level, ancestors: [] })
    } else {
      chains.get(row.stream_id)?.ancestors.push({ level: row.notification_level })
    }
  }

  const levels = new Map<string, NotificationLevel>()
  for (const [streamId, chain] of chains) {
    levels.set(streamId, chain.own ?? resolveInheritedNotificationLevel(chain.type, chain.ancestors).level)
  }
  return levels
}
