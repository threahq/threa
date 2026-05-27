import type { Pool, PoolClient } from "pg"
import { withClient, withTransaction } from "../../db"
import { AIUsageRepository, type UsageSummary, type AIUsageOrigin } from "./usage-repository"
import { AIBudgetRepository } from "./budget-repository"
import { OutboxRepository } from "../../lib/outbox"
import { aiUsageId, aiAlertId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { UsageWithCost, ParsedModel } from "@threa/agent-runtime"

/** Alert thresholds to check */
const ALERT_THRESHOLDS = [
  { percent: 50, type: "budget_50", alertField: "alertThreshold50" as const },
  { percent: 80, type: "budget_80", alertField: "alertThreshold80" as const },
  { percent: 100, type: "budget_100", alertField: "alertThreshold100" as const },
]

export interface RecordUsageParams {
  workspaceId: string
  userId?: string
  sessionId?: string
  functionId: string
  model: string
  provider: string
  origin: AIUsageOrigin
  usage: UsageWithCost
  metadata?: Record<string, unknown>
}

export interface AICostServiceConfig {
  pool: Pool
}

/** Interface for AI cost service implementations */
export interface AICostServiceLike {
  recordUsage(params: RecordUsageParams): Promise<void>
  getWorkspaceUsage(workspaceId: string): Promise<UsageSummary>
  getCurrentMonthUsage(workspaceId: string): Promise<UsageSummary>
}

/**
 * Service for recording AI usage costs and querying usage data.
 * This is called after each AI operation to persist cost tracking data.
 */
export class AICostService implements AICostServiceLike {
  private pool: Pool

  constructor(config: AICostServiceConfig) {
    this.pool = config.pool
  }

  /**
   * Record an AI usage event.
   * Called after each AI operation completes.
   * Also checks for budget threshold alerts.
   */
  async recordUsage(params: RecordUsageParams): Promise<void> {
    const cost = params.usage.cost ?? 0

    if (cost === 0 && params.usage.totalTokens === 0) {
      logger.debug(
        { functionId: params.functionId, model: params.model },
        "Skipping usage record with no cost or tokens"
      )
      return
    }

    await withTransaction(this.pool, async (client) => {
      // Record the usage
      await AIUsageRepository.insert(client, {
        id: aiUsageId(),
        workspaceId: params.workspaceId,
        userId: params.userId,
        sessionId: params.sessionId,
        functionId: params.functionId,
        model: params.model,
        provider: params.provider,
        promptTokens: params.usage.promptTokens ?? 0,
        completionTokens: params.usage.completionTokens ?? 0,
        totalTokens: params.usage.totalTokens ?? 0,
        costUsd: cost,
        origin: params.origin,
        metadata: params.metadata,
      })

      // Check and fire alerts within the same transaction
      // Outbox pattern handles delivery - we just ensure the event is inserted atomically
      await this.checkAndFireAlerts(client, params.workspaceId)
    })

    logger.debug(
      {
        workspaceId: params.workspaceId,
        functionId: params.functionId,
        model: params.model,
        cost,
        tokens: params.usage.totalTokens,
      },
      "AI usage recorded"
    )
  }

  /**
   * Check if any budget thresholds have been crossed and fire alerts.
   */
  private async checkAndFireAlerts(client: PoolClient, workspaceId: string): Promise<void> {
    // Get budget settings
    const budget = await AIBudgetRepository.findByWorkspace(client, workspaceId)
    if (!budget) {
      return // No budget configured, skip alerts
    }

    // Get current usage
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()
    const usage = await AIUsageRepository.getWorkspaceUsage(client, workspaceId, periodStart, periodEnd)

    const currentUsageUsd = Number(usage.totalCostUsd)
    const budgetUsd = Number(budget.monthlyBudgetUsd)
    const percentUsed = budgetUsd > 0 ? (currentUsageUsd / budgetUsd) * 100 : 0

    // Check each threshold
    for (const threshold of ALERT_THRESHOLDS) {
      // Check if this alert type is enabled in budget settings
      if (!budget[threshold.alertField]) {
        continue
      }

      // Check if we've crossed this threshold
      if (percentUsed >= threshold.percent) {
        // Check if we've already sent this alert this period
        const existingAlert = await AIBudgetRepository.findAlert(client, workspaceId, threshold.type, periodStart)

        if (existingAlert) {
          continue // Already sent this alert
        }

        // Record the alert to prevent duplicates
        await AIBudgetRepository.insertAlert(client, {
          id: aiAlertId(),
          workspaceId,
          alertType: threshold.type,
          thresholdPercent: threshold.percent,
          periodStart,
        })

        // Publish alert event via outbox
        await OutboxRepository.insert(client, "budget:alert", {
          workspaceId,
          alertType: threshold.type,
          thresholdPercent: threshold.percent,
          currentUsageUsd,
          budgetUsd,
          percentUsed: Math.round(percentUsed),
        })

        logger.info(
          {
            workspaceId,
            alertType: threshold.type,
            percentUsed: Math.round(percentUsed),
            currentUsageUsd,
            budgetUsd,
          },
          "Budget alert threshold crossed"
        )
      }
    }
  }

  /**
   * Record usage with a parsed model.
   * Convenience method that extracts provider from parsed model.
   */
  async recordUsageWithParsedModel(
    params: Omit<RecordUsageParams, "provider"> & { parsedModel: ParsedModel }
  ): Promise<void> {
    return this.recordUsage({
      ...params,
      model: params.parsedModel.modelId,
      provider: params.parsedModel.provider,
    })
  }

  /**
   * Get usage summary for current billing month.
   */
  async getCurrentMonthUsage(workspaceId: string): Promise<UsageSummary> {
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()

    return AIUsageRepository.getWorkspaceUsage(this.pool, workspaceId, periodStart, periodEnd)
  }

  /**
   * Get usage summary for a specific date range.
   */
  async getWorkspaceUsage(workspaceId: string): Promise<UsageSummary> {
    return this.getCurrentMonthUsage(workspaceId)
  }

  /**
   * Get usage summary for a user within current billing month.
   */
  async getUserCurrentMonthUsage(workspaceId: string, userId: string): Promise<UsageSummary> {
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()

    return withClient(this.pool, (client) =>
      AIUsageRepository.getUserUsage(client, workspaceId, userId, periodStart, periodEnd)
    )
  }

  /**
   * Get usage breakdown by model for current month.
   */
  async getUsageByModel(workspaceId: string) {
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()

    return AIUsageRepository.getUsageByModel(this.pool, workspaceId, periodStart, periodEnd)
  }

  /**
   * Get usage breakdown by function for current month.
   */
  async getUsageByFunction(workspaceId: string) {
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()

    return AIUsageRepository.getUsageByFunction(this.pool, workspaceId, periodStart, periodEnd)
  }

  /**
   * Get usage breakdown by user for current month.
   */
  async getUsageByUser(workspaceId: string) {
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()

    return withClient(this.pool, (client) =>
      AIUsageRepository.getUsageByUser(client, workspaceId, periodStart, periodEnd)
    )
  }

  /**
   * Get usage breakdown by origin (system vs user) for current month.
   */
  async getUsageByOrigin(workspaceId: string) {
    const { periodStart, periodEnd } = this.getCurrentMonthPeriod()

    return AIUsageRepository.getUsageByOrigin(this.pool, workspaceId, periodStart, periodEnd)
  }

  /**
   * Get recent usage records.
   */
  async getRecentUsage(workspaceId: string, options?: { limit?: number; userId?: string }) {
    return withClient(this.pool, (client) => AIUsageRepository.listRecent(client, workspaceId, options))
  }

  private getCurrentMonthPeriod(): { periodStart: Date; periodEnd: Date } {
    const now = new Date()
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return { periodStart, periodEnd }
  }
}

/**
 * Create a no-op cost service for testing or when cost tracking is disabled.
 */
export function createNoOpCostService(): AICostServiceLike {
  return {
    async recordUsage() {
      // No-op
    },
    async getWorkspaceUsage() {
      return { totalCostUsd: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, recordCount: 0 }
    },
    async getCurrentMonthUsage() {
      return { totalCostUsd: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, recordCount: 0 }
    },
  }
}
