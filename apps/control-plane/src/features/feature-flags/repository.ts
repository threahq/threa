import type { Querier } from "@threa/backend-common"

export interface FeatureFlagOverrideRow {
  workos_user_id: string
  flag_key: string
  value: string
  updated_at: Date
}

export interface FeatureFlagOverrideRecord {
  workosUserId: string
  flagKey: string
  value: string
  updatedAt: Date
}

function mapRow(row: FeatureFlagOverrideRow): FeatureFlagOverrideRecord {
  return {
    workosUserId: row.workos_user_id,
    flagKey: row.flag_key,
    value: row.value,
    updatedAt: row.updated_at,
  }
}

export const FeatureFlagOverrideRepository = {
  async listByWorkspace(db: Querier, workspaceId: string): Promise<FeatureFlagOverrideRecord[]> {
    const result = await db.query<FeatureFlagOverrideRow>(
      `SELECT workos_user_id, flag_key, value, updated_at
       FROM feature_flag_overrides
       WHERE workspace_id = $1`,
      [workspaceId]
    )
    return result.rows.map(mapRow)
  },

  async listForUser(db: Querier, workspaceId: string, workosUserId: string): Promise<FeatureFlagOverrideRecord[]> {
    const result = await db.query<FeatureFlagOverrideRow>(
      `SELECT workos_user_id, flag_key, value, updated_at
       FROM feature_flag_overrides
       WHERE workspace_id = $1 AND workos_user_id = $2`,
      [workspaceId, workosUserId]
    )
    return result.rows.map(mapRow)
  },

  /** Race-safe upsert (INV-20) — concurrent admin writes converge on last write. */
  async setOverride(
    db: Querier,
    params: { workspaceId: string; workosUserId: string; flagKey: string; value: string }
  ): Promise<void> {
    await db.query(
      `INSERT INTO feature_flag_overrides (workspace_id, workos_user_id, flag_key, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, workos_user_id, flag_key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [params.workspaceId, params.workosUserId, params.flagKey, params.value]
    )
  },

  /** Remove an override (revert the flag to its default: the first declared value). */
  async deleteOverride(
    db: Querier,
    params: { workspaceId: string; workosUserId: string; flagKey: string }
  ): Promise<void> {
    await db.query(
      `DELETE FROM feature_flag_overrides
       WHERE workspace_id = $1 AND workos_user_id = $2 AND flag_key = $3`,
      [params.workspaceId, params.workosUserId, params.flagKey]
    )
  },
}
