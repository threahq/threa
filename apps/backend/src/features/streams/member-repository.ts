import type { Querier } from "../../db"
import { sql } from "../../db"
import type { NotificationLevel } from "@threahq/types"

interface StreamMemberRow {
  stream_id: string
  member_id: string
  notification_level: string | null
  joined_at: Date
}

export interface StreamMember {
  streamId: string
  memberId: string
  notificationLevel: NotificationLevel | null
  joinedAt: Date
}

export interface UpdateStreamMemberParams {
  notificationLevel?: NotificationLevel | null
}

function mapRowToMember(row: StreamMemberRow): StreamMember {
  return {
    streamId: row.stream_id,
    memberId: row.member_id,
    notificationLevel: row.notification_level as NotificationLevel | null,
    joinedAt: row.joined_at,
  }
}

export const StreamMemberRepository = {
  async findByStreamAndMember(
    db: Querier,
    workspaceId: string,
    streamId: string,
    memberId: string
  ): Promise<StreamMember | null> {
    const result = await db.query<StreamMemberRow>(sql`
      SELECT stream_id, member_id, notification_level, joined_at
      FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND member_id = ${memberId}
    `)
    return result.rows[0] ? mapRowToMember(result.rows[0]) : null
  },

  async findByStreamsAndMember(
    db: Querier,
    workspaceId: string,
    streamIds: string[],
    memberId: string
  ): Promise<StreamMember[]> {
    if (streamIds.length === 0) return []

    const result = await db.query<StreamMemberRow>(sql`
      SELECT stream_id, member_id, notification_level, joined_at
      FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${streamIds}) AND member_id = ${memberId}
    `)
    return result.rows.map(mapRowToMember)
  },

  async list(
    db: Querier,
    workspaceId: string,
    filters: { memberId?: string; streamId?: string; streamIds?: string[] }
  ): Promise<StreamMember[]> {
    if (filters.memberId && !filters.streamId && !filters.streamIds) {
      const result = await db.query<StreamMemberRow>(sql`
        SELECT stream_id, member_id, notification_level, joined_at
        FROM stream_members
        WHERE workspace_id = ${workspaceId} AND member_id = ${filters.memberId}
        ORDER BY joined_at DESC
      `)
      return result.rows.map(mapRowToMember)
    }

    if (filters.streamId && !filters.memberId) {
      const result = await db.query<StreamMemberRow>(sql`
        SELECT stream_id, member_id, notification_level, joined_at
        FROM stream_members
        WHERE workspace_id = ${workspaceId} AND stream_id = ${filters.streamId}
        ORDER BY joined_at
      `)
      return result.rows.map(mapRowToMember)
    }

    if (filters.streamIds && filters.streamIds.length > 0 && !filters.memberId) {
      const result = await db.query<StreamMemberRow>(sql`
        SELECT stream_id, member_id, notification_level, joined_at
        FROM stream_members
        WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${filters.streamIds})
        ORDER BY joined_at
      `)
      return result.rows.map(mapRowToMember)
    }

    throw new Error("StreamMemberRepository.list requires either memberId, streamId, or streamIds filter")
  },

  async listPaginated(
    db: Querier,
    workspaceId: string,
    streamId: string,
    options?: { limit?: number; cursorJoinedAt?: Date; cursorMemberId?: string }
  ): Promise<StreamMember[]> {
    const limit = options?.limit ?? 50

    if (options?.cursorJoinedAt && options?.cursorMemberId) {
      const result = await db.query<StreamMemberRow>(sql`
        SELECT stream_id, member_id, notification_level, joined_at
        FROM stream_members
        WHERE workspace_id = ${workspaceId}
          AND stream_id = ${streamId}
          AND (joined_at, member_id) > (${options.cursorJoinedAt}, ${options.cursorMemberId})
        ORDER BY joined_at, member_id
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToMember)
    }

    const result = await db.query<StreamMemberRow>(sql`
      SELECT stream_id, member_id, notification_level, joined_at
      FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      ORDER BY joined_at, member_id
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToMember)
  },

  async insert(db: Querier, workspaceId: string, streamId: string, memberId: string): Promise<StreamMember> {
    const result = await db.query<StreamMemberRow>(sql`
      INSERT INTO stream_members (workspace_id, stream_id, member_id)
      VALUES (${workspaceId}, ${streamId}, ${memberId})
      ON CONFLICT (workspace_id, stream_id, member_id) DO NOTHING
      RETURNING stream_id, member_id, notification_level, joined_at
    `)
    if (result.rows.length === 0) {
      const existing = await this.findByStreamAndMember(db, workspaceId, streamId, memberId)
      if (!existing) throw new Error("Failed to insert or find stream member")
      return existing
    }
    return mapRowToMember(result.rows[0])
  },

  async insertMany(db: Querier, workspaceId: string, streamId: string, memberIds: string[]): Promise<StreamMember[]> {
    const uniqueMemberIds = Array.from(new Set(memberIds))
    if (uniqueMemberIds.length === 0) return []

    const inserted = await db.query<StreamMemberRow>(sql`
      INSERT INTO stream_members (workspace_id, stream_id, member_id)
      SELECT ${workspaceId}, ${streamId}, members.member_id
      FROM unnest(${uniqueMemberIds}::text[]) AS members(member_id)
      ON CONFLICT (workspace_id, stream_id, member_id) DO NOTHING
      RETURNING stream_id, member_id, notification_level, joined_at
    `)

    if (inserted.rows.length === uniqueMemberIds.length) {
      const insertedByMemberId = new Map(inserted.rows.map((row) => [row.member_id, mapRowToMember(row)]))
      return uniqueMemberIds.map((memberId) => {
        const member = insertedByMemberId.get(memberId)
        if (!member) throw new Error(`Failed to insert stream member ${memberId}`)
        return member
      })
    }

    const existing = await db.query<StreamMemberRow>(sql`
      SELECT stream_id, member_id, notification_level, joined_at
      FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND member_id = ANY(${uniqueMemberIds})
    `)

    const existingByMemberId = new Map(existing.rows.map((row) => [row.member_id, mapRowToMember(row)]))
    return uniqueMemberIds.map((memberId) => {
      const member = existingByMemberId.get(memberId)
      if (!member) throw new Error(`Failed to insert or find stream member ${memberId}`)
      return member
    })
  },

  async update(
    db: Querier,
    workspaceId: string,
    streamId: string,
    memberId: string,
    params: UpdateStreamMemberParams
  ): Promise<StreamMember | null> {
    const sets: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.notificationLevel !== undefined) {
      sets.push(`notification_level = $${paramIndex++}`)
      values.push(params.notificationLevel)
    }

    if (sets.length === 0) return this.findByStreamAndMember(db, workspaceId, streamId, memberId)

    values.push(workspaceId, streamId, memberId)

    const query = `
      UPDATE stream_members SET ${sets.join(", ")}
      WHERE workspace_id = $${paramIndex++} AND stream_id = $${paramIndex++} AND member_id = $${paramIndex}
      RETURNING stream_id, member_id, notification_level, joined_at
    `
    const result = await db.query<StreamMemberRow>(query, values)
    return result.rows[0] ? mapRowToMember(result.rows[0]) : null
  },

  async delete(db: Querier, workspaceId: string, streamId: string, memberId: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND member_id = ${memberId}
    `)
    return result.rowCount !== null && result.rowCount > 0
  },

  async countByStreamForUpdate(db: Querier, workspaceId: string, streamId: string): Promise<number> {
    // Lock rows first, then count — FOR UPDATE can't be used with aggregates
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*) FROM (
        SELECT 1 FROM stream_members WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} FOR UPDATE
      ) locked
    `)
    return parseInt(result.rows[0].count, 10)
  },

  async isMember(db: Querier, workspaceId: string, streamId: string, memberId: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND member_id = ${memberId}
    `)
    return result.rows.length > 0
  },

  async lockMemberships(
    db: Querier,
    workspaceId: string,
    rootStreamIds: readonly string[],
    memberId: string
  ): Promise<Set<string>> {
    const stableIds = [...new Set(rootStreamIds)].sort()
    if (stableIds.length === 0) return new Set()
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT stream_id
      FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${stableIds}) AND member_id = ${memberId}
      ORDER BY stream_id
      FOR UPDATE
    `)
    return new Set(result.rows.map((row) => row.stream_id))
  },

  async lockMemberPairs(
    db: Querier,
    workspaceId: string,
    pairs: readonly { streamId: string; memberId: string }[]
  ): Promise<Set<string>> {
    const stable = [...new Map(pairs.map((pair) => [`${pair.streamId}:${pair.memberId}`, pair])).values()].sort(
      (a, b) => a.streamId.localeCompare(b.streamId) || a.memberId.localeCompare(b.memberId)
    )
    if (stable.length === 0) return new Set()
    const result = await db.query<{ stream_id: string; member_id: string }>(sql`
      SELECT sm.stream_id, sm.member_id
      FROM stream_members sm
      JOIN unnest(${stable.map((pair) => pair.streamId)}::text[], ${stable.map((pair) => pair.memberId)}::text[])
        AS requested(stream_id, member_id)
        ON requested.stream_id = sm.stream_id AND requested.member_id = sm.member_id
      WHERE sm.workspace_id = ${workspaceId}
      ORDER BY sm.stream_id, sm.member_id
      FOR UPDATE OF sm
    `)
    return new Set(result.rows.map((row) => `${row.stream_id}:${row.member_id}`))
  },

  /**
   * Count members of `streamId` who are NOT members of `otherStreamId`.
   * Used by the sharing privacy boundary check: given a source and target
   * stream, how many of the target's members would gain implicit read via
   * the share. Set-based (single query, no N+1).
   */
  async countMembersNotIn(db: Querier, workspaceId: string, streamId: string, otherStreamId: string): Promise<number> {
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM stream_members tgt
      WHERE tgt.workspace_id = ${workspaceId}
        AND tgt.stream_id = ${streamId}
        AND NOT EXISTS (
          SELECT 1 FROM stream_members src
          WHERE src.workspace_id = ${workspaceId}
            AND src.stream_id = ${otherStreamId}
            AND src.member_id = tgt.member_id
        )
    `)
    return Number(result.rows[0]?.count ?? "0")
  },

  async filterMemberIds(db: Querier, workspaceId: string, streamId: string, memberIds: string[]): Promise<Set<string>> {
    if (memberIds.length === 0) return new Set()
    const result = await db.query<{ member_id: string }>(sql`
      SELECT member_id FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND member_id = ANY(${memberIds})
    `)
    return new Set(result.rows.map((r) => r.member_id))
  },

  async deleteByMemberInDescendants(
    db: Querier,
    workspaceId: string,
    memberId: string,
    ancestorStreamId: string
  ): Promise<string[]> {
    const result = await db.query<{ stream_id: string }>(sql`
      WITH RECURSIVE descendants AS (
        SELECT id FROM streams
        WHERE workspace_id = ${workspaceId} AND parent_stream_id = ${ancestorStreamId} AND type = 'thread'
        UNION ALL
        SELECT s.id FROM streams s
        JOIN descendants d ON s.parent_stream_id = d.id AND s.type = 'thread'
        WHERE s.workspace_id = ${workspaceId}
      )
      DELETE FROM stream_members
      WHERE workspace_id = ${workspaceId} AND member_id = ${memberId} AND stream_id IN (SELECT id FROM descendants)
      RETURNING stream_id
    `)
    return result.rows.map((r) => r.stream_id)
  },
}
