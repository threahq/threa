import type { Pool } from "pg"
import { DebouncedOutboxHandler, isOutboxEventType, type OutboxEvent } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import { WorkspaceRepository } from "./repository"

/**
 * Mirrors a rename into the control-plane registry, which serves the workspace list and the names
 * other workspaces see. Pushes the name read now, not the event's, so retries and out-of-order
 * replays all converge on the latest rename.
 */
export class WorkspaceNameSyncHandler extends DebouncedOutboxHandler {
  private readonly controlPlaneClient: ControlPlaneClient

  constructor(db: Pool, controlPlaneClient: ControlPlaneClient) {
    // Retries for ~28 minutes, so a control-plane deploy or short outage doesn't dead-letter a rename.
    super(db, { listenerId: "workspace-name-sync", maxRetries: 12, baseBackoffMs: 2_000 })
    this.controlPlaneClient = controlPlaneClient
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!isOutboxEventType(event, "workspace:name_updated")) return

    const workspace = await WorkspaceRepository.findById(this.db, event.payload.workspaceId)
    if (!workspace) {
      logger.warn({ workspaceId: event.payload.workspaceId }, "Workspace name sync skipped: workspace not found")
      return
    }
    await this.controlPlaneClient.syncWorkspaceName({ workspaceId: workspace.id, name: workspace.name })
  }
}
