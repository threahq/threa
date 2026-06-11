import { Pool } from "pg"
import { ulid } from "ulid"
import { sql, withClient } from "../db/index"
import { calculateBackoffMs } from "../backoff"
import { logger } from "../logger"
import { OutboxRepository } from "./repository"

export interface CursorLockConfig {
  pool: Pool
  listenerId: string
  lockDurationMs: number // e.g., 10000 (10s)
  refreshIntervalMs: number // e.g., 5000 (5s)
  maxRetries: number // e.g., 5
  baseBackoffMs: number // e.g., 1000 (1s)
  batchSize: number // e.g., 100
  gapWindowMs?: number // e.g., 1000 (1s) — how long to keep processed IDs before compacting
  gapCeilingMs?: number // e.g., 60000 (60s) — hard ceiling after which a gap is skipped without liveness proof
}

export type ProcessResult =
  | { status: "processed"; processedIds: bigint[] }
  | { status: "no_events" }
  | { status: "error"; error: Error; processedIds?: bigint[] }

/** Map of eventId -> readAt ISO string */
export type ProcessedIdsMap = Record<string, string>

interface ListenerLockRow {
  listener_id: string
  last_processed_id: string
  processed_ids: ProcessedIdsMap
  retry_count: number
  retry_after: Date | null
  locked_until: Date | null
  lock_run_id: string | null
}

function generateRunId(): string {
  return ulid()
}

const DEFAULT_GAP_WINDOW_MS = 1000
const DEFAULT_GAP_CEILING_MS = 60_000
// Conservative allowance for app-clock (readAt) vs DB-clock (xact_start) skew.
// Padding only delays a skip; it can never cause one.
const CLOCK_SKEW_PAD_MS = 1000

export interface CompactState {
  cursor: bigint
  processedIds: ProcessedIdsMap
}

export interface CompactGapOptions {
  /**
   * Start time of the oldest transaction currently running in the database,
   * or null when none is running. When provided, expiring an entry (which
   * pulls the base cursor over any unfilled gaps below it) requires PROOF the
   * gaps are dead: a gap at id N observed at time t can only be filled by a
   * transaction that was already running at t (it allocated N from the
   * sequence before the higher id became visible), so if every running
   * transaction started after t, the gap's owner has ended and the missing
   * row is either visible by now or never coming.
   */
  oldestRunningTxnStart: Date | null
  /**
   * Wall-clock fallback ceiling: entries older than this expire even without
   * liveness proof, so an abandoned multi-minute transaction cannot stall the
   * cursor forever. Skips at the ceiling are loud (caller logs) and, for the
   * broadcast listener, healable by the sync-log reconciliation sweep.
   */
  gapCeilingMs?: number
}

/**
 * Pure compaction: merges new IDs, expires old entries, advances base cursor.
 *
 * Steps:
 * 1. Merge newly processed IDs into processedIds with readAt = now
 * 2. Find entries where readAt <= now - gapWindowMs (expired)
 * 3. new_base = max(max(expired_ids), base_cursor)
 * 4. Remove all entries where id <= new_base
 * 5. Advance through any remaining entries contiguous with new_base
 *
 * Without `gapOptions`, expiry is purely time-based (the original sliding
 * window). With `gapOptions`, expiry additionally requires the transaction
 * liveness proof described on CompactGapOptions, with gapCeilingMs as the
 * fallback.
 */
