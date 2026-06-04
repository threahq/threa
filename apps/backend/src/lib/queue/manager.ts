import type { Pool } from "pg"
import { withTransaction } from "../../db"
import pLimit from "p-limit"
import type { QueueRepository } from "./repository"
import type { TokenPoolRepository } from "./token-pool-repository"
import { CronRepository, type CronTick } from "./cron-repository"
import { calculateBackoffMs } from "@threa/backend-common"
import { logger } from "../logger"
import type {
  JobDataMap,
  JobQueueName,
  JobHandler,
  HandlerOptions,
  HandlerHooks,
  QueueTier,
  QueueFairnessMode,
} from "./job-queue"
import { QueueFairness, QueueTiers } from "./job-queue"
import { queueId, workerId, tickerId, cronId } from "../id"
import {
  queueMessagesEnqueued,
  queueMessagesInFlight,
  queueMessagesProcessed,
  queueMessageDuration,
  queueTokensStuck,
} from "../observability"
import { isUniqueViolation } from "../errors"

/**
 * Per-tier configuration. Each tier has its own concurrency budget so that
 * slow heavy work (PDF/image/memo) cannot starve interactive work (persona
 * agent responses) by holding every available token.
 */
export interface TierConfig {
  /** Max tokens in flight at once for this tier. */
  maxActiveTokens: number
}

/**
 * Configuration for QueueManager
 */
export interface QueueManagerConfig {
  pool: Pool
  queueRepository: typeof QueueRepository
  tokenPoolRepository: typeof TokenPoolRepository

  // Queue processing config
  lockDurationMs?: number // Default 10000 (10s)
  refreshIntervalMs?: number // Default 5000 (5s)
  maxRetries?: number // Default 5
  baseBackoffMs?: number // Default 500
  scalingThreshold?: number // Default 50 (TODO: implement chunking)
  claimBatchSize?: number // Default 20 (messages to claim per token)
  processingConcurrency?: number // Default 5 (parallel message processing per worker)

  // Adaptive polling config
  pollIntervalMs?: number // Default 500 (sleep between cycles when idle)
  refillDebounceMs?: number // Default 100 (debounce before fetching more tokens)
  stuckTokenWarnMs?: number // Default 60000 (warn once when token runs suspiciously long)

  /**
   * Per-tier concurrency budgets. If not provided, all handlers share a single
   * synthetic "default" tier sized by `maxActiveTokens` (legacy behaviour).
   */
  tiers?: Partial<Record<QueueTier, TierConfig>>
  /**
   * Legacy single global budget. Ignored when `tiers` is provided.
   * @deprecated Prefer `tiers` so interactive work isn't starved by heavy jobs.
   */
  maxActiveTokens?: number // Default 5
}

const DEFAULT_CONFIG = {
  lockDurationMs: 10000,
  refreshIntervalMs: 5000,
  maxRetries: 5,
  baseBackoffMs: 500,
  scalingThreshold: 50,
  claimBatchSize: 20,
  processingConcurrency: 5,
  pollIntervalMs: 500,
  refillDebounceMs: 100,
  stuckTokenWarnMs: 60000,
  maxActiveTokens: 5,
}

/** Synthetic tier used when no `tiers` config is provided. */
const DEFAULT_TIER: QueueTier = QueueTiers.INTERACTIVE

/**
 * Mutable per-tier runtime state. Kept on the QueueManager so polling cycles
 * can enforce each tier's budget independently.
 */
interface TierRuntimeState {
  tier: QueueTier
  budget: number
  fairness: QueueFairnessMode
  queueNames: string[]
  activeTokens: Map<string, Promise<void>>
  refillTimer: Timer | null
  cycleExhausted: boolean
  fillInProgress: boolean
}

/**
 * Custom PostgreSQL queue system that replaces pg-boss.
 *
 * Provides:
 * - High-throughput parallel processing via workspace sharding
 * - Fair scheduling (prevents workspace starvation)
 * - Time-based locks with background refresh
 * - No connection pool exhaustion
 */
