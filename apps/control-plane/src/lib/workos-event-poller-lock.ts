import { randomUUID } from "crypto"
import type { Pool } from "pg"
import { calculateBackoffMs, logger, sql, withClient } from "@threahq/backend-common"

export interface WorkosEventPollerLockConfig {
  pool: Pool
  /** Identifier for the poller — Phase 1 uses "workos-events". */
  name: string
  lockDurationMs: number
  refreshIntervalMs: number
  maxRetries: number
  baseBackoffMs: number
}

interface PollerStateRow {
  name: string
  last_event_id: string | null
  last_event_at: Date | null
  retry_count: number
  retry_after: Date | null
}

/**
 * Time-based lease for the WorkOS event poller. Modeled on
 * `packages/backend-common/src/outbox/cursor-lock.ts` but simpler:
 *
 * - Cursor type is `string | null` (WorkOS opaque event id), not `bigint`.
 * - No sliding-window dedup — WorkOS event ids are globally unique and
 *   idempotency in the mirror comes from the row-level `last_event_at` guard
 *   on upsert (see `WorkosAuthzRepository.upsertMembershipFromEvent`).
 *
 * Atomic claim uses `UPDATE ... WHERE locked_until IS NULL OR locked_until < now()`
 * (with a small clock-drift pad) so multiple control-plane instances can compete
 * safely without `pg_advisory_lock`, which this repo avoids everywhere it
 * coordinates: an advisory lock lives on its connection, so who holds it is
 * invisible to any other query, and a dropped connection releases it silently. A
 * time-based lease is a row anyone can read, and it expires on a clock rather
 * than on a socket.
 */
export class WorkosEventPollerLock {
  private readonly pool: Pool
  private readonly name: string
  private readonly lockDurationMs: number
  private readonly refreshIntervalMs: number
  private readonly maxRetries: number
  private readonly baseBackoffMs: number

  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private runId: string | null = null

  constructor(config: WorkosEventPollerLockConfig) {
    this.pool = config.pool
    this.name = config.name
    this.lockDurationMs = config.lockDurationMs
    this.refreshIntervalMs = config.refreshIntervalMs
    this.maxRetries = config.maxRetries
    this.baseBackoffMs = config.baseBackoffMs
  }

  /** Ensure the poller-state row exists. Idempotent — safe to call on every boot. */
  async ensureRow(): Promise<void> {
    await this.pool.query(sql`
      INSERT INTO workos_event_poller_state (name)
      VALUES (${this.name})
      ON CONFLICT (name) DO NOTHING
    `)
  }

  /**
   * Try to claim the lease. Returns the persisted cursor on success, or
   * `null` if the lease is held by someone else or this poller is in retry
   * backoff. Holder must call {@link release} when done.
   */
  async tryAcquire(now: Date = new Date()): Promise<{ lastEventId: string | null; lastEventAt: Date | null } | null> {
    const lockedUntil = new Date(now.getTime() + this.lockDurationMs)
    // Pad delays takeover past apparent expiry so a holder whose clock is
    // slightly ahead of ours still wins the lease; we subtract (not add) so
    // the pad tightens mutual exclusion under clock skew rather than weakening it.
    const clockDriftPadMs = 100
    this.runId = randomUUID()

    // Backoff is part of the same atomic UPDATE as the lease check — a separate
    // SELECT-then-UPDATE would let another holder set retry_after in
    // recordError() between the read and the write, and we'd trample it.
    const result = await this.pool.query<PollerStateRow>(sql`
      UPDATE workos_event_poller_state
      SET
        locked_until = ${lockedUntil},
        lock_run_id = ${this.runId},
        updated_at = ${now}
      WHERE name = ${this.name}
        AND (retry_after IS NULL OR retry_after <= ${now})
        AND (locked_until IS NULL OR locked_until < ${new Date(now.getTime() - clockDriftPadMs)})
      RETURNING name, last_event_id, last_event_at, retry_count, retry_after
    `)

    if (result.rows.length === 0) {
      this.runId = null
      return null
    }

    const row = result.rows[0]
    return { lastEventId: row.last_event_id, lastEventAt: row.last_event_at }
  }

