import type { Querier } from "../../db"
import { sql } from "../../db"
import type { NotificationLevel } from "@threa/types"
import type { Stream } from "./repository"
import type { StreamMember } from "./member-repository"
import { getDefaultLevel } from "./notification-config"

/**
 * What a parent's explicit notification level means for child streams.
 * "mentions" and "activity" don't cascade (null stops the ancestor walk).
 */
function cascadeLevel(parentLevel: NotificationLevel): NotificationLevel | null {
  if (parentLevel === "everything") return "activity"
  if (parentLevel === "muted") return "muted"
  return null
}

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

  const ancestorIds = await getAncestorIds(db, stream.parentStreamId, 2)
  if (ancestorIds.length === 0) {
    for (const member of needsResolution) {
      resolved.push({ memberId: member.memberId, effectiveLevel: getDefaultLevel(stream.type), source: "default" })
    }
    return resolved
  }

  const memberIds = needsResolution.map((m) => m.memberId)
  const ancestorMemberships = await getAncestorMemberships(db, ancestorIds, memberIds)

  for (const member of needsResolution) {
    let inherited: NotificationLevel | null = null

    for (const ancestorId of ancestorIds) {
      const level = ancestorMemberships.get(ancestorId)?.get(member.memberId)
      if (!level) continue

      inherited = cascadeLevel(level)
      break
    }

    if (inherited) {
      resolved.push({ memberId: member.memberId, effectiveLevel: inherited, source: "inherited" })
    } else {
      resolved.push({
        memberId: member.memberId,
        effectiveLevel: getDefaultLevel(stream.type),
        source: "default",
      })
    }
  }

  return resolved
}

/** Ordered ancestor stream IDs (nearest first) via one recursive CTE. */
async function getAncestorIds(db: Querier, parentStreamId: string | null, maxHops: number): Promise<string[]> {
  if (!parentStreamId) return []

  const result = await db.query<{ id: string }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_stream_id, 1 AS depth
      FROM streams
      WHERE id = ${parentStreamId}

      UNION ALL

      SELECT s.id, s.parent_stream_id, a.depth + 1
      FROM ancestors a
      JOIN streams s ON s.id = a.parent_stream_id
      WHERE a.depth < ${maxHops}
    )
    SELECT id FROM ancestors ORDER BY depth
  `)
  return result.rows.map((r) => r.id)
}

/** Returns Map<ancestorId, Map<memberId, notificationLevel>> for the given members. */
async function getAncestorMemberships(
  db: Querier,
  ancestorIds: string[],
  memberIds: string[]
): Promise<Map<string, Map<string, NotificationLevel>>> {
  const result = await db.query<{ stream_id: string; member_id: string; notification_level: string }>(sql`
    SELECT stream_id, member_id, notification_level
    FROM stream_members
    WHERE stream_id = ANY(${ancestorIds})
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
