import type { Pool } from "pg"
import {
  DebouncedOutboxHandler,
  type DebouncedOutboxHandlerConfig,
  type OutboxEvent,
  type CallInvitationCreatedOutboxPayload,
  type CallInvitationSettledOutboxPayload,
} from "../../lib/outbox"
import { logger } from "../../lib/logger"
import type { PushService } from "./service"

// A ring must not wait behind the debounce/batch window that the activity push
// handler uses — a delayed ring is a missed call. Zero debounce fires the send
// on the next tick, and a small batch keeps ring + cancel in delivery order.
const HANDLER_CONFIG: DebouncedOutboxHandlerConfig = {
  batchSize: 20,
  debounceMs: 0,
  maxWaitMs: 0,
}

interface CallRingPushHandlerDeps {
  pool: Pool
  pushService: PushService
}

/**
 * Delivers the incoming-call ring push (`call:invitation_created`) and its
 * cancellation (`call:invitation_settled`, every outcome). Kept off the shared
 * `push-notifications` handler so its immediate dispatch doesn't share a cursor
 * with the batched activity/reminder pushes. Infrastructure-only (INV-34):
 * preference gating and stale-subscription eviction live in PushService.
 */
export class CallRingPushHandler extends DebouncedOutboxHandler {
  private readonly pushService: PushService

  constructor(deps: CallRingPushHandlerDeps) {
    super(deps.pool, { listenerId: "call-ring-push", ...HANDLER_CONFIG })
    this.pushService = deps.pushService
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType === "call:invitation_created") {
      const payload = event.payload as CallInvitationCreatedOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.attemptId) {
        logger.warn({ eventId: event.id }, "Skipping malformed call:invitation_created payload")
        return
      }
      await this.pushService.deliverCallRing(payload)
      return
    }

    if (event.eventType === "call:invitation_settled") {
      const payload = event.payload as CallInvitationSettledOutboxPayload
      if (!payload?.workspaceId || !payload?.targetUserId || !payload?.attemptId) {
        logger.warn({ eventId: event.id }, "Skipping malformed call:invitation_settled payload")
        return
      }
      await this.pushService.deliverCallRingCancel(payload)
      return
    }
  }
}
