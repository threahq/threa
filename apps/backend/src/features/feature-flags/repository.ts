import { sql, type Querier } from "../../db"

interface UserFeatureFlagRow {
  flag_key: string
  enabled: boolean
}

export interface UserFeatureFlagRecord {
  flagKey: string
  enabled: boolean
}

export const UserFeatureFlagRepository = {
  /** Stored flag rows for one user. Merge with registry defaults in the service. */
  async findForUser(db: Querier, workspaceId: string, userId: string): Promise<UserFeatureFlagRecord[]> {
    const result = await db.query<UserFeatureFlagRow>(sql`
      SELECT flag_key, enabled
      FROM user_feature_flags
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows.map((row) => ({ flagKey: row.flag_key, enabled: row.enabled }))
  },

  /**
   * Replace one user's flag rows with a control-plane snapshot: upsert every
   * key in the snapshot, delete the rest. Two set-based statements (INV-56),
   * race-safe via ON CONFLICT (INV-20) — concurrent syncs converge on the
   * last writer without check-then-act.
   */
  async replaceForUser(
    db: Querier,
    workspaceId: string,
    userId: string,
    flags: Record<string, boolean>
  ): Promise<void> {
    const flagKeys = Object.keys(flags)
    const enabledValues = flagKeys.map((key) => flags[key])

    await db.query(
      `DELETE FROM user_feature_flags
       WHERE workspace_id = $1 AND user_id = $2 AND flag_key <> ALL($3::text[])`,
      [workspaceId, userId, flagKeys]
    )
    if (flagKeys.length === 0) return
    await db.query(
      `INSERT INTO user_feature_flags (workspace_id, user_id, flag_key, enabled)
       SELECT $1, $2, * FROM unnest($3::text[], $4::boolean[])
       ON CONFLICT (workspace_id, user_id, flag_key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         updated_at = NOW()`,
      [workspaceId, userId, flagKeys, enabledValues]
    )
  },
}
