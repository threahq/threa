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

  /**
   * Most recent signups first, capped at `limit`. Backs the backoffice waitlist
   * view — the table only needs a recent window; accurate totals come from
   * {@link statusCounts} so a capped list never skews the headline numbers.
   */
  async list(db: Querier, limit: number): Promise<WaitlistRow[]> {
    const result = await db.query<WaitlistRow>(
      `SELECT id, email, source, status, created_at, updated_at
       FROM waitlist
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    )
    return result.rows
  },

  /**
   * Signup counts grouped by status, computed in the database so the totals are
   * exact regardless of any list cap. Uses the `(status, created_at)` index.
   */
  async statusCounts(db: Querier): Promise<Array<{ status: string; count: number }>> {
    const result = await db.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count
       FROM waitlist
       GROUP BY status`
    )
    return result.rows
  },
}
