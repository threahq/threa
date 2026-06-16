import type { Pool } from "pg"
import { isOneOfOutboxEventType, isOutboxEventType } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type OutboxEvent } from "../../lib/outbox"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import { InvitationRepository } from "./repository"

/** Syncs invitation lifecycle events to the control-plane as shadows. */
export class InvitationShadowSyncHandler extends DebouncedOutboxHandler {
  private readonly controlPlaneClient: ControlPlaneClient
  private readonly region: string

  constructor(db: Pool, controlPlaneClient: ControlPlaneClient, region: string) {
    super(db, { listenerId: "invitation-shadow-sync" })
    this.controlPlaneClient = controlPlaneClient
    this.region = region
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (
      !isOneOfOutboxEventType(event, [
        "invitation:sent",
        "invitation:link-created",
        "invitation:link-claimed",
        "invitation:revoked",
      ])
    ) {
      return
    }

    if (isOutboxEventType(event, "invitation:sent")) {
      const { invitationId, workspaceId, email, role, inviterWorkosUserId } = event.payload
      const invitation = await InvitationRepository.findById(this.db, invitationId)
      if (!invitation) {
        logger.warn({ invitationId }, "Invitation not found for shadow sync, skipping")
        return
      }

      await this.controlPlaneClient.createInvitationShadow({
        id: invitation.id,
        workspaceId,
        region: this.region,
        kind: "email",
        email,
        tokenHash: null,
        roleSlug: role,
        expiresAt: invitation.expiresAt,
        inviterWorkosUserId,
      })
    } else if (isOutboxEventType(event, "invitation:link-created")) {
      const { invitationId, workspaceId, tokenHash, role } = event.payload
      const invitation = await InvitationRepository.findById(this.db, invitationId)
      if (!invitation) {
        logger.warn({ invitationId }, "Link invitation not found for shadow sync, skipping")
        return
      }

      await this.controlPlaneClient.createInvitationShadow({
        id: invitation.id,
        workspaceId,
        region: this.region,
        kind: "link",
        email: null,
        tokenHash,
        roleSlug: role,
        expiresAt: invitation.expiresAt,
      })
    } else if (isOutboxEventType(event, "invitation:link-claimed")) {
      const { invitationId, email, inviterWorkosUserId } = event.payload
      await this.controlPlaneClient.notifyInvitationLinkClaimed({
        id: invitationId,
        email,
        inviterWorkosUserId,
      })
    } else if (event.eventType === "invitation:revoked") {
      const { invitationId } = event.payload
      await this.controlPlaneClient.revokeInvitationShadow(invitationId)
    }
  }
}