export function compact(
  cursor: bigint,
  processedIds: ProcessedIdsMap,
  newIds: bigint[],
  now: Date,
  gapWindowMs: number,
  gapOptions?: CompactGapOptions
): CompactState {
  // 1. Merge new IDs
  const merged = { ...processedIds }
  const nowIso = now.toISOString()
  for (const id of newIds) {
    merged[id.toString()] = nowIso
  }

  // 2. Find expired entries
  const cutoff = now.getTime() - gapWindowMs
  const ceilingCutoff = now.getTime() - (gapOptions?.gapCeilingMs ?? DEFAULT_GAP_CEILING_MS)
  // An entry observed at `readAt` proves gaps below it are dead only if every
  // transaction running now started after it (see CompactGapOptions).
  const provenBefore = gapOptions
    ? gapOptions.oldestRunningTxnStart === null
      ? Number.POSITIVE_INFINITY
      : gapOptions.oldestRunningTxnStart.getTime() - CLOCK_SKEW_PAD_MS
    : Number.POSITIVE_INFINITY
  let maxExpired = cursor
  for (const [idStr, readAt] of Object.entries(merged)) {
    const readAtMs = new Date(readAt).getTime()
    if (readAtMs > cutoff) {
      continue
    }
    if (gapOptions && readAtMs >= provenBefore && readAtMs > ceilingCutoff) {
      // A transaction predating this observation is still running — the gap
      // below could still fill. Hold the window open.
      continue
    }
    const id = BigInt(idStr)
    if (id > maxExpired) {
      maxExpired = id
    }
  }

  // 3. Advance base cursor
  let newBase = maxExpired

  // 4. Remove all entries <= new_base
  const remaining: ProcessedIdsMap = {}
  for (const [idStr, readAt] of Object.entries(merged)) {
    if (BigInt(idStr) > newBase) {
      remaining[idStr] = readAt
    }
  }

  // 5. Advance through contiguous entries above new_base
  let advanced = true
  while (advanced) {
    advanced = false
    const nextStr = (newBase + 1n).toString()
    if (remaining[nextStr] !== undefined) {
      delete remaining[nextStr]
      newBase = newBase + 1n
      advanced = true
    }
  }

  return { cursor: newBase, processedIds: remaining }
}

/**
 * True when the tracked ids (window + new batch) do not form a contiguous run
 * from the base cursor — i.e. compaction could pull the cursor over a missing
 * id. Only then is the transaction-liveness lookup worth a query.
 */
export function hasUnfilledGaps(cursor: bigint, processedIds: ProcessedIdsMap, newIds: bigint[]): boolean {
  const ids = [...Object.keys(processedIds).map(BigInt), ...newIds].sort((a, b) => Number(a - b))
  let expected = cursor + 1n
  for (const id of ids) {
    if (id > expected) {
      return true
    }
    if (id === expected) {
      expected += 1n
    }
  }
  return false
}

/**
 * Time-based cursor lock with sliding window for outbox event processing.
 *
 * PostgreSQL BIGSERIAL allocates IDs at INSERT but rows become visible at
 * COMMIT. Under concurrent transactions, out-of-order commits cause gaps
 * where a higher ID is visible before a lower one. A simple "advance cursor
 * to max seen" approach permanently skips the lower-ID event.
 *
 * The sliding window tracks recently processed event IDs separately from
 * the base cursor. Events in the window are excluded from fetches. After
 * the gap window expires, the base cursor advances past them.
 *
 * Flow:
 * 1. Check if in backoff (retry_after > now) -> return false
 * 2. Try to claim lock -> if failed, return false
 * 3. Start refresh timer
 * 4. Exhaust loop: repeatedly call processor until no_events or error
 *    - After each batch: compact + persist (one DB write)
 * 5. Handle errors (record error, DLQ)
 * 6. Release lock, stop timer
 */
export class CursorLock {
  readonly batchSize: number

  private readonly pool: Pool
  private readonly listenerId: string
  private readonly lockDurationMs: number
  private readonly refreshIntervalMs: number
  private readonly maxRetries: number
  private readonly baseBackoffMs: number
  private readonly gapWindowMs: number
  private readonly gapCeilingMs: number

  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private runId: string | null = null

  constructor(config: CursorLockConfig) {
    this.pool = config.pool
    this.listenerId = config.listenerId
    this.lockDurationMs = config.lockDurationMs
    this.refreshIntervalMs = config.refreshIntervalMs
    this.maxRetries = config.maxRetries
    this.baseBackoffMs = config.baseBackoffMs
    this.batchSize = config.batchSize
    this.gapWindowMs = config.gapWindowMs ?? DEFAULT_GAP_WINDOW_MS
    this.gapCeilingMs = config.gapCeilingMs ?? DEFAULT_GAP_CEILING_MS
  }

