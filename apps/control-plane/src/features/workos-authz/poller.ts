import { logger, type WorkosOrgService } from "@threahq/backend-common"
import type { WorkosEventPollerLock } from "../../lib/workos-event-poller-lock"
import type { WorkosAuthzService } from "./service"

interface Dependencies {
  workosOrgService: WorkosOrgService
  authzService: WorkosAuthzService
  lock: WorkosEventPollerLock
  /** Time between ticks when there is no work and we hold no lease. */
  pollIntervalMs: number
  /** Per-page event batch size. */
  batchSize: number
}

/**
 * Long-lived loop that drains WorkOS membership events into the local mirror.
 *
 * Modeled on the outbox dispatcher in `apps/control-plane/src/server.ts:75-87`:
 * a single instance owns the lease at any time, but multiple control-plane
 * instances are safe — losers just no-op until the lease frees up.
 *
 * Per tick:
 *   1. Try to claim the lease. Skip if held / in backoff.
 *   2. Start the lease-refresh timer.
 *   3. Drain WorkOS pages until empty, calling the authz service for each
 *      event, advancing the cursor after every successful event.
 *   4. Release the lease and stop the refresh timer.
 *
 * Errors are reported via `lock.recordError`, which applies exponential
 * backoff. Forward progress on any tick resets the retry counter via
 * `lock.advance` so transient hiccups don't snowball.
 */
export class WorkosAuthzPoller {
  private readonly workosOrgService: WorkosOrgService
  private readonly authzService: WorkosAuthzService
  private readonly lock: WorkosEventPollerLock
  private readonly pollIntervalMs: number
  private readonly batchSize: number

  private running = false
  private currentTick: Promise<void> | null = null
  private tickTimer: ReturnType<typeof setTimeout> | null = null

  constructor({ workosOrgService, authzService, lock, pollIntervalMs, batchSize }: Dependencies) {
    this.workosOrgService = workosOrgService
    this.authzService = authzService
    this.lock = lock
    this.pollIntervalMs = pollIntervalMs
    this.batchSize = batchSize
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.scheduleNext(0)
  }

  /** Stops scheduling new ticks and waits for the current tick to finish. */
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

  /**
   * Run a single tick on demand. Useful for tests and the bootstrap path
   * (`server.ts` calls this once on startup so the mirror catches up before
   * accepting traffic, when a lease is available).
   */
  async tick(): Promise<void> {
    const claim = await this.lock.tryAcquire()
    if (!claim) return

    this.lock.startRefreshTimer()
    try {
      let cursor: string | null = claim.lastEventId
      let drained = false
      while (!drained) {
        const page = await this.workosOrgService.listMirrorEvents({
          ...(cursor ? { after: cursor } : {}),
          limit: this.batchSize,
        })
        if (page.data.length === 0) {
          drained = true
          break
        }
        for (const event of page.data) {
          await this.authzService.processEvent(event)
          await this.lock.advance(event.id, event.createdAt)
          cursor = event.id
        }
        if (page.after === null) {
          drained = true
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, "WorkOS event poller tick failed")
      const { shouldRetry } = await this.lock.recordError(message)
      if (!shouldRetry) {
        logger.error({ lastError: message }, "WorkOS event poller exhausted retries — manual intervention required")
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
          logger.error({ err }, "WorkOS event poller tick raised")
        })
        .finally(() => {
          this.currentTick = null
          this.scheduleNext(this.pollIntervalMs)
        })
    }, delayMs)
  }
}
