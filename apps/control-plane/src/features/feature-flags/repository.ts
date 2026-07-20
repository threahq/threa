import type { Querier } from "@threa/backend-common"
import type { FeatureFlagScope } from "@threa/types"

export interface FeatureFlagOverrideRow {
  subject_type: FeatureFlagScope
  subject_id: string
  flag_key: string
  value: string
  updated_at: Date
}

export interface FeatureFlagOverrideRecord {
  subjectType: FeatureFlagScope
  subjectId: string
  flagKey: string
  value: string
  updatedAt: Date
}

function mapRow(row: FeatureFlagOverrideRow): FeatureFlagOverrideRecord {
  return {
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    flagKey: row.flag_key,
    value: row.value,
    updatedAt: row.updated_at,
  }
}

export const FeatureFlagOverrideRepository = {
  async listByWorkspace(db: Querier, workspaceId: string): Promise<FeatureFlagOverrideRecord[]> {
    const result = await db.query<FeatureFlagOverrideRow>(
      `SELECT subject_type, subject_id, flag_key, value, updated_at
       FROM feature_flag_overrides
       WHERE workspace_id = $1`,
      [workspaceId]
    )
    return result.rows.map(mapRow)
  },

  async listForSubject(
    db: Querier,
    workspaceId: string,
    subjectType: FeatureFlagScope,
    subjectId: string
  ): Promise<FeatureFlagOverrideRecord[]> {
    const result = await db.query<FeatureFlagOverrideRow>(
      `SELECT subject_type, subject_id, flag_key, value, updated_at
       FROM feature_flag_overrides
       WHERE workspace_id = $1 AND subject_type = $2 AND subject_id = $3`,
      [workspaceId, subjectType, subjectId]
    )
    return result.rows.map(mapRow)
  },

  /** Race-safe upsert (INV-20) — concurrent admin writes converge on last write. */
  async setOverride(
    db: Querier,
    params: { workspaceId: string; subjectType: FeatureFlagScope; subjectId: string; flagKey: string; value: string }
  ): Promise<void> {
    await db.query(
      `INSERT INTO feature_flag_overrides (workspace_id, subject_type, subject_id, flag_key, value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, subject_type, subject_id, flag_key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [params.workspaceId, params.subjectType, params.subjectId, params.flagKey, params.value]
    )
  },

  /** Remove an override (revert the flag to its explicit default). */
  async deleteOverride(
    db: Querier,
    params: { workspaceId: string; subjectType: FeatureFlagScope; subjectId: string; flagKey: string }
  ): Promise<void> {
    await db.query(
      `DELETE FROM feature_flag_overrides
       WHERE workspace_id = $1 AND subject_type = $2 AND subject_id = $3 AND flag_key = $4`,
      [params.workspaceId, params.subjectType, params.subjectId, params.flagKey]
    )
  },
}