  /**
   * Try to acquire lock and exhaust events by repeatedly calling processor.
   *
   * @param processor Function that processes a batch of events.
   *                  Receives (cursor, processedIds) and returns ProcessResult.
   * @param getNow Optional function to get current time (for testing).
   * @returns true if any work was done, false if lock unavailable or in backoff.
   */
  async run(
    processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>,
    getNow: () => Date = () => new Date()
  ): Promise<boolean> {
    const now = getNow()

    // Check if we're in retry backoff
    const isReady = await this.isReadyToProcess(now)
    if (!isReady) {
      return false
    }

    // Try to claim lock
    const lockResult = await this.tryClaimLock(now)
    if (!lockResult) {
      return false
    }

    let { cursor } = lockResult
    let processedIdsMap = lockResult.processedIds
    let didWork = false

    try {
      // Start refresh timer
      this.startRefreshTimer(getNow)

      // Exhaust loop: keep processing until no more events or error
      let continueProcessing = true
      while (continueProcessing) {
        const processedIdsBigints = Object.keys(processedIdsMap).map(BigInt)
        const result = await processor(cursor, processedIdsBigints)

        switch (result.status) {
          case "processed": {
            if (result.processedIds.length === 0) {
              logger.error({ listenerId: this.listenerId }, "Processor returned 'processed' with empty processedIds")
              continueProcessing = false
              break
            }

            // Compact and persist
            const compacted = await this.compactWithGapGuard(cursor, processedIdsMap, result.processedIds, getNow())
            await this.persistProcessedState(compacted, getNow())
            cursor = compacted.cursor
            processedIdsMap = compacted.processedIds
            didWork = true
            break
          }

          case "no_events": {
            // Cursor exhausted - reset retry state if we were in backoff
            await this.resetRetryState(getNow())
            continueProcessing = false
            break
          }

          case "error": {
            // Handle partial progress if processedIds provided
            if (result.processedIds !== undefined && result.processedIds.length > 0) {
              const compacted = await this.compactWithGapGuard(cursor, processedIdsMap, result.processedIds, getNow())
              await this.persistProcessedState(compacted, getNow())
              cursor = compacted.cursor
              processedIdsMap = compacted.processedIds
              didWork = true
            }

            // Record error and handle circuit breaker
            const shouldRetry = await this.recordError(result.error.message, getNow())

            if (!shouldRetry) {
              // Max retries exceeded - move first unprocessed event to DLQ
              const processedIdsBigints = Object.keys(processedIdsMap).map(BigInt)
              await this.moveFirstEventToDLQ(cursor, processedIdsBigints, result.error.message)
            }

            continueProcessing = false
            break
          }
        }
      }
    } finally {
      // Always release lock and stop timer
      this.stopRefreshTimer()
      await this.releaseLock()
    }

    return didWork
  }

  /**
   * Compacts the sliding window, gating gap skips on transaction liveness.
   *
   * When the tracked ids are contiguous from the cursor the plain compaction
   * runs (no extra query). When a gap exists, the oldest running transaction's
   * start time is fetched and gaps are only skipped once provably dead — or
   * once past gapCeilingMs, which is logged loudly because it is the one path
   * that can still lose an event for non-broadcast listeners.
   */
  private async compactWithGapGuard(
    cursor: bigint,
    processedIds: ProcessedIdsMap,
    newIds: bigint[],
    now: Date
  ): Promise<CompactState> {
    if (!hasUnfilledGaps(cursor, processedIds, newIds)) {
      return compact(cursor, processedIds, newIds, now, this.gapWindowMs)
    }

    const oldestRunningTxnStart = await this.fetchOldestRunningTxnStart()
    const guarded = compact(cursor, processedIds, newIds, now, this.gapWindowMs, {
      oldestRunningTxnStart,
      gapCeilingMs: this.gapCeilingMs,
    })

    // Compare with the unguarded result purely for observability: a held gap
    // means a long-running transaction may still commit an event into it.
    const unguarded = compact(cursor, processedIds, newIds, now, this.gapWindowMs)
    if (guarded.cursor < unguarded.cursor) {
      logger.warn(
        {
          listenerId: this.listenerId,
          heldCursor: guarded.cursor.toString(),
          wouldBeCursor: unguarded.cursor.toString(),
          oldestRunningTxnStart: oldestRunningTxnStart?.toISOString() ?? null,
        },
        "Holding outbox gap open: a transaction predating the gap is still running"
      )
    }

    return guarded
  }

