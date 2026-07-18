import type { Pool } from "pg"
import { logger } from "@threa/backend-common"
import type { RegionalClient } from "../../lib/regional-client"
import type { GithubWebhookDispatchPayload } from "./constants"
import { GithubWebhookDeliveryRepository } from "./repository"

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

export class GithubWebhookDispatchService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.regionalClient = deps.regionalClient
  }

  /**
   * Forward one recorded delivery to a single region's internal endpoint. The
   * outbox event carries only {deliveryId, region}; the payload is read back
   * from the delivery row here so the event stays small and the row is the
   * single source of truth. A throw propagates to the outbox dispatcher for its
   * existing retry/backoff/dead-letter handling.
   */
  async dispatch(payload: GithubWebhookDispatchPayload): Promise<void> {
    const delivery = await GithubWebhookDeliveryRepository.getById(this.pool, payload.deliveryId)
    if (!delivery) {
      logger.warn({ deliveryId: payload.deliveryId }, "GitHub webhook delivery row missing for dispatch")
      return
    }

    await this.regionalClient.dispatchGithubWebhook(payload.region, {
      deliveryGuid: delivery.delivery_guid,
      eventType: delivery.event_type,
      action: delivery.action,
      installationId: delivery.installation_id,
      repositoryFullName: delivery.repository_full_name,
      payload: delivery.payload,
    })
  }
}
