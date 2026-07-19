import { logger, type WorkosEventName, type WorkosOrgService } from "@threa/backend-common"
import type { WorkosEventPollerLock } from "../../lib/workos-event-poller-lock"
import { AUTH_LOG_EVENT_TYPES } from "./constants"
import type { AuthLogService } from "./service"

interface Dependencies {
  workosOrgService: WorkosOrgService
  authLogService: AuthLogService
  lock: WorkosEventPollerLock
  /** Time between ticks when there is no work and we hold no lease. */
  pollIntervalMs: number
  /** Per-page event batch size. */
  batchSize: number
}

/**
 * Second WorkOS-event cursor consumer, beside {@link WorkosAuthzPoller}: drains
 * the authentication-surface event set into `auth_log`. Same lease → page →
 * process → advance loop and multi-instance safety (one lease holder at a time;
 * losers no-op) — see `features/workos-authz/poller.ts` for the shared shape.
 *
 * Idempotency lives in the repository (`ON CONFLICT (workos_event_id)`), so a
 * replayed page after a mid-tick crash inserts nothing new.
 */
export class AuthLogPoller {
  private readonly workosOrgService: WorkosOrgService
  private readonly authLogService: AuthLogService
  private readonly lock: WorkosEventPollerLock
  private readonly pollIntervalMs: number
  private readonly batchSize: number

  private running = false
  private currentTick: Promise<void> | null = null
  private tickTimer: ReturnType<typeof setTimeout> | null = null

  constructor({ workosOrgService, authLogService, lock, pollIntervalMs, batchSize }: Dependencies) {
    this.workosOrgService = workosOrgService
    this.authLogService = authLogService
    this.lock = lock
    this.pollIntervalMs = pollIntervalMs
    this.batchSize = batchSize
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.scheduleNext(0)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.tickTimer) {
      clearTimeout(this.tickTimer)
      this.tickTimer = null
    }
    if (this.currentTick) {
      try {
        await this.currentTick
      } catch {
        // already logged
      }
    }
  }

  async tick(): Promise<void> {
    const claim = await this.lock.tryAcquire()
    if (!claim) return

    this.lock.startRefreshTimer()
    try {
      let cursor: string | null = claim.lastEventId
      let drained = false
      while (!drained) {
        const page = await this.workosOrgService.listEvents({
          // Cast: `api_key.revoked` is valid on the live Events API but absent
          // from the SDK 7.82.0 EventName union (see constants.ts).
          events: [...AUTH_LOG_EVENT_TYPES] as WorkosEventName[],
          ...(cursor ? { after: cursor } : {}),
          limit: this.batchSize,
        })
        if (page.data.length === 0) {
          drained = true
          break
        }
        for (const event of page.data) {
          try {
            await this.authLogService.ingestEvent(event)
          } catch (err) {
            // A single un-ingestible event (malformed payload field, etc.) must
            // not stall the cursor and halt the whole auth trail — the event
            // stays fetchable from WorkOS for 90 days if a fix wants to
            // re-ingest it. Log loudly and advance.
            logger.error({ err, eventId: event.id, eventType: event.event }, "auth_log event ingest failed — skipping")
          }
          await this.lock.advance(event.id, new Date(event.createdAt))
          cursor = event.id
        }
        if (page.after === null) {
          drained = true
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, "auth_log event poller tick failed")
      const { shouldRetry } = await this.lock.recordError(message)
      if (!shouldRetry) {
        logger.error({ lastError: message }, "auth_log event poller exhausted retries — manual intervention required")
      }
    } finally {
      this.lock.stopRefreshTimer()
      await this.lock.release()
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null
      this.currentTick = this.tick()
        .catch((err) => {
          logger.error({ err }, "auth_log event poller tick raised")
        })
        .finally(() => {
          this.currentTick = null
          this.scheduleNext(this.pollIntervalMs)
        })
    }, delayMs)
  }
}