  private async fetchOldestRunningTxnStart(): Promise<Date | null> {
    const result = await this.pool.query<{ oldest: Date | null }>(sql`
      SELECT MIN(xact_start) AS oldest
      FROM pg_stat_activity
      WHERE xact_start IS NOT NULL AND datname = current_database()
    `)
    return result.rows[0]?.oldest ?? null
  }

  private async isReadyToProcess(now: Date): Promise<boolean> {
    const result = await this.pool.query<{ retry_after: Date | null }>(sql`
      SELECT retry_after
      FROM outbox_listeners
      WHERE listener_id = ${this.listenerId}
    `)

    if (result.rows.length === 0) {
      return false
    }

    const retryAfter = result.rows[0].retry_after
    if (retryAfter === null) {
      return true
    }

    return now >= retryAfter
  }

  private async tryClaimLock(now: Date): Promise<{ cursor: bigint; processedIds: ProcessedIdsMap } | null> {
    this.runId = generateRunId()
    const lockedUntil = new Date(now.getTime() + this.lockDurationMs)

    // Pad 100ms for clock drift
    const clockDriftPadMs = 100

    const result = await this.pool.query<ListenerLockRow>(sql`
      UPDATE outbox_listeners
      SET
        locked_until = ${lockedUntil},
        lock_run_id = ${this.runId},
        updated_at = ${now}
      WHERE listener_id = ${this.listenerId}
        AND (locked_until IS NULL OR locked_until < ${new Date(now.getTime() + clockDriftPadMs)})
      RETURNING
        listener_id,
        last_processed_id,
        processed_ids,
        retry_count,
        retry_after,
        locked_until,
        lock_run_id
    `)

    if (result.rows.length === 0) {
      this.runId = null
      return null
    }

    const row = result.rows[0]
    return {
      cursor: BigInt(row.last_processed_id),
      processedIds: (row.processed_ids ?? {}) as ProcessedIdsMap,
    }
  }

