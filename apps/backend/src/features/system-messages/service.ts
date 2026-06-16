import type { Pool } from "pg"
import { StreamRepository, type Stream } from "../streams"
import { InvitationRepository } from "../invitations"
import type { BudgetAlertOutboxPayload, InvitationAcceptedOutboxPayload } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { StreamTypes, AuthorTypes } from "@threa/types"
import type { AuthorType } from "@threa/types"
import type { Message } from "../messaging"
import { logger } from "../../lib/logger"

interface CreateMessageFn {
  (params: {
    workspaceId: string
    streamId: string
    authorId: string
    authorType: AuthorType
    content: string
  }): Promise<Message>
}

export class SystemMessageService {
  private pool: Pool
  private createMessage: CreateMessageFn

  constructor(deps: { pool: Pool; createMessage: CreateMessageFn }) {
    this.pool = deps.pool
    this.createMessage = deps.createMessage
  }

  async findSystemStream(workspaceId: string, userId: string): Promise<Stream | null> {
    return StreamRepository.findByTypeAndOwner(this.pool, workspaceId, StreamTypes.SYSTEM, userId)
  }

  async notifyUser(workspaceId: string, userId: string, contentMarkdown: string): Promise<void> {
    const stream = await this.findSystemStream(workspaceId, userId)
    if (!stream) {
      logger.error({ workspaceId, userId }, "System stream missing for user — should have been created on join")
      return
    }

    await this.createMessage({
      workspaceId,
      streamId: stream.id,
      authorId: AuthorTypes.SYSTEM,
      authorType: AuthorTypes.SYSTEM,
      content: contentMarkdown,
    })
  }

  /**
   * Owns the message formatting — outbox handler passes structured data (INV-46).
   *
   * TODO: Hardcoded English text — replace with proper i18n/template system
   * when we add translation support.
   */
  async sendBudgetAlert(alert: BudgetAlertOutboxPayload): Promise<void> {
    const { workspaceId, percentUsed, budgetUsd, currentUsageUsd } = alert
    const content = `**Budget alert** — AI usage has reached ${percentUsed}% of your $${budgetUsd}/month budget ($${currentUsageUsd.toFixed(2)} spent).`
    await this.notifyOwners(workspaceId, content)
  }

  async sendInvitationAccepted(payload: InvitationAcceptedOutboxPayload): Promise<void> {
    const { workspaceId, invitationId, userName } = payload

    const invitation = await InvitationRepository.findById(this.pool, invitationId)
    if (!invitation) {
      logger.warn({ invitationId }, "Invitation not found for accepted notification")
      return
    }

    const name = userName || invitation.email

    const content = `**${name}** accepted your invitation and joined the workspace.`
    await this.notifyUser(workspaceId, invitation.invitedBy, content)
  }

  async notifyOwners(workspaceId: string, contentMarkdown: string): Promise<void> {
    const allUsers = await UserRepository.listByWorkspace(this.pool, workspaceId)
    const owners = allUsers.filter((u) => u.role === "owner")

    const existingStreams = await StreamRepository.list(this.pool, workspaceId, {
      types: [StreamTypes.SYSTEM],
    })
    const streamByCreator = new Map(existingStreams.map((s) => [s.createdBy, s]))

    for (const owner of owners) {
      try {
        const stream = streamByCreator.get(owner.id)
        if (!stream) {
          logger.error(
            { workspaceId, userId: owner.id },
            "System stream missing for user — should have been created on join"
          )
          continue
        }

        await this.createMessage({
          workspaceId,
          streamId: stream.id,
          authorId: AuthorTypes.SYSTEM,
          authorType: AuthorTypes.SYSTEM,
          content: contentMarkdown,
        })
      } catch (err) {
        logger.error({ err, workspaceId, userId: owner.id }, "Failed to notify user")
      }
    }
  }
}
