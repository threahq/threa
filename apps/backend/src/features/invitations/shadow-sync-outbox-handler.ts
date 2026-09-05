import type { Pool } from "pg"
import { isOneOfOutboxEventType, isOutboxEventType } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type OutboxEvent } from "../../lib/outbox"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import { UserRepository } from "../workspaces"
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
        "invitation:accepted",
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
        maxUses: invitation.maxUses,
        useCount: invitation.useCount,
        revision: invitation.revision,
        status: invitation.status,
      })
    } else if (isOutboxEventType(event, "invitation:link-claimed")) {
      const { invitationId, parentInvitationId, email, inviterWorkosUserId } = event.payload
      if (!parentInvitationId || parentInvitationId === invitationId) {
        const root = await InvitationRepository.findById(this.db, invitationId)
        if (!root || root.kind !== "link" || root.parentLinkId) return
        await this.controlPlaneClient.notifyInvitationLinkClaimed({
          parentInvitationId: root.id,
          email,
          inviterWorkosUserId,
        })
        return
      }

      const parent = await InvitationRepository.findById(this.db, parentInvitationId)
      if (!parent) return
      await this.controlPlaneClient.notifyInvitationLinkClaimed({
        parentInvitationId,
        childInvitationId: invitationId,
        email,
        expiresAt: parent.expiresAt,
        maxUses: parent.maxUses,
        useCount: parent.useCount,
        revision: parent.revision,
        inviterWorkosUserId,
      })
    } else if (isOutboxEventType(event, "invitation:accepted")) {
      const invitation = await InvitationRepository.findById(this.db, event.payload.invitationId)
      if (
        !invitation ||
        !invitation.acceptedAt ||
        invitation.workspaceId !== event.payload.workspaceId ||
        !invitation.email ||
        invitation.email.toLowerCase() !== event.payload.email.toLowerCase() ||
        !(await UserRepository.isMember(this.db, invitation.workspaceId, event.payload.workosUserId))
      ) {
        throw new Error(`Invitation acceptance ${event.payload.invitationId} does not match regional state`)
      }
      const parentId = invitation.parentLinkId ?? (invitation.kind === "link" ? invitation.id : null)
      const parent = parentId ? await InvitationRepository.findById(this.db, parentId) : null
      if (parentId && !parent) throw new Error(`Invitation parent ${parentId} not found for accepted delivery`)
      await this.controlPlaneClient.acknowledgeInvitationAccepted({
        invitationId: invitation.id,
        workspaceId: invitation.workspaceId,
        email: invitation.email,
        workosUserId: event.payload.workosUserId,
        ...(parent
          ? {
              parentInvitationId: parent.id,
              expiresAt: parent.expiresAt,
              maxUses: parent.maxUses,
              useCount: parent.useCount,
              revision: parent.revision,
              status: parent.status,
            }
          : {}),
      })
    } else if (isOutboxEventType(event, "invitation:revoked")) {
      const invitation = await InvitationRepository.findById(this.db, event.payload.invitationId)
      if (invitation?.kind === "link" && !invitation.parentLinkId) {
        await this.controlPlaneClient.updateInvitationLinkShadow({
          id: invitation.id,
          expiresAt: invitation.expiresAt,
          maxUses: invitation.maxUses,
          useCount: invitation.useCount,
          revision: invitation.revision,
          status: invitation.status,
        })
      } else {
        await this.controlPlaneClient.revokeInvitationShadow(event.payload.invitationId)
      }
    }
  }
}
