import type { Pool } from "pg"
import { WorkspaceIntegrationProviders } from "@threa/types"
import { DebouncedOutboxHandler, isOneOfOutboxEventType, isOutboxEventType, type OutboxEvent } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import type { ControlPlaneClient } from "../../lib/control-plane-client"

const log = logger.child({ module: "github-route-sync" })

/**
 * Durable control-plane route (un)registration. The GitHub integration write
 * commits a `github_route:register` / `github_route:unregister` outbox event in
 * the same transaction; this handler drains it and calls the control plane, so a
 * crash between the local write and the CP call can't strand the two out of sync
 * (the outbox dispatcher retries until the CP call succeeds).
 *
 * When no control-plane client is configured (local single-region dev) it
 * no-ops with a debug log — the integration write only emits these events when a
 * region is set, so in practice a null client never sees one.
 */
export class GithubRouteSyncHandler extends DebouncedOutboxHandler {
  private readonly controlPlaneClient: ControlPlaneClient | null

  constructor(db: Pool, controlPlaneClient: ControlPlaneClient | null) {
    // Raise the retry ceiling well above the default (~5 tries / ~30s) so a
    // multi-minute control-plane outage does NOT dead-letter a route event. Once a
    // route event dead-letters, the documented DLQ re-queue replays it AFTER any
    // newer route event for the same workspace — that out-of-order replay can
    // resurrect a deleted route or delete a live one, contradicting current state.
    // With baseBackoffMs 2000 and maxRetries 12 (backoff caps at 5m/attempt) the
    // handler retries for ~28m before giving up. If an event still dead-letters, do
    // NOT re-queue it — re-run the workspace's route backfill instead, which
    // reconciles to current state regardless of ordering.
    super(db, { listenerId: "github-route-sync", maxRetries: 12, baseBackoffMs: 2_000 })
    this.controlPlaneClient = controlPlaneClient
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!isOneOfOutboxEventType(event, ["github_route:register", "github_route:unregister"])) {
      return
    }

    if (!this.controlPlaneClient) {
      log.debug({ eventType: event.eventType }, "Skipping GitHub route sync — no control plane configured")
      return
    }

    if (isOutboxEventType(event, "github_route:register")) {
      const { workspaceId, installationId, region } = event.payload
      await this.controlPlaneClient.registerIntegrationRoute({
        provider: WorkspaceIntegrationProviders.GITHUB,
        externalId: installationId,
        region,
        workspaceId,
      })
    } else {
      const { workspaceId, installationId } = event.payload
      await this.controlPlaneClient.unregisterIntegrationRoute({
        provider: WorkspaceIntegrationProviders.GITHUB,
        externalId: installationId,
        workspaceId,
      })
    }
  }
}
