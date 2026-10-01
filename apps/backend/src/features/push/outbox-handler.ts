import type { Pool } from "pg"
import {
  type ActivityCreatedOutboxPayload,
  type OutboxEvent,
  type SavedReminderFiredOutboxPayload,
  type E2eRewrapNudgeOutboxPayload,
} from "../../lib/outbox"
import type { PushService } from "./service"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig } from "../../lib/outbox"

const HANDLER_CONFIG: DebouncedOutboxHandlerConfig = {
  batchSize: 10,
}

interface PushNotificationHandlerDeps {
  pool: Pool
  pushService: PushService
}

/**
 * Listens for outbox events and delegates push planning to PushService.
 * Handles activity:created, saved_reminder:fired, and e2e:rewrap_nudge —
 * every event here results in a VISIBLE notification. stream:read events are
 * deliberately not consumed: pushing a notification-less "clear" burns the
 * browser's silent-push quota and gets the subscription revoked (see
 * PushService.sendAndEvictStale); dismissal is socket + sweep instead.
 * Infrastructure-only: cursor management, batching, and error handling (INV-34).
 */
export class PushNotificationHandler extends DebouncedOutboxHandler {
  private readonly pushService: PushService

  constructor(deps: PushNotificationHandlerDeps) {
    super(deps.pool, { listenerId: "push-notifications", ...HANDLER_CONFIG })
    this.pushService = deps.pushService
  }

  // Planning is sequential within the batch: it stops at the first throw, so
  // the cursor never advances past an event whose delivery rows and jobs were
  // not committed. Planning does no provider I/O — sends happen in the
  // push.deliver worker — so nothing here holds the cursor across the network.
  // The only exception is a legacy saved_reminder:fired event (no reminder
  // generation) from a replica predating durable delivery, sent inline once.
  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType === "activity:created") {
      const payload = event.payload as ActivityCreatedOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.activity) {
        logger.warn({ eventId: event.id }, "Skipping malformed activity:created payload")
        return
      }
      await this.pushService.planActivityPush(event, payload)
      return
    }

    if (event.eventType === "saved_reminder:fired") {
      const payload = event.payload as SavedReminderFiredOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.savedId) {
        logger.warn({ eventId: event.id }, "Skipping malformed saved_reminder:fired payload")
        return
      }
      await this.pushService.planSavedReminderPush(event, payload)
      return
    }

    if (event.eventType === "e2e:rewrap_nudge") {
      const payload = event.payload as E2eRewrapNudgeOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.rootStreamId) {
        logger.warn({ eventId: event.id }, "Skipping malformed e2e:rewrap_nudge payload")
        return
      }
      await this.pushService.planRewrapNudgePush(event, payload)
      return
    }
  }
}
