import { authLogId, type Querier } from "@threahq/backend-common"
import type { AuthLogRowInput } from "./mapper"

export const AuthLogRepository = {
  /**
   * Idempotent insert (INV-20). The partial unique index on `workos_event_id`
   * backs `ON CONFLICT DO NOTHING`, so re-ingesting a replayed WorkOS event is
   * a no-op. Own-handler rows carry a NULL event id (not indexed) and always
   * insert. Returns true when a row was written.
   */
  async insert(db: Querier, row: AuthLogRowInput): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO auth_log (
         id,
         occurred_at,
         workos_event_id,
         event_type,
         workos_user_id,
         email,
         organization_id,
         impersonator_email,
         ip,
         user_agent,
         outcome,
         detail
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (workos_event_id) WHERE workos_event_id IS NOT NULL DO NOTHING`,
      [
        authLogId(),
        row.occurredAt,
        row.workosEventId,
        row.eventType,
        row.workosUserId,
        row.email,
        row.organizationId,
        row.impersonatorEmail,
        row.ip,
        row.userAgent,
        row.outcome,
        row.detail === null ? null : JSON.stringify(row.detail),
      ]
    )
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Delete one batch of rows older than `cutoff` (INV-56 set-based). Returns
   * the number deleted so the retention worker can loop until a short batch.
   */
  async deleteOlderThan(db: Querier, cutoff: Date, limit: number): Promise<number> {
    const result = await db.query(
      `DELETE FROM auth_log
       WHERE id IN (
         SELECT id FROM auth_log WHERE occurred_at < $1 LIMIT $2
       )`,
      [cutoff, limit]
    )
    return result.rowCount ?? 0
  },
}
