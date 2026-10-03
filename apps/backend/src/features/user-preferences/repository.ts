import { sql, type Querier } from "../../db"

interface PreferenceOverrideRow {
  workspace_id: string
  user_id: string
  key: string
  value: unknown
  created_at: Date
  updated_at: Date
}

export interface PreferenceOverrideRecord {
  key: string
  value: unknown
}

export function userOverrideRefKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

export const UserPreferencesRepository = {
  async findOverrides(db: Querier, workspaceId: string, userId: string): Promise<PreferenceOverrideRecord[]> {
    const result = await db.query<PreferenceOverrideRow>(sql`
      SELECT key, value
      FROM user_preference_overrides
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
    `)
    return result.rows.map((row) => ({
      key: row.key,
      value: row.value,
    }))
  },

  /**
   * Read a single override by key, or null when the user has no override for it
   * (i.e. inherits the default). Cheaper than merging the whole preference object
   * when a caller needs one key (INV-27).
   */
  async findOverride(
    db: Querier,
    workspaceId: string,
    userId: string,
    key: string
  ): Promise<PreferenceOverrideRecord | null> {
    const result = await db.query<PreferenceOverrideRow>(sql`
      SELECT key, value
      FROM user_preference_overrides
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND key = ${key}
    `)
    const row = result.rows[0]
    return row ? { key: row.key, value: row.value } : null
  },

  /**
   * The value generation of the user's override for `key` while it holds
   * exactly `value`, or null. The row is share-locked until the caller's
   * transaction ends, so a concurrent change to it commits either before this
   * read (and is seen) or after the caller's writes, never between.
   */
  async findOverrideGeneration(
    db: Querier,
    workspaceId: string,
    userId: string,
    key: string,
    value: unknown
  ): Promise<string | null> {
    const result = await db.query<{ value_generation: string }>(sql`
      SELECT value_generation FROM user_preference_overrides
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND key = ${key}
        AND value = ${JSON.stringify(value)}::jsonb
      FOR SHARE
    `)
    return result.rows[0]?.value_generation ?? null
  },

  async setOverride(db: Querier, workspaceId: string, userId: string, key: string, value: unknown): Promise<void> {
    await db.query(sql`
      INSERT INTO user_preference_overrides (workspace_id, user_id, key, value)
      VALUES (${workspaceId}, ${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (user_id, key) DO UPDATE SET
        value = ${JSON.stringify(value)}::jsonb,
        updated_at = NOW()
    `)
  },

  async bulkSetOverrides(
    db: Querier,
    workspaceId: string,
    userId: string,
    overrides: Array<{ key: string; value: unknown }>
  ): Promise<void> {
    if (overrides.length === 0) return

    const placeholders: string[] = []
    const values: unknown[] = []
    let idx = 1

    for (const { key, value } of overrides) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}::jsonb)`)
      values.push(workspaceId, userId, key, JSON.stringify(value))
    }

    await db.query(
      `INSERT INTO user_preference_overrides (workspace_id, user_id, key, value)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (user_id, key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      values
    )
  },

  async bulkDeleteOverrides(db: Querier, workspaceId: string, userId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return

    await db.query(sql`
      DELETE FROM user_preference_overrides
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND key = ANY(${keys})
    `)
  },

  /** Keyed by `userOverrideRefKey(workspaceId, userId)`. */
  async findOverrideForUsers(
    db: Querier,
    refs: Array<{ workspaceId: string; userId: string }>,
    key: string
  ): Promise<Map<string, unknown>> {
    if (refs.length === 0) return new Map()

    const result = await db.query<Pick<PreferenceOverrideRow, "workspace_id" | "user_id" | "value">>(sql`
      SELECT o.workspace_id, o.user_id, o.value
      FROM unnest(${refs.map((ref) => ref.workspaceId)}::text[], ${refs.map((ref) => ref.userId)}::text[])
        AS ref(workspace_id, user_id)
      JOIN user_preference_overrides o
        ON o.workspace_id = ref.workspace_id
        AND o.user_id = ref.user_id
      WHERE o.key = ${key}
    `)
    return new Map(result.rows.map((row) => [userOverrideRefKey(row.workspace_id, row.user_id), row.value]))
  },
}
