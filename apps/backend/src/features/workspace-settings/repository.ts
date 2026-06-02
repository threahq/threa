import { sql, type Querier } from "../../db"

/** Internal row type for workspace setting overrides (snake_case). */
interface WorkspaceSettingOverrideRow {
  key: string
  value: unknown
}

/** Override record returned from the repository. */
export interface WorkspaceSettingOverrideRecord {
  key: string
  value: unknown
}

export const WorkspaceSettingsRepository = {
  /**
   * Fetch all setting overrides for a workspace. Returns only the overrides —
   * merge with defaults in the service layer.
   */
  async findOverrides(db: Querier, workspaceId: string): Promise<WorkspaceSettingOverrideRecord[]> {
    const result = await db.query<WorkspaceSettingOverrideRow>(sql`
      SELECT key, value
      FROM workspace_setting_overrides
      WHERE workspace_id = ${workspaceId}
    `)
    return result.rows.map((row) => ({ key: row.key, value: row.value }))
  },

  /**
   * Upsert a single setting override. Race-safe via ON CONFLICT so concurrent
   * admins don't clobber with a check-then-act (INV-20).
   */
  async setOverride(db: Querier, workspaceId: string, key: string, value: unknown): Promise<void> {
    await db.query(sql`
      INSERT INTO workspace_setting_overrides (workspace_id, key, value)
      VALUES (${workspaceId}, ${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
    `)
  },

  /** Remove a setting override (revert to the code default). */
  async deleteOverride(db: Querier, workspaceId: string, key: string): Promise<void> {
    await db.query(sql`
      DELETE FROM workspace_setting_overrides
      WHERE workspace_id = ${workspaceId}
        AND key = ${key}
    `)
  },
}
