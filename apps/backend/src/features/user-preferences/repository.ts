import { sql, type Querier } from "../../db"

interface PreferenceOverrideRow {
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

export const UserPreferencesRepository = {
  async findOverrides(db: Querier, userId: string): Promise<PreferenceOverrideRecord[]> {
    const result = await db.query<PreferenceOverrideRow>(sql`
      SELECT key, value
      FROM user_preference_overrides
      WHERE user_id = ${userId}
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
  async findOverride(db: Querier, userId: string, key: string): Promise<PreferenceOverrideRecord | null> {
    const result = await db.query<PreferenceOverrideRow>(sql`
      SELECT key, value
      FROM user_preference_overrides
      WHERE user_id = ${userId}
        AND key = ${key}
    `)
    const row = result.rows[0]
    return row ? { key: row.key, value: row.value } : null
  },

  async setOverride(db: Querier, userId: string, key: string, value: unknown): Promise<void> {
    await db.query(sql`
      INSERT INTO user_preference_overrides (user_id, key, value)
      VALUES (${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (user_id, key) DO UPDATE SET
        value = ${JSON.stringify(value)}::jsonb,
        updated_at = NOW()
    `)
  },

  async deleteOverride(db: Querier, userId: string, key: string): Promise<void> {
    await db.query(sql`
      DELETE FROM user_preference_overrides
      WHERE user_id = ${userId}
        AND key = ${key}
    `)
  },

  async bulkSetOverrides(
    db: Querier,
    userId: string,
    overrides: Array<{ key: string; value: unknown }>
  ): Promise<void> {
    if (overrides.length === 0) return

    const placeholders: string[] = []
    const values: unknown[] = []
    let idx = 1

    for (const { key, value } of overrides) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}::jsonb)`)
      values.push(userId, key, JSON.stringify(value))
    }

    await db.query(
      `INSERT INTO user_preference_overrides (user_id, key, value)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (user_id, key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      values
    )
  },

  async bulkDeleteOverrides(db: Querier, userId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return

    await db.query(sql`
      DELETE FROM user_preference_overrides
      WHERE user_id = ${userId}
        AND key = ANY(${keys})
    `)
  },

  async deleteAllOverrides(db: Querier, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM user_preference_overrides
      WHERE user_id = ${userId}
    `)
  },

  async findOverrideForUsers(db: Querier, userIds: string[], key: string): Promise<Map<string, unknown>> {
    if (userIds.length === 0) return new Map()

    const result = await db.query<Pick<PreferenceOverrideRow, "user_id" | "value">>(sql`
      SELECT user_id, value
      FROM user_preference_overrides
      WHERE user_id = ANY(${userIds})
        AND key = ${key}
    `)
    return new Map(result.rows.map((row) => [row.user_id, row.value]))
  },
}