  /** Persist cursor advance. Resets retry state because forward progress proves health. */
  async advance(lastEventId: string, lastEventAt: Date, now: Date = new Date()): Promise<void> {
    if (!this.runId) return
    await this.pool.query(sql`
      UPDATE workos_event_poller_state
      SET
        last_event_id = ${lastEventId},
        last_event_at = ${lastEventAt},
        retry_count = 0,
        retry_after = NULL,
        last_error = NULL,
        updated_at = ${now}
      WHERE name = ${this.name}
        AND lock_run_id = ${this.runId}
    `)
  }

  /** Stamp last_backfill_at after a successful backfill. */
  async stampBackfill(at: Date = new Date()): Promise<void> {
    await this.pool.query(sql`
      UPDATE workos_event_poller_state
      SET last_backfill_at = ${at}, updated_at = ${at}
      WHERE name = ${this.name}
    `)
  }

  /**
   * Record a poller error and apply exponential backoff via `retry_after`.
   * Returns whether to keep retrying (false once `maxRetries` is exceeded —
   * the caller should fall back to whatever escalation it wants; this lock
   * does not have a DLQ analog).
   *
   * SELECT-then-UPDATE runs on the same client (see `CursorLock.recordError`)
   * so retry_count and retry_after are written together in one round-trip,
   * and the `lock_run_id` guard ensures only the current lease holder writes.
   */
  async recordError(message: string, now: Date = new Date()): Promise<{ shouldRetry: boolean }> {
    if (!this.runId) return { shouldRetry: false }
    const runId = this.runId

    return withClient(this.pool, async (client) => {
      const current = await client.query<{ retry_count: number }>(sql`
        SELECT retry_count
        FROM workos_event_poller_state
        WHERE name = ${this.name} AND lock_run_id = ${runId}
      `)
      if (current.rows.length === 0) return { shouldRetry: false }

      const newRetryCount = current.rows[0].retry_count + 1
      if (newRetryCount > this.maxRetries) {
        await client.query(sql`
          UPDATE workos_event_poller_state
          SET retry_count = ${newRetryCount}, last_error = ${message}, updated_at = ${now}
          WHERE name = ${this.name} AND lock_run_id = ${runId}
        `)
        return { shouldRetry: false }
      }

      const backoffMs = calculateBackoffMs({ baseMs: this.baseBackoffMs, retryCount: newRetryCount })
      const retryAfter = new Date(now.getTime() + backoffMs)
      await client.query(sql`
        UPDATE workos_event_poller_state
        SET
          retry_count = ${newRetryCount},
          retry_after = ${retryAfter},
          last_error = ${message},
          updated_at = ${now}
        WHERE name = ${this.name} AND lock_run_id = ${runId}
      `)
      logger.warn(
        { name: this.name, retryCount: newRetryCount, retryAfter: retryAfter.toISOString() },
        "WorkOS event poller error, will retry after backoff"
      )
      return { shouldRetry: true }
    })
  }

  /** Release the lease. Idempotent — safe to call on shutdown even if nothing held. */
  async release(): Promise<void> {
    if (!this.runId) return
    await this.pool.query(sql`
      UPDATE workos_event_poller_state
      SET locked_until = NULL, lock_run_id = NULL, updated_at = NOW()
      WHERE name = ${this.name} AND lock_run_id = ${this.runId}
    `)
    this.runId = null
  }

  /** Start the lease-refresh timer. Caller is responsible for calling {@link stopRefreshTimer}. */
  startRefreshTimer(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      this.refreshLock().catch((err) => {
        logger.error({ err, name: this.name }, "Failed to refresh WorkOS event poller lock")
      })
    }, this.refreshIntervalMs)
  }

  stopRefreshTimer(): void {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  private async refreshLock(): Promise<void> {
    if (!this.runId) return
    const runId = this.runId
    const now = new Date()
    const lockedUntil = new Date(now.getTime() + this.lockDurationMs)
    const result = await this.pool.query(sql`
      UPDATE workos_event_poller_state
      SET locked_until = ${lockedUntil}, updated_at = ${now}
      WHERE name = ${this.name} AND lock_run_id = ${runId}
    `)
    // If the row no longer matches our run id, another instance has taken
    // over. Drop local ownership so subsequent advance/recordError calls
    // observe `runId === null` and stop writing, and surface the loss so
    // the poller can abort the in-flight tick.
    if (result.rowCount === 0) {
      this.runId = null
      this.stopRefreshTimer()
      throw new Error(`Lost WorkOS event poller lease for ${this.name}`)
    }
  }
}
