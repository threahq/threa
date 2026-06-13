import type { Pool } from "pg"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import { logger } from "../logger"
import { OutboxRepository, type OutboxEvent } from "./repository"
import type { OutboxHandler } from "@threa/backend-common"

/**
 * Tunables shared by every debounced outbox handler. All optional — omitted
 * fields fall back to the canonical defaults below.
 */
export interface DebouncedOutboxHandlerConfig {
  batchSize?: number
  debounceMs?: number
  maxWaitMs?: number
  lockDurationMs?: number
  refreshIntervalMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

/**
 * Canonical tunables shared by every feature outbox handler. Handlers that
 * need different values pass overrides in super() rather than redefining the
 * whole block.
 */
const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

/**
 * Base class for outbox handlers that debounce notifications and process
 * events one batch at a time under a {@link CursorLock}.
 *
 * It owns the scaffolding every feature handler shares:
 * - canonical {@link DEFAULT_CONFIG} merged with per-handler overrides,
 * - {@link CursorLock} + {@link DebounceWithMaxWait} construction,
 * - `ensureListener()` / `handle()` wiring,
 * - the `processEvents()` batch loop with seen-tracking and the
 *   partial-progress error path.
 *
 * Subclasses implement {@link processEvent} with their event-dispatch and
 * domain logic. The base catches per-batch errors and returns them with the
 * ids processed so far, so an event that throws mid-batch retries without
 * losing the events already handled.
 *
 * `processEvents` is `protected` (not private) so a rare handler that needs a
 * different batch shape (pre-filtering, batch-level grouping) can override it
 * while still reusing the construction and wiring above.
 */
export abstract class DebouncedOutboxHandler implements OutboxHandler {
  readonly listenerId: string

  protected readonly db: Pool
  protected readonly batchSize: number
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait

  constructor(db: Pool, opts: { listenerId: string } & DebouncedOutboxHandlerConfig) {
    this.db = db
    this.listenerId = opts.listenerId
    this.batchSize = opts.batchSize ?? DEFAULT_CONFIG.batchSize

    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: opts.lockDurationMs ?? DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: opts.refreshIntervalMs ?? DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: opts.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: opts.baseBackoffMs ?? DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })

    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      opts.debounceMs ?? DEFAULT_CONFIG.debounceMs,
      opts.maxWaitMs ?? DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "DebouncedOutboxHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  handle(): void {
    this.debouncer.trigger()
  }

  protected async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.db, cursor, this.batchSize, processedIds)

      if (events.length === 0) {
        return { status: "no_events" }
      }

      const seen: bigint[] = []

      try {
        for (const event of events) {
          await this.processEvent(event)
          seen.push(event.id)
        }

        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (seen.length > 0) {
          return { status: "error", error, processedIds: seen }
        }

        return { status: "error", error }
      }
    })
  }

  /**
   * Handle a single outbox event. Implementations filter on `event.eventType`
   * and skip-and-return for events they don't care about; the base marks every
   * event as processed once this resolves. Throwing aborts the batch at this
   * event — the events already processed are persisted, this one and the rest
   * are retried.
   */
  protected abstract processEvent(event: OutboxEvent): Promise<void>
}