export class QueueManager {
  private readonly pool: Pool
  private readonly queueRepo: typeof QueueRepository
  private readonly tokenPoolRepo: typeof TokenPoolRepository
  private readonly lockDurationMs: number
  private readonly refreshIntervalMs: number
  private readonly maxRetries: number
  private readonly baseBackoffMs: number
  private readonly scalingThreshold: number
  private readonly claimBatchSize: number
  private readonly processingConcurrency: number
  private readonly pollIntervalMs: number
  private readonly refillDebounceMs: number
  private readonly stuckTokenWarnMs: number
  /** Configured tier budgets. Undefined tiers fall back to `legacyTierBudget`. */
  private readonly tierBudgets: Partial<Record<QueueTier, number>>
  /** Budget used for tiers not explicitly configured. */
  private readonly legacyTierBudget: number
  private readonly handlers = new Map<string, JobHandler<unknown>>()
  private readonly handlerHooks = new Map<string, HandlerHooks<unknown>>()
  private readonly handlerTiers = new Map<string, QueueTier>()
  private readonly handlerFairness = new Map<string, QueueFairnessMode>()
  private readonly handlerMaxRetries = new Map<string, number>()
  private readonly managerId: string
  private isStarted = false
  private isStopping = false

  // Adaptive polling state. Keyed by `${tier}::${fairness}` — a tier may be
  // split across fairness modes, so each combination gets its own budget slot.
  private pollTimer: Timer | null = null
  private readonly tierState = new Map<string, TierRuntimeState>()
  private cycleStart = 0

  // Track cron tick workers for graceful shutdown (separate from token processing)
  private readonly activeCronWorkers = new Set<Promise<void>>()

  constructor(config: QueueManagerConfig) {
    const {
      pool,
      queueRepository,
      tokenPoolRepository,
      lockDurationMs = DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs = DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries = DEFAULT_CONFIG.maxRetries,
      baseBackoffMs = DEFAULT_CONFIG.baseBackoffMs,
      scalingThreshold = DEFAULT_CONFIG.scalingThreshold,
      claimBatchSize = DEFAULT_CONFIG.claimBatchSize,
      processingConcurrency = DEFAULT_CONFIG.processingConcurrency,
      pollIntervalMs = DEFAULT_CONFIG.pollIntervalMs,
      refillDebounceMs = DEFAULT_CONFIG.refillDebounceMs,
      stuckTokenWarnMs = DEFAULT_CONFIG.stuckTokenWarnMs,
      maxActiveTokens = DEFAULT_CONFIG.maxActiveTokens,
      tiers,
    } = config

    this.pool = pool
    this.queueRepo = queueRepository
    this.tokenPoolRepo = tokenPoolRepository
    this.lockDurationMs = lockDurationMs
    this.refreshIntervalMs = refreshIntervalMs
    this.maxRetries = maxRetries
    this.baseBackoffMs = baseBackoffMs
    this.scalingThreshold = scalingThreshold
    this.claimBatchSize = claimBatchSize
    this.processingConcurrency = processingConcurrency
    this.pollIntervalMs = pollIntervalMs
    this.refillDebounceMs = refillDebounceMs
    this.stuckTokenWarnMs = stuckTokenWarnMs

    // Build tier budget map. If caller supplied `tiers`, use that. Otherwise
    // fall back to legacy single-budget behaviour, represented as one synthetic
    // tier absorbing all registered handlers.
    this.tierBudgets = {}
    if (tiers) {
      for (const [tier, cfg] of Object.entries(tiers) as [QueueTier, TierConfig | undefined][]) {
        if (cfg) this.tierBudgets[tier] = cfg.maxActiveTokens
      }
    }
    this.legacyTierBudget = maxActiveTokens

    this.managerId = tickerId()
  }

