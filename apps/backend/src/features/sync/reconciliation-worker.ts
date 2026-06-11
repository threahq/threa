import type { Pool } from "pg"
import type { Server } from "socket.io"
import { Ticker } from "@threa/backend-common"
import { logger } from "../../lib/logger"
import { resolveDeliveryGroups, emitToGroups, type OutboxEvent } from "../../lib/outbox"
import { SyncLogRepository, type SyncLogEntryInput } from "./repository"

export interface SyncLogReconciliationWorkerConfig {
  intervalMs?: number
  /** How far behind the DB clock the sweep trails — gives the dispatcher its normal head start. */
  delayMs?: number
  batchSize?: number
  maxBatchesPerRun?: number
}

const DEFAULT_CONFIG = {
  intervalMs: 30_000,
  delayMs: 15_000,
  batchSize: 500,
  maxBatchesPerRun: 10,
}

/**
 * Correctness net for the sync-log spine: the dispatcher's cursor is the
 * latency path, this sweep is the completeness guarantee.
 *
 * Every tick it scans outbox rows in a provably frozen window (see
 * SyncLogRepository.getFrozenCutoff) for client-routed events with no
 * sync_log entry — dispatcher gap-skips, crashes between batches, DLQ'd
 * events — then sequences them (late sync ids are safe: clients order by
 * sync id and apply idempotently by event id) and emits them to their rooms.
 *
 * Finding anything is an anomaly worth alerting on: "no client-routed outbox
 * row older than the sweep window lacks a log entry" is the invariant.
 */
export class SyncLogReconciliationWorker {
  private readonly pool: Pool
  private readonly io: Server
  private readonly config: Required<SyncLogReconciliationWorkerConfig>
  private readonly ticker: Ticker

  constructor(deps: { pool: Pool; io: Server }, config?: SyncLogReconciliationWorkerConfig) {
    this.pool = deps.pool
    this.io = deps.io
    // Per-field ?? instead of object spread: callers pass `undefined` for
    // unset env overrides, and spreading those would clobber the defaults —
    // an undefined delayMs turns the frozen cutoff into NOW() and an
    // undefined intervalMs makes the ticker spin, so the sweep would race
    // the dispatcher and double-emit every event.
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      delayMs: config?.delayMs ?? DEFAULT_CONFIG.delayMs,
      batchSize: config?.batchSize ?? DEFAULT_CONFIG.batchSize,
      maxBatchesPerRun: config?.maxBatchesPerRun ?? DEFAULT_CONFIG.maxBatchesPerRun,
    }
    this.ticker = new Ticker({
      name: "sync-log-reconciliation",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  async start(): Promise<void> {
    await SyncLogRepository.ensureSweepState(this.pool)
    this.ticker.start(() => this.sweepOnce())
    logger.info({ ...this.config }, "SyncLogReconciliationWorker started")
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("SyncLogReconciliationWorker stopped")
  }

  /** One sweep pass; the ticker calls this on its interval. */
  async sweepOnce(): Promise<void> {
    try {
      const sweptUntil = await SyncLogRepository.getSweptUntil(this.pool)
      if (!sweptUntil) {
        // ensureSweepState ran at start(); a missing row means misconfiguration.
        logger.error("sync_log_sweep_state row missing; skipping sweep")
        return
      }

      const cutoff = await SyncLogRepository.getFrozenCutoff(this.pool, this.config.delayMs)
      if (cutoff <= sweptUntil) {
        return
      }

      let batches = 0
      let exhausted = false
      while (batches < this.config.maxBatchesPerRun) {
        const stragglers = await SyncLogRepository.listUnsequencedOutboxEvents(this.pool, {
          since: sweptUntil,
          until: cutoff,
          limit: this.config.batchSize,
        })

        await this.rescue(stragglers)

        batches += 1
        if (stragglers.length < this.config.batchSize) {
          exhausted = true
          break
        }
      }

      // Only advance once the window came back clean — sequenced rows drop out
      // of the anti-join, so a partially swept window is retried, not skipped.
      if (exhausted) {
        await SyncLogRepository.advanceSweptUntil(this.pool, cutoff)
      }
    } catch (err) {
      logger.error({ err }, "sync-log reconciliation sweep failed")
    }
  }

  private async rescue(
    stragglers: Array<{ id: bigint; eventType: string; payload: unknown; createdAt: Date }>
  ): Promise<void> {
    if (stragglers.length === 0) {
      return
    }

    const byWorkspace = new Map<string, Array<{ event: OutboxEvent; entry: SyncLogEntryInput }>>()
    for (const straggler of stragglers) {
      const event = {
        id: straggler.id,
        eventType: straggler.eventType,
        payload: straggler.payload,
        createdAt: straggler.createdAt,
      } as OutboxEvent
      const groups = resolveDeliveryGroups(event)
      // Bot-scoped (null) and unroutable (empty) events live outside the log contract.
      if (groups === null || groups.length === 0) {
        continue
      }
      // The log is workspace-sharded; mirror the sequencer's guard.
      const { workspaceId } = event.payload
      if (typeof workspaceId !== "string" || workspaceId.length === 0) {
        continue
      }
      let entries = byWorkspace.get(workspaceId)
      if (!entries) {
        entries = []
        byWorkspace.set(workspaceId, entries)
      }
      entries.push({
        event,
        entry: { outboxEventId: event.id, eventType: event.eventType, groups, payload: event.payload },
      })
    }

    for (const [workspaceId, entries] of byWorkspace) {
      const assigned = await SyncLogRepository.appendForWorkspace(
        this.pool,
        workspaceId,
        entries.map((e) => e.entry)
      )
      for (const { event, entry } of entries) {
        emitToGroups(this.io, event, entry.groups, assigned.get(event.id))
      }

      logger.warn(
        {
          workspaceId,
          count: entries.length,
          outboxEventIds: entries.map((e) => e.event.id.toString()),
        },
        "sync-log sweep rescued unsequenced outbox events — the dispatcher missed these"
      )
    }
  }
}