  private startRefreshTimer(getNow: () => Date): void {
    this.refreshTimer = setInterval(() => {
      this.refreshLock(getNow).catch((err) => {
        logger.error({ err, listenerId: this.listenerId }, "Failed to refresh cursor lock")
      })
    }, this.refreshIntervalMs)
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private async refreshLock(getNow: () => Date): Promise<void> {
    if (!this.runId) return

    const now = getNow()
    const lockedUntil = new Date(now.getTime() + this.lockDurationMs)

    await this.pool.query(sql`
      UPDATE outbox_listeners
      SET
        locked_until = ${lockedUntil},
        updated_at = ${now}
      WHERE listener_id = ${this.listenerId}
        AND lock_run_id = ${this.runId}
    `)
  }

  private async releaseLock(): Promise<void> {
    if (!this.runId) return

    await this.pool.query(sql`
      UPDATE outbox_listeners
      SET
        locked_until = NULL,
        lock_run_id = NULL,
        updated_at = NOW()
      WHERE listener_id = ${this.listenerId}
        AND lock_run_id = ${this.runId}
    `)

    this.runId = null
  }

  private async persistProcessedState(state: CompactState, now: Date): Promise<void> {
    await this.pool.query(sql`
      UPDATE outbox_listeners
      SET
        last_processed_id = GREATEST(last_processed_id, ${state.cursor.toString()}),
        processed_ids = ${JSON.stringify(state.processedIds)},
        last_processed_at = ${now},
        retry_count = 0,
        retry_after = NULL,
        last_error = NULL,
        updated_at = ${now}
      WHERE listener_id = ${this.listenerId}
    `)
  }

  /**
   * Resets retry state without advancing cursor.
   * Called when no_events is returned after recovering from backoff.
   */
  private async resetRetryState(now: Date): Promise<void> {
    // Only update if there's error state to reset (avoid unnecessary writes)
    await this.pool.query(sql`
      UPDATE outbox_listeners
      SET
        retry_count = 0,
        retry_after = NULL,
        last_error = NULL,
        updated_at = ${now}
      WHERE listener_id = ${this.listenerId}
        AND (retry_count > 0 OR retry_after IS NOT NULL OR last_error IS NOT NULL)
    `)
  }

  /**
   * Records an error and sets up retry with exponential backoff.
   * Returns true if should retry, false if max retries exceeded.
   */
  private async recordError(errorMessage: string, now: Date): Promise<boolean> {
    return withClient(this.pool, async (client) => {
      const current = await client.query<{ retry_count: number }>(sql`
        SELECT retry_count
        FROM outbox_listeners
        WHERE listener_id = ${this.listenerId}
      `)

      if (current.rows.length === 0) {
        return false
      }

      const newRetryCount = current.rows[0].retry_count + 1

      if (newRetryCount > this.maxRetries) {
        return false
      }

      const backoffMs = calculateBackoffMs({ baseMs: this.baseBackoffMs, retryCount: newRetryCount })
      const retryAfter = new Date(now.getTime() + backoffMs)

      await client.query(sql`
        UPDATE outbox_listeners
        SET
          retry_count = ${newRetryCount},
          retry_after = ${retryAfter},
          last_error = ${errorMessage},
          updated_at = ${now}
        WHERE listener_id = ${this.listenerId}
      `)

      logger.warn(
        { listenerId: this.listenerId, retryCount: newRetryCount, retryAfter: retryAfter.toISOString() },
        "Recorded error, will retry after backoff"
      )

      return true
    })
  }

  private async moveFirstEventToDLQ(cursor: bigint, processedIds: bigint[], errorMessage: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      // Fetch the first unprocessed event after cursor
      const events = await OutboxRepository.fetchAfterId(client, cursor, 1, processedIds)
      if (events.length === 0) {
        logger.warn({ listenerId: this.listenerId, cursor: cursor.toString() }, "No event to move to DLQ")
        return
      }

      const event = events[0]

      // Insert into dead letter queue
      await client.query(sql`
        INSERT INTO outbox_dead_letters (listener_id, outbox_event_id, error)
        VALUES (${this.listenerId}, ${event.id.toString()}, ${errorMessage})
      `)

      // Compact with gapWindowMs=0 so the DLQ'd event expires immediately
      const processedIdsMap: ProcessedIdsMap = {}
      for (const id of processedIds) {
        processedIdsMap[id.toString()] = new Date().toISOString()
      }
      const compacted = compact(cursor, processedIdsMap, [event.id], new Date(), 0)

      await client.query(sql`
        UPDATE outbox_listeners
        SET
          last_processed_id = GREATEST(last_processed_id, ${compacted.cursor.toString()}),
          processed_ids = ${JSON.stringify(compacted.processedIds)},
          last_processed_at = NOW(),
          retry_count = 0,
          retry_after = NULL,
          last_error = NULL,
          updated_at = NOW()
        WHERE listener_id = ${this.listenerId}
      `)

      logger.error(
        { listenerId: this.listenerId, eventId: event.id.toString(), eventType: event.eventType },
        "Moved event to dead letter queue after max retries"
      )
    })
  }
}

/**
 * Ensures a listener exists, creating it if necessary.
 * Used during startup to register new listeners.
 *
 * WARNING: Default startFromId=0 will cause new listeners to process ALL historical events.
 * Use ensureListenerFromLatest() to start from the current position instead.
 */
export async function ensureListener(pool: Pool, listenerId: string, startFromId: bigint = 0n): Promise<void> {
  await pool.query(sql`
    INSERT INTO outbox_listeners (listener_id, last_processed_id)
    VALUES (${listenerId}, ${startFromId.toString()})
    ON CONFLICT (listener_id) DO NOTHING
  `)
}

/**
 * Ensures a listener exists, starting from the latest outbox event.
 * New listeners will only process events created after registration.
 * Use this for listeners that don't need to backfill historical events.
 */
export async function ensureListenerFromLatest(pool: Pool, listenerId: string): Promise<void> {
  await pool.query(sql`
    INSERT INTO outbox_listeners (listener_id, last_processed_id)
    SELECT ${listenerId}, COALESCE(MAX(id), 0)
    FROM outbox
    ON CONFLICT (listener_id) DO NOTHING
  `)
}