  /**
   * Register handler for a queue.
   * Must be called before start().
   *
   * Handlers can declare a `tier` (concurrency budget bucket) and `fairness`
   * (per-workspace vs. global token leasing). See QueueTiers / QueueFairness.
   */
  registerHandler<T extends JobQueueName>(
    queueName: T,
    handler: JobHandler<JobDataMap[T]>,
    options?: HandlerOptions<JobDataMap[T]>
  ): void {
    if (this.isStarted) {
      throw new Error(`Cannot register handler for ${queueName}: queue already started`)
    }
    this.handlers.set(queueName, handler as JobHandler<unknown>)
    this.handlerTiers.set(queueName, options?.tier ?? DEFAULT_TIER)
    this.handlerFairness.set(queueName, options?.fairness ?? QueueFairness.NONE)
    if (options?.maxRetries !== undefined) {
      this.handlerMaxRetries.set(queueName, options.maxRetries)
    }
    if (options?.hooks) {
      this.handlerHooks.set(queueName, options.hooks as HandlerHooks<unknown>)
    }
  }

  /**
   * Build per-tier runtime state from registered handlers. Called once at
   * start() so every handler registration is accounted for.
   *
   * Queues in the same tier can have different fairness modes. When they do,
   * the tier is split into sub-buckets per fairness mode so each sub-bucket
   * can use the correct lease query. Each sub-bucket gets the **full** tier
   * budget — splitting the budget evenly would starve one sub-bucket under
   * single-mode bursts (e.g. with heavy budget=3 and memo(workspace) +
   * pdf/image(none), the larger group of queues would only get 1–2 slots).
   *
   * Consequence: a tier with mixed fairness can temporarily exceed its
   * configured budget (at most N× where N = number of sub-buckets). In
   * practice the sub-buckets rarely saturate simultaneously, and the
   * alternative (strict split) has a worse failure mode. Tune per-tier
   * budgets lower if you rely on mixed fairness.
   */
  private buildTierState(): void {
    const groups = new Map<string, { tier: QueueTier; fairness: QueueFairnessMode; queueNames: string[] }>()
    for (const queueName of this.handlers.keys()) {
      const tier = this.handlerTiers.get(queueName) ?? DEFAULT_TIER
      const fairness = this.handlerFairness.get(queueName) ?? QueueFairness.NONE
      const key = `${tier}::${fairness}`
      const existing = groups.get(key)
      if (existing) {
        existing.queueNames.push(queueName)
      } else {
        groups.set(key, { tier, fairness, queueNames: [queueName] })
      }
    }

    this.tierState.clear()
    for (const [key, group] of groups) {
      const tierBudget = this.tierBudgets[group.tier] ?? this.legacyTierBudget
      this.tierState.set(key, {
        tier: group.tier,
        budget: tierBudget,
        fairness: group.fairness,
        queueNames: group.queueNames,
        activeTokens: new Map(),
        refillTimer: null,
        cycleExhausted: false,
        fillInProgress: false,
      })
    }
  }

  /**
   * Schedule a recurring job (idempotent, atomic).
   * Creates new schedule or updates interval if exists.
   * Uses INSERT ... ON CONFLICT to avoid race conditions.
   *
   * @param queueName - Queue to send messages to
   * @param intervalSeconds - Interval in seconds between job runs
   * @param data - Job data to send
   * @param workspaceId - Optional workspace ID (null = system-wide)
   */
  async schedule<T extends JobQueueName>(
    queueName: T,
    intervalSeconds: number,
    data: JobDataMap[T],
    workspaceId: string | null = null
  ): Promise<void> {
    const scheduleId = cronId()
    const { schedule, created } = await CronRepository.ensureSchedule(this.pool, {
      id: scheduleId,
      queueName,
      intervalSeconds,
      payload: data,
      workspaceId,
    })

    if (created) {
      logger.info({ scheduleId: schedule.id, queueName, intervalSeconds, workspaceId }, "Cron schedule created")
    } else {
      logger.debug({ scheduleId: schedule.id, queueName, intervalSeconds }, "Cron schedule already exists")
    }
  }

  /**
   * Send message to queue.
   * Returns message ID.
   */
  async send<T extends JobQueueName>(
    queueName: T,
    data: JobDataMap[T],
    options?: { processAfter?: Date; messageId?: string }
  ): Promise<string> {
    // Extract workspaceId from job data
    const workspaceId = this.extractWorkspaceId(queueName, data)

    const messageId = options?.messageId ?? queueId()
    const now = new Date()
    const processAfter = options?.processAfter ?? now

    try {
      await this.queueRepo.insert(this.pool, {
        id: messageId,
        queueName,
        workspaceId,
        payload: data,
        processAfter,
        insertedAt: now,
      })
    } catch (error) {
      if (options?.messageId && isUniqueViolation(error, "queue_messages_pkey")) {
        logger.info({ queueName, messageId, workspaceId }, "Queue message already enqueued (idempotent send)")
        return messageId
      }
      throw error
    }

    queueMessagesEnqueued.inc({ queue: queueName, workspace_id: workspaceId })
    logger.debug({ queueName, messageId, workspaceId }, "Message sent to queue")

    return messageId
  }

