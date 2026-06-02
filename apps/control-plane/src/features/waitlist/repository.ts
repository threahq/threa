import type { Querier } from "@threa/backend-common"

export interface WaitlistRow {
  id: string
  email: string
  source: string | null
  status: string
  created_at: Date
  updated_at: Date
}

export const WaitlistRepository = {
  /**
   * Race-safe signup. Concurrent submissions of the same email collapse to a
   * single row (INV-20); a duplicate is a no-op rather than an error. Returns
   * true when a new row was created, false when the email was already present.
   */
  async insert(db: Querier, entry: { id: string; email: string; source: string | null }): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO waitlist (id, email, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [entry.id, entry.email, entry.source]
    )
    return (result.rowCount ?? 0) > 0
  },
}
