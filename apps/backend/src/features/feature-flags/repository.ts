import type { FeatureFlagLayers, FeatureFlagScope } from "@threahq/types"
import { sql, type Querier } from "../../db"

interface OverrideRow {
  subject_type: string
  flag_key: string
  value: string
}

export const FeatureFlagOverrideRepository = {
  /**
   * The workspace layer and this user's layer in one query (INV-30/INV-56):
   * the workspace's own rows (`subject_id = workspace_id`) plus the user's rows
   * (`subject_id = workos_user_id`). Partitioned into the two records by
   * subject_type; merge with registry defaults in the service.
   */
  async findLayers(db: Querier, workspaceId: string, workosUserId: string): Promise<FeatureFlagLayers> {
    const result = await db.query<OverrideRow>(sql`
      SELECT subject_type, flag_key, value
      FROM feature_flag_overrides
      WHERE workspace_id = ${workspaceId}
        AND (
          (subject_type = 'workspace' AND subject_id = ${workspaceId})
          OR (subject_type = 'user' AND subject_id = ${workosUserId})
        )
    `)
    const layers: FeatureFlagLayers = { workspace: {}, user: {} }
    for (const row of result.rows) {
      if (row.subject_type === "workspace") layers.workspace[row.flag_key] = row.value
      else if (row.subject_type === "user") layers.user[row.flag_key] = row.value
    }
    return layers
  },

  /** The workspace layer alone, for workspace-scoped reads that carry no user. */
  async findWorkspaceOverrides(db: Querier, workspaceId: string): Promise<Record<string, string>> {
    const result = await db.query<OverrideRow>(sql`
      SELECT subject_type, flag_key, value
      FROM feature_flag_overrides
      WHERE workspace_id = ${workspaceId} AND subject_type = 'workspace' AND subject_id = ${workspaceId}
    `)
    return Object.fromEntries(result.rows.map((row) => [row.flag_key, row.value]))
  },

  /**
   * Replace one subject's flag rows with a control-plane snapshot: upsert every
   * key in the snapshot, delete the rest. Two set-based statements (INV-56),
   * race-safe via ON CONFLICT (INV-20) — concurrent syncs converge on the
   * last writer without check-then-act.
   */
  async replaceForSubject(
    db: Querier,
    workspaceId: string,
    subjectType: FeatureFlagScope,
    subjectId: string,
    overrides: Record<string, string>
  ): Promise<void> {
    const flagKeys = Object.keys(overrides)
    const values = flagKeys.map((key) => overrides[key])

    await db.query(
      `DELETE FROM feature_flag_overrides
       WHERE workspace_id = $1 AND subject_type = $2 AND subject_id = $3 AND flag_key <> ALL($4::text[])`,
      [workspaceId, subjectType, subjectId, flagKeys]
    )
    if (flagKeys.length === 0) return
    await db.query(
      `INSERT INTO feature_flag_overrides (workspace_id, subject_type, subject_id, flag_key, value)
       SELECT $1, $2, $3, * FROM unnest($4::text[], $5::text[])
       ON CONFLICT (workspace_id, subject_type, subject_id, flag_key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [workspaceId, subjectType, subjectId, flagKeys, values]
    )
  },
}
