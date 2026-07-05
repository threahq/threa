import type { Pool } from "pg"
import {
  type ActivityCreatedOutboxPayload,
  type OutboxEvent,
  type SavedReminderFiredOutboxPayload,
  type EnclaveRewrapNudgeOutboxPayload,
} from "../../lib/outbox"
import type { PushService } from "./service"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig } from "../../lib/outbox"

// Smaller batch than other outbox handlers: each event triggers external HTTP
// calls (webpush.sendNotification) that hold the cursor lock during network I/O.
const HANDLER_CONFIG: DebouncedOutboxHandlerConfig = {
  batchSize: 10,
}

interface PushNotificationHandlerDeps {
  pool: Pool
  pushService: PushService
}

/**
 * Listens for outbox events and delegates push delivery to PushService.
 * Handles activity:created, saved_reminder:fired, and enclave:rewrap_nudge —
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

  // Delivery is sequential within the batch (the base loops events in order and
  // stops at the first throw). Parallel delivery is tempting but unsafe with
  // CursorLock's sliding-window compaction: if event 8 fails but events 9-10
  // succeed and are added to processedIds, the gap window can expire during
  // retry backoff, causing the cursor to jump past event 8 and permanently lose
  // it. Sequential stops at the first failure, ensuring the cursor never
  // advances past un-delivered events.
  //
  // Push events are low-volume (activity:created, reminders, nudges) so sequential
  // within a batch of 10 has negligible latency impact — the real throughput
  // win is the dedicated realtime pool isolating push from background workers.
  //
  // Per-device webpush failures are handled inside PushService (stale
  // subscription eviction) and don't escape as thrown errors here.
  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType === "activity:created") {
      const payload = event.payload as ActivityCreatedOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.activity) {
        logger.warn({ eventId: event.id }, "Skipping malformed activity:created payload")
        return
      }
      await this.pushService.deliverPushForActivity(payload)
      return
    }

    if (event.eventType === "saved_reminder:fired") {
      const payload = event.payload as SavedReminderFiredOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.savedId) {
        logger.warn({ eventId: event.id }, "Skipping malformed saved_reminder:fired payload")
        return
      }
      await this.pushService.deliverPushForSavedReminder(payload)
      return
    }

    if (event.eventType === "enclave:rewrap_nudge") {
      const payload = event.payload as EnclaveRewrapNudgeOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.rootStreamId) {
        logger.warn({ eventId: event.id }, "Skipping malformed enclave:rewrap_nudge payload")
        return
      }
      await this.pushService.deliverRewrapNudge(payload)
      return
    }
  }
}
