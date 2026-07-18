import type { Querier } from "@threa/backend-common"
import { GITHUB_WEBHOOK_DELIVERY_STATUS } from "./constants"

export interface GithubWebhookDeliveryRow {
  id: string
  delivery_guid: string
  event_type: string
  action: string | null
  installation_id: string | null
  repository_full_name: string | null
  payload: Record<string, unknown>
  matched_regions: string[]
  status: string
  created_at: Date
}

export interface InsertGithubWebhookDelivery {
  id: string
  deliveryGuid: string
  eventType: string
  action: string | null
  installationId: string | null
  repositoryFullName: string | null
  payload: Record<string, unknown>
  matchedRegions: string[]
  status: string
}

export const GithubWebhookDeliveryRepository = {
  /**
   * Idempotent insert keyed on delivery_guid (INV-20). Returns the inserted row,
   * or null when the GUID already exists (GitHub retry) — the caller uses null
   * to short-circuit fan-out so each delivery is dispatched exactly once.
   */
  async insertIfNew(db: Querier, delivery: InsertGithubWebhookDelivery): Promise<GithubWebhookDeliveryRow | null> {
    const result = await db.query<GithubWebhookDeliveryRow>(
      `INSERT INTO github_webhook_deliveries
         (id, delivery_guid, event_type, action, installation_id, repository_full_name, payload, matched_regions, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (delivery_guid) DO NOTHING
       RETURNING id, delivery_guid, event_type, action, installation_id, repository_full_name,
                 payload, matched_regions, status, created_at`,
      [
        delivery.id,
        delivery.deliveryGuid,
        delivery.eventType,
        delivery.action,
        delivery.installationId,
        delivery.repositoryFullName,
        JSON.stringify(delivery.payload),
        delivery.matchedRegions,
        delivery.status,
      ]
    )
    return result.rows[0] ?? null
  },

  async getById(db: Querier, id: string): Promise<GithubWebhookDeliveryRow | null> {
    const result = await db.query<GithubWebhookDeliveryRow>(
      `SELECT id, delivery_guid, event_type, action, installation_id, repository_full_name,
              payload, matched_regions, status, created_at
       FROM github_webhook_deliveries
       WHERE id = $1`,
      [id]
    )
    return result.rows[0] ?? null
  },

  async getByGuid(db: Querier, deliveryGuid: string): Promise<GithubWebhookDeliveryRow | null> {
    const result = await db.query<GithubWebhookDeliveryRow>(
      `SELECT id, delivery_guid, event_type, action, installation_id, repository_full_name,
              payload, matched_regions, status, created_at
       FROM github_webhook_deliveries
       WHERE delivery_guid = $1`,
      [deliveryGuid]
    )
    return result.rows[0] ?? null
  },

  /**
   * Promote a `no_routes` delivery to `dispatched` once routes exist (a redelivery
   * after the rollout window). CAS on `status = 'no_routes'` (INV-20) so two
   * concurrent redeliveries can't both fan out — the loser matches 0 rows.
   */
  async promoteFromNoRoutes(
    db: Querier,
    id: string,
    matchedRegions: string[]
  ): Promise<GithubWebhookDeliveryRow | null> {
    const result = await db.query<GithubWebhookDeliveryRow>(
      `UPDATE github_webhook_deliveries
         SET status = $3, matched_regions = $2
       WHERE id = $1 AND status = $4
       RETURNING id, delivery_guid, event_type, action, installation_id, repository_full_name,
                 payload, matched_regions, status, created_at`,
      [id, matchedRegions, GITHUB_WEBHOOK_DELIVERY_STATUS.DISPATCHED, GITHUB_WEBHOOK_DELIVERY_STATUS.NO_ROUTES]
    )
    return result.rows[0] ?? null
  },
}
