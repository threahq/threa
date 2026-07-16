import type { Pool } from "pg"
import { OutboxRepository, githubWebhookDeliveryId, logger, withTransaction } from "@threa/backend-common"
import { IntegrationRouteRepository } from "../integration-routes"
import { FORWARDED_GITHUB_EVENT_TYPES, GITHUB_PROVIDER, OUTBOX_GITHUB_WEBHOOK_DISPATCH } from "./constants"
import { GithubWebhookDeliveryRepository } from "./repository"
import { verifyGithubSignature } from "./signature"

interface Dependencies {
  pool: Pool
  webhookSecret: string
}

export interface ReceiveWebhookInput {
  rawBody: Buffer
  signature: string | undefined
  eventType: string | undefined
  deliveryGuid: string | undefined
}

export type ReceiveWebhookResult =
  | { kind: "unauthorized" }
  | { kind: "invalid_payload" }
  | { kind: "pong" }
  | { kind: "ignored" }
  | { kind: "duplicate" }
  | { kind: "accepted"; matchedRegions: string[] }

interface GithubWebhookPayload {
  action?: unknown
  installation?: { id?: unknown } | null
  repository?: { full_name?: unknown } | null
}

const FORWARDED: ReadonlySet<string> = new Set(FORWARDED_GITHUB_EVENT_TYPES)

export class GithubWebhookService {
  private pool: Pool
  private webhookSecret: string

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.webhookSecret = deps.webhookSecret
  }

  /**
   * Verify, dedupe, and fan out one inbound GitHub webhook. Signature is checked
   * over the raw bytes before anything else; regions are resolved from the CP
   * routing table (INV-8 keeps workspace resolution regional); the delivery row
   * and one dispatch event per distinct region are committed atomically (INV-7)
   * so a retry that loses the GUID race fans out nothing.
   */
  async receive(input: ReceiveWebhookInput): Promise<ReceiveWebhookResult> {
    if (!verifyGithubSignature(this.webhookSecret, input.rawBody, input.signature)) {
      return { kind: "unauthorized" }
    }

    if (input.eventType === "ping") {
      return { kind: "pong" }
    }

    if (!input.eventType || !FORWARDED.has(input.eventType)) {
      logger.debug({ eventType: input.eventType }, "Ignoring non-forwarded GitHub webhook event")
      return { kind: "ignored" }
    }

    if (!input.deliveryGuid) {
      return { kind: "invalid_payload" }
    }

    let payload: GithubWebhookPayload
    try {
      payload = JSON.parse(input.rawBody.toString("utf8")) as GithubWebhookPayload
    } catch {
      return { kind: "invalid_payload" }
    }

    const installationId = payload.installation?.id != null ? String(payload.installation.id) : null
    const action = typeof payload.action === "string" ? payload.action : null
    const repositoryFullName = typeof payload.repository?.full_name === "string" ? payload.repository.full_name : null

    const regions = installationId
      ? await IntegrationRouteRepository.listRegions(this.pool, GITHUB_PROVIDER, installationId)
      : []

    const status = regions.length > 0 ? "dispatched" : "no_routes"

    const inserted = await withTransaction(this.pool, async (client) => {
      const row = await GithubWebhookDeliveryRepository.insertIfNew(client, {
        id: githubWebhookDeliveryId(),
        deliveryGuid: input.deliveryGuid!,
        eventType: input.eventType!,
        action,
        installationId,
        repositoryFullName,
        payload: payload as Record<string, unknown>,
        matchedRegions: regions,
        status,
      })
      if (!row) {
        return null
      }
      await OutboxRepository.insertMany(
        client,
        regions.map((region) => ({
          eventType: OUTBOX_GITHUB_WEBHOOK_DISPATCH,
          payload: { deliveryId: row.id, region },
        }))
      )
      return row
    })

    if (!inserted) {
      return { kind: "duplicate" }
    }

    if (regions.length === 0) {
      logger.info(
        { installationId, eventType: input.eventType },
        "GitHub webhook for installation with no routes — acknowledged, no dispatch"
      )
    }

    return { kind: "accepted", matchedRegions: regions }
  }
}