  /**
   * Start processing with adaptive polling.
   */
  start(): void {
    if (this.isStarted) {
      throw new Error("QueueManager already started")
    }

    this.isStarted = true
    this.buildTierState()
    this.runCycle()

    logger.info(
      {
        tiers: Array.from(this.tierState.values()).map((t) => ({
          tier: t.tier,
          budget: t.budget,
          fairness: t.fairness,
          queueNames: t.queueNames,
        })),
      },
      "QueueManager started"
    )
  }

  /**
   * Graceful shutdown.
   * 1. Stop polling (no new cycles)
   * 2. Clear per-tier refill timers
   * 3. Wait for in-flight tokens with timeout
   * 4. Wait for cron workers
   */
  async stop(): Promise<void> {
    if (this.isStopping) {
      return
    }

    this.isStopping = true
    logger.info("QueueManager stopping...")

    // Stop polling (no new cycles)
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }

    // Stop per-tier refill timers
    for (const state of this.tierState.values()) {
      if (state.refillTimer) {
        clearTimeout(state.refillTimer)
        state.refillTimer = null
      }
    }

    // Wait for active tokens (across all tiers) with timeout
    const allActiveTokens: Promise<void>[] = []
    let activeTokenCount = 0
    for (const state of this.tierState.values()) {
      for (const promise of state.activeTokens.values()) {
        allActiveTokens.push(promise)
        activeTokenCount++
      }
    }
    const allActive = [...allActiveTokens, ...this.activeCronWorkers]
    if (allActive.length > 0) {
      logger.info(
        { activeTokens: activeTokenCount, activeCron: this.activeCronWorkers.size },
        "Waiting for active work to complete"
      )

      const timeout = new Promise((resolve) => setTimeout(resolve, 30000))
      const allWorkers = Promise.all(allActive)

      await Promise.race([allWorkers, timeout])

      let remaining = this.activeCronWorkers.size
      for (const state of this.tierState.values()) {
        remaining += state.activeTokens.size
      }
      if (remaining > 0) {
        logger.warn({ remainingWork: remaining }, "Some work did not complete within timeout")
      }
    }

