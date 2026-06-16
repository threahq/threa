import type { Pool } from "pg"
import type { BudgetAlertOutboxPayload, InvitationAcceptedOutboxPayload } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type OutboxEvent } from "../../lib/outbox"
import type { SystemMessageService } from "./service"

/** Converts outbox events into system messages posted to each user's system stream. */
export class SystemMessageOutboxHandler extends DebouncedOutboxHandler {
  private readonly systemMessageService: SystemMessageService

  constructor(db: Pool, systemMessageService: SystemMessageService) {
    super(db, { listenerId: "system-messages" })
    this.systemMessageService = systemMessageService
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType === "budget:alert") {
      await this.handleBudgetAlert(event.payload as BudgetAlertOutboxPayload)
    } else if (event.eventType === "invitation:accepted") {
      await this.handleInvitationAccepted(event.payload as InvitationAcceptedOutboxPayload)
    }
  }

  private async handleBudgetAlert(payload: BudgetAlertOutboxPayload): Promise<void> {
    await this.systemMessageService.sendBudgetAlert(payload)

    logger.info(
      {
        workspaceId: payload.workspaceId,
        percentUsed: payload.percentUsed,
        budgetUsd: payload.budgetUsd,
        currentUsageUsd: payload.currentUsageUsd,
      },
      "Budget alert notification sent to workspace"
    )
  }

  private async handleInvitationAccepted(payload: InvitationAcceptedOutboxPayload): Promise<void> {
    await this.systemMessageService.sendInvitationAccepted(payload)

    logger.info(
      {
        workspaceId: payload.workspaceId,
        invitationId: payload.invitationId,
        workosUserId: payload.workosUserId,
      },
      "Invitation accepted notification sent to inviter"
    )
  }
}
