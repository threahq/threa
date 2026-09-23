import type { Querier } from "../../db"
import { composeSql } from "../../db"
import type { StreamDirectoryStats } from "@threahq/types"
import { streamAccessPredicateSql } from "./access"

export const DIRECTORY_ACTIVITY_DAYS = 14
const RECENT_MEMBER_LIMIT = 5

interface DirectoryStatsRow {
  stream_id: string
  member_count: number
  recent_member_ids: string[]
  activity: [number, number][]
}

export const StreamDirectoryStatsRepository = {
  async listForViewer(db: Querier, workspaceId: string, userId: string): Promise<StreamDirectoryStats[]> {
    const result = await db.query<DirectoryStatsRow>(composeSql`
      WITH readable AS (
        SELECT s.id FROM streams s
        WHERE s.workspace_id = ${workspaceId}
          AND s.archived_at IS NULL
          AND ${streamAccessPredicateSql(workspaceId, userId, "s.id")}
      ),
      members AS (
        SELECT sm.stream_id,
          COUNT(*)::int AS member_count,
          (ARRAY_AGG(sm.member_id ORDER BY sm.joined_at DESC, sm.member_id))[1:${RECENT_MEMBER_LIMIT}::int] AS recent_member_ids
        FROM stream_members sm
        JOIN readable r ON r.id = sm.stream_id
        GROUP BY sm.stream_id
      ),
      activity AS (
        SELECT m.stream_id,
          FLOOR(EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400)::int AS days_ago,
          COUNT(*)::int AS n
        FROM messages m
        JOIN readable r ON r.id = m.stream_id
        WHERE m.deleted_at IS NULL
          AND m.created_at > NOW() - make_interval(days => ${DIRECTORY_ACTIVITY_DAYS}::int)
        GROUP BY 1, 2
      )
      SELECT r.id AS stream_id,
        COALESCE(mb.member_count, 0) AS member_count,
        COALESCE(mb.recent_member_ids, ARRAY[]::text[]) AS recent_member_ids,
        COALESCE(
          (SELECT json_agg(json_build_array(a.days_ago, a.n)) FROM activity a WHERE a.stream_id = r.id),
          '[]'::json
        ) AS activity
      FROM readable r
      LEFT JOIN members mb ON mb.stream_id = r.id
    `)
    return result.rows.map((row) => {
      const activity = new Array<number>(DIRECTORY_ACTIVITY_DAYS).fill(0)
      for (const [daysAgo, count] of row.activity) {
        if (daysAgo >= 0 && daysAgo < DIRECTORY_ACTIVITY_DAYS) activity[daysAgo] += count
      }
      return {
        streamId: row.stream_id,
        memberCount: row.member_count,
        recentMemberIds: row.recent_member_ids,
        activity,
      }
    })
  },
}