    logger.info("QueueManager stopped")
  }

  /**
   * Run a single polling cycle.
   *
   * Algorithm:
   * 1. Record cycle start time
   * 2. Reset per-tier exhausted flags
   * 3. Fetch initial tokens for every tier in parallel (each capped at its budget)
   * 4. Process tokens, refilling each tier's slots as they complete (debounced)
   * 5. Process cron ticks
   * 6. Sleep remaining time to reach pollIntervalMs
   *
   * Important: do NOT wait for active tokens to drain before scheduling the
   * next cycle. A single hung handler would otherwise freeze the current cycle
   * forever, preventing later-arriving work from ever being leased even when
   * the tier still has spare budget.
   */
  private async runCycle(): Promise<void> {
    if (this.isStopping) {
      return
    }

    this.cycleStart = Date.now()

    if (this.tierState.size === 0) {
      logger.debug("No handlers registered yet, scheduling next cycle")
      this.scheduleNextCycle(0)
      return
    }

    // Reset per-tier exhausted flag at the start of each cycle so a tier that
    // found nothing last cycle gets another chance.
    for (const state of this.tierState.values()) {
      state.cycleExhausted = false
    }

    // Fetch initial tokens and start processing for each tier in parallel.
    // Use allSettled so a transient lease failure in one tier doesn't abort
    // the cycle for other tiers — interactive work should keep draining even
    // if the heavy tier's lease query hiccups.
    const fillResults = await Promise.allSettled(
      Array.from(this.tierState.values()).map((state) => this.fillSlots(state))
    )
    for (const result of fillResults) {
      if (result.status === "rejected") {
        logger.error({ err: result.reason }, "Tier fillSlots failed during cycle start")
      }
    }

    // Process cron ticks (runs in parallel with token processing)
    await this.processCronTicks()

    // Schedule next cycle after sleeping remaining time
    const elapsed = Date.now() - this.cycleStart
    this.scheduleNextCycle(elapsed)
  }

  /**
   * Fill available token slots for a single tier.
   * Fetches tokens up to (tier.budget - tier.activeTokens.size).
   * Sets tier.cycleExhausted=true when no more tokens available.
   */
  private async fillSlots(state: TierRuntimeState): Promise<void> {
    if (this.isStopping || state.cycleExhausted || state.fillInProgress) {
      return
    }

    state.fillInProgress = true

    try {
      const availableSlots = state.budget - state.activeTokens.size
      if (availableSlots <= 0) {
        return
      }

      const now = new Date()

      const tokens = await this.tokenPoolRepo.batchLeaseTokens(this.pool, {
        leasedBy: this.managerId,
        leasedAt: now,
        leasedUntil: new Date(now.getTime() + this.lockDurationMs),
        now,
        limit: availableSlots,
        queueNames: state.queueNames,
        fairnessMode: state.fairness,
      })

      if (tokens.length === 0) {
        state.cycleExhausted = true
        logger.debug({ tier: state.tier, fairness: state.fairness }, "Tier exhausted for this cycle")
        return
      }

      logger.debug(
        { tier: state.tier, tokenCount: tokens.length, activeTokens: state.activeTokens.size, budget: state.budget },
        "Leased tokens"
      )

      // Start processing each token
      for (const token of tokens) {
        const promise = this.processToken(token).finally(() => {
          state.activeTokens.delete(token.id)
          this.debouncedFillSlots(state)
        })
        state.activeTokens.set(token.id, promise)
      }
    } finally {
      state.fillInProgress = false
    }
  }

  /**
   * Debounced fill slots - waits refillDebounceMs before fetching more tokens.
   * Prevents hammering the database when multiple tokens complete quickly.
   */
  private debouncedFillSlots(state: TierRuntimeState): void {
    if (this.isStopping || state.cycleExhausted) {
      return
    }

    // Clear existing timer
    if (state.refillTimer) {
      clearTimeout(state.refillTimer)
    }

    // Schedule refill after debounce delay
    state.refillTimer = setTimeout(() => {
      state.refillTimer = null
      this.fillSlots(state).catch((err) => {
        logger.error({ err, tier: state.tier }, "Error filling slots, marking tier exhausted")
        // Stop refilling this cycle to prevent hammering on persistent errors
        state.cycleExhausted = true
      })
    }, this.refillDebounceMs)
  }

  /**
   * Schedule the next polling cycle.
   * Sleeps remaining time to reach pollIntervalMs.
   */
  private scheduleNextCycle(elapsedMs: number): void {
    if (this.isStopping) {
      return
    }

    const sleepMs = Math.max(0, this.pollIntervalMs - elapsedMs)
    logger.debug({ elapsedMs, sleepMs }, "Scheduling next cycle")

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.runCycle().catch((err) => {
        logger.error({ err }, "Error in polling cycle")
        // Schedule next cycle anyway to recover
        this.scheduleNextCycle(0)
      })
    }, sleepMs)
  }

  /**
   * Process cron ticks in the current cycle.
   */
  private async processCronTicks(): Promise<void> {
    if (this.isStopping) {
      return
    }

    const now = new Date()
    const ticks = await CronRepository.batchLeaseTicks(this.pool, {
      leasedBy: this.managerId,
      leasedUntil: new Date(now.getTime() + this.lockDurationMs),
      limit: 10,
      now,
    })

    if (ticks.length > 0) {
      logger.debug({ tickCount: ticks.length }, "Leased cron ticks")
      for (const tick of ticks) {
        this.executeTick(tick)
      }
    }
  }

  /**
   * Process messages for a token.
   *
   * Manages token lifecycle:
   * 1. Sets up background token renewal timer
   * 2. Delegates message processing to processMessagesForToken()
   * 3. Cleans up timer and releases token
   *
   * Note: Tracking is handled by fillSlots() via activeTokens Map.
   */
  private async processToken(token: { id: string; queueName: string; workspaceId: string }): Promise<void> {
    // Set up token renewal timer (runs for entire worker lifetime)
    let tokenRenewalInProgress = false
    let isShuttingDown = false
    const startedAt = Date.now()
    const tokenRenewTimer = setInterval(async () => {
      if (isShuttingDown || tokenRenewalInProgress) {
        return
      }

      tokenRenewalInProgress = true
      try {
        const renewed = await this.renewTokenLease(token.id)
        if (!renewed) {
          logger.warn({ tokenId: token.id }, "Failed to renew token lease - may have been taken by another worker")
        } else {
          logger.debug({ tokenId: token.id }, "Token lease renewed")
        }
      } catch (err) {
        logger.warn({ tokenId: token.id, err }, "Failed to renew token lease")
      } finally {
        tokenRenewalInProgress = false
      }
    }, this.refreshIntervalMs)
    const stuckWarnTimer = setTimeout(() => {
      if (isShuttingDown) {
        return
      }

      const runtimeMs = Date.now() - startedAt
      queueTokensStuck.inc({ queue: token.queueName, workspace_id: token.workspaceId })
      logger.warn(
        {
          tokenId: token.id,
          queueName: token.queueName,
          workspaceId: token.workspaceId,
          runtimeMs,
          thresholdMs: this.stuckTokenWarnMs,
        },
        "Queue token exceeded stuck warning threshold"
      )
    }, this.stuckTokenWarnMs)

    try {
      await this.processMessagesForToken(token)
    } finally {
      // Signal shutdown and clear timer immediately to prevent new renewals
      isShuttingDown = true
      clearInterval(tokenRenewTimer)
      clearTimeout(stuckWarnTimer)

      // Wait for any in-progress renewal to complete before releasing token
      while (tokenRenewalInProgress) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      await this.releaseToken(token.id)
    }
  }

  /**
   * Process all messages for a token.
   *
   * Optimized for throughput:
   * 1. Batch claim messages upfront (1 query instead of N)
   * 2. Set up background renewal for ALL claimed messages
   * 3. Process with controlled concurrency (processingConcurrency at a time)
   * 4. Complete messages immediately (no batching - good for observability)
   */
  private async processMessagesForToken(token: { id: string; queueName: string; workspaceId: string }): Promise<void> {
    const workerIdValue = workerId()
    const now = new Date()

    // 1. Batch claim messages upfront
    const messages = await this.queueRepo.batchClaimMessages(this.pool, {
      queueName: token.queueName,
      workspaceId: token.workspaceId,
      claimedBy: workerIdValue,
      claimedAt: now,
      claimedUntil: new Date(now.getTime() + this.lockDurationMs),
      now,
      limit: this.claimBatchSize,
    })

    if (messages.length === 0) {
      return // No work for this token
    }

    logger.debug(
      { messageCount: messages.length, queueName: token.queueName, workspaceId: token.workspaceId },
      "Batch claimed messages"
    )

    // 2. Set up message renewal timer for ALL messages
    const messageIds = messages.map((m) => m.id)
    const completedMessageIds = new Set<string>()
    let messageRenewalInProgress = false

    const messageRenewTimer = setInterval(async () => {
      if (messageRenewalInProgress) {
        logger.debug({ messageIds }, "Skipping batch renewal - previous renewal still in progress")
        return
      }

      // Filter out completed messages from renewal
      const idsToRenew = messageIds.filter((id) => !completedMessageIds.has(id))
      if (idsToRenew.length === 0) {
        return
      }

      messageRenewalInProgress = true
      try {
        const renewed = await this.batchRenewClaims(idsToRenew, workerIdValue)
        logger.debug({ renewedCount: renewed, totalMessages: idsToRenew.length }, "Batch renewed claims")
      } catch (err) {
        logger.warn({ messageIds: idsToRenew, err }, "Failed to batch renew claims")
      } finally {
        messageRenewalInProgress = false
      }
    }, this.refreshIntervalMs)

    try {
      // 3. Process with controlled concurrency (processingConcurrency at a time)
      const limit = pLimit(this.processingConcurrency)

      await Promise.all(
        messages.map((message) =>
          limit(async () => {
            try {
              await this.processMessage(message, workerIdValue, completedMessageIds)
            } catch (err) {
              // Error already logged and handled in processMessage
              // Continue processing other messages
            }
          })
        )
      )
    } finally {
      clearInterval(messageRenewTimer)
    }
  }

  /**
   * Renew token lease.
   * Returns false if lease lost.
   */
  private async renewTokenLease(tokenId: string): Promise<boolean> {
    const now = new Date()

    return await this.tokenPoolRepo.renewLease(this.pool, {
      tokenId,
      leasedBy: this.managerId,
      leasedUntil: new Date(now.getTime() + this.lockDurationMs),
    })
  }

  /**
   * Batch renew claims for multiple messages.
   */
  private async batchRenewClaims(messageIds: string[], workerId: string): Promise<number> {
    const now = new Date()

    return await this.queueRepo.batchRenewClaims(this.pool, {
      messageIds,
      claimedBy: workerId,
      claimedUntil: new Date(now.getTime() + this.lockDurationMs),
    })
  }

  /**
   * Process a single message.
   *
   * Note: Renewal is handled at the batch level by processToken(),
   * not per-message, to reduce database queries.
   */
  private async processMessage(
    message: {
      id: string
      queueName: string
      workspaceId: string
      payload: unknown
      failedCount: number
      insertedAt: Date
    },
    workerId: string,
    completedMessageIds: Set<string>
  ): Promise<void> {
    const workspaceId = message.workspaceId
    // Handler must exist - we only lease tokens for queues with registered handlers
    const handler = this.handlers.get(message.queueName)!

    const startTime = process.hrtime.bigint()
    queueMessagesInFlight.inc({ queue: message.queueName })

    try {
      // Execute handler
      await handler({
        id: message.id,
        name: message.queueName,
        data: message.payload,
      })

      // Success - complete message
      await this.completeMessage(message.id, workerId)
      completedMessageIds.add(message.id)

      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9
      queueMessagesInFlight.dec({ queue: message.queueName })
      queueMessagesProcessed.inc({ queue: message.queueName, status: "success", workspace_id: workspaceId })
      queueMessageDuration.observe({ queue: message.queueName, workspace_id: workspaceId }, durationSeconds)

      logger.debug({ messageId: message.id, queueName: message.queueName }, "Message completed")
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))

      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9
      queueMessagesInFlight.dec({ queue: message.queueName })
      queueMessageDuration.observe({ queue: message.queueName, workspace_id: workspaceId }, durationSeconds)

      logger.warn({ messageId: message.id, queueName: message.queueName, err: error }, "Message processing failed")

      // Calculate new failed_count
      const newFailedCount = message.failedCount + 1
      const maxRetries = this.handlerMaxRetries.get(message.queueName) ?? this.maxRetries

      if (newFailedCount >= maxRetries) {
        // Move to DLQ
        await this.moveMessageToDlq(message, workerId, error)
        completedMessageIds.add(message.id)

        queueMessagesProcessed.inc({ queue: message.queueName, status: "dlq", workspace_id: workspaceId })
        logger.error(
          { messageId: message.id, queueName: message.queueName },
          "Message moved to DLQ after exhausting retries"
        )
      } else {
        // Retry with backoff
        await this.retryMessage(message.id, workerId, error.message, newFailedCount)

        queueMessagesProcessed.inc({ queue: message.queueName, status: "failed", workspace_id: workspaceId })
        logger.debug(
          { messageId: message.id, queueName: message.queueName, retryCount: newFailedCount },
          "Message scheduled for retry"
        )
      }
    }
  }

  /**
   * Complete a message.
   */
  private async completeMessage(messageId: string, workerId: string): Promise<void> {
    const now = new Date()

    await this.queueRepo.complete(this.pool, {
      messageId,
      claimedBy: workerId,
      completedAt: now,
    })
  }

  /**
   * Retry a message with backoff.
   */
  private async retryMessage(
    messageId: string,
    workerId: string,
    error: string,
    newFailedCount: number
  ): Promise<void> {
    const now = new Date()
    const backoffMs = calculateBackoffMs({
      baseMs: this.baseBackoffMs,
      retryCount: newFailedCount,
    })

    await this.queueRepo.fail(this.pool, {
      messageId,
      claimedBy: workerId,
      error,
      processAfter: new Date(now.getTime() + backoffMs),
      now,
    })
  }

  /**
   * Move message to DLQ.
   *
   * If an onDLQ hook is registered, it runs in a savepoint:
   * - Hook writes only persist if the DLQ move commits
   * - Hook failure is logged but doesn't prevent the DLQ move
   */
  private async moveMessageToDlq(
    message: {
      id: string
      queueName: string
      workspaceId: string
      payload: unknown
      failedCount: number
      insertedAt: Date
    },
    workerId: string,
    error: Error
  ): Promise<void> {
    const now = new Date()
    const hooks = this.handlerHooks.get(message.queueName)
    const onDLQHook = hooks?.onDLQ

    if (onDLQHook) {
      await withTransaction(this.pool, async (client) => {
        await this.queueRepo.failDlq(client, {
          messageId: message.id,
          claimedBy: workerId,
          error: error.message,
          dlqAt: now,
        })

        // Run hook in savepoint - failure doesn't prevent DLQ move
        try {
          await withTransaction(client, async (hookClient) => {
            await onDLQHook(hookClient, { id: message.id, name: message.queueName, data: message.payload }, error, {
              failedCount: message.failedCount,
              insertedAt: message.insertedAt,
              workspaceId: message.workspaceId,
            })
          })
        } catch (hookError) {
          logger.error(
            { messageId: message.id, queueName: message.queueName, err: hookError },
            "onDLQ hook failed - DLQ move will still commit"
          )
        }
      })
    } else {
      await this.queueRepo.failDlq(this.pool, {
        messageId: message.id,
        claimedBy: workerId,
        error: error.message,
        dlqAt: now,
      })
    }
  }

  /**
   * Release a token.
   */
  private async releaseToken(tokenId: string): Promise<void> {
    await this.tokenPoolRepo.deleteToken(this.pool, {
      tokenId,
      leasedBy: this.managerId,
    })
  }

  /**
   * Execute a cron tick.
   * Sends message to queue and deletes tick.
   * Runs in background - does not block the polling cycle.
   */
  private executeTick(tick: CronTick): void {
    const workerPromise = (async () => {
      try {
        // Send message to queue (tick payload already denormalized)
        await this.queueRepo.insert(this.pool, {
          id: queueId(),
          queueName: tick.queueName,
          workspaceId: tick.workspaceId || "system",
          payload: tick.payload,
          processAfter: tick.executeAt,
          insertedAt: new Date(),
        })

        logger.debug(
          { scheduleId: tick.scheduleId, queueName: tick.queueName, executeAt: tick.executeAt },
          "Cron tick executed"
        )
      } catch (err) {
        logger.error({ scheduleId: tick.scheduleId, err }, "Failed to execute cron tick")
      } finally {
        // Always delete tick (release schedule)
        try {
          await CronRepository.deleteTick(this.pool, {
            tickId: tick.id,
            leasedBy: this.managerId,
          })
        } catch (err) {
          // Log but don't throw - tick may have already been deleted or lease lost
          logger.warn({ tickId: tick.id, err }, "Failed to delete cron tick")
        }
      }
    })()

    this.activeCronWorkers.add(workerPromise)
    workerPromise.finally(() => this.activeCronWorkers.delete(workerPromise))
  }

  /**
   * Extract workspaceId from job data.
   * All job types must include workspaceId.
   */
  private extractWorkspaceId(queueName: string, data: unknown): string {
    const isObject = data !== null && typeof data === "object"
    const workspaceId = isObject ? (data as Record<string, unknown>).workspaceId : undefined

    if (typeof workspaceId !== "string" || workspaceId === "") {
      throw new Error(`Invalid job data for queue ${queueName}: missing or invalid workspaceId`)
    }

    return workspaceId
  }
}
