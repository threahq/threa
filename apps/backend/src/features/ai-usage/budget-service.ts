import type { Pool, PoolClient } from "pg"
import { withClient } from "../../db"
import { AIBudgetRepository } from "./budget-repository"
import { AIUsageRepository } from "./usage-repository"
import { resolveBudgetMonthRange } from "./billing-window"
import { aiBudgetId } from "../../lib/id"
import { logger } from "../../lib/logger"

const DEFAULT_MONTHLY_BUDGET_USD = 50.0

const SOFT_LIMIT_THRESHOLD = 0.8 // 80% - start degrading models

/** Full model IDs with provider prefix to match the format used in AI calls. */
const MODEL_DEGRADATION_MAP: Record<string, string> = {
  "openrouter:anthropic/claude-sonnet-5": "openrouter:anthropic/claude-haiku-4.5",
  "openrouter:anthropic/claude-sonnet-4.6": "openrouter:anthropic/claude-haiku-4.5",
  "openrouter:anthropic/claude-sonnet-4-20250514": "openrouter:anthropic/claude-haiku-4.5",
  "openrouter:anthropic/claude-sonnet-4.5": "openrouter:anthropic/claude-haiku-4.5",
  "openrouter:anthropic/claude-sonnet-4": "openrouter:anthropic/claude-haiku-4.5",

  "openrouter:openai/gpt-4o": "openrouter:openai/gpt-4o-mini",
  "openrouter:openai/gpt-5": "openrouter:openai/gpt-5-mini",
  "openrouter:openai/gpt-5-turbo": "openrouter:openai/gpt-5-mini",
}

export interface BudgetStatus {
  allowed: boolean
  reason?: "within_budget" | "soft_limit" | "hard_limit"
  currentUsageUsd: number
  budgetUsd: number
  percentUsed: number
  /** Recommended model if degradation is suggested */
  recommendedModel?: string
}

export interface AIBudgetServiceConfig {
  pool: Pool
}

export interface AIBudgetServiceLike {
  /**
   * Check if a workspace is within budget for AI usage.
   * Returns budget status including whether the operation should proceed.
   */
  checkBudget(workspaceId: string, requestedModel?: string): Promise<BudgetStatus>

  /**
   * Get the recommended model based on current budget status.
   * May return a cheaper model if over soft limit.
   */
  getRecommendedModel(workspaceId: string, requestedModel: string): Promise<string>

  /**
   * Ensure a budget exists for a workspace, creating default if needed.
   */
  ensureBudget(workspaceId: string): Promise<void>

  /**
   * Set the monthly budget for a workspace.
   */
  setMonthlyBudget(workspaceId: string, budgetUsd: number): Promise<void>
}

export class AIBudgetService implements AIBudgetServiceLike {
  private pool: Pool

  constructor(config: AIBudgetServiceConfig) {
    this.pool = config.pool
  }

  async checkBudget(workspaceId: string, requestedModel?: string): Promise<BudgetStatus> {
    return withClient(this.pool, async (client) => {
      let budget = await AIBudgetRepository.findByWorkspace(client, workspaceId)
      if (!budget) {
        budget = await this.createDefaultBudget(client, workspaceId)
      }

      const { start, end } = await resolveBudgetMonthRange(client, workspaceId)
      const usage = await AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end)
      const currentUsageUsd = Number(usage.totalCostUsd)
      const budgetUsd = Number(budget.monthlyBudgetUsd)
      const percentUsed = budgetUsd > 0 ? currentUsageUsd / budgetUsd : 0

      const hardLimitThreshold = budget.hardLimitPercent / 100
      if (budget.hardLimitEnabled && percentUsed >= hardLimitThreshold) {
        logger.warn(
          { workspaceId, currentUsageUsd, budgetUsd, percentUsed, hardLimitPercent: budget.hardLimitPercent },
          "AI budget hard limit reached"
        )
        return {
          allowed: false,
          reason: "hard_limit",
          currentUsageUsd,
          budgetUsd,
          percentUsed,
        }
      }

      if (budget.degradationEnabled && percentUsed >= SOFT_LIMIT_THRESHOLD) {
        logger.info(
          { workspaceId, currentUsageUsd, budgetUsd, percentUsed },
          "AI budget soft limit reached, suggesting model degradation"
        )
        const recommendedModel = requestedModel ? this.getDegradedModel(requestedModel) : undefined

        return {
          allowed: true,
          reason: "soft_limit",
          currentUsageUsd,
          budgetUsd,
          percentUsed,
          recommendedModel,
        }
      }

      return {
        allowed: true,
        reason: "within_budget",
        currentUsageUsd,
        budgetUsd,
        percentUsed,
      }
    })
  }

  async getRecommendedModel(workspaceId: string, requestedModel: string): Promise<string> {
    const status = await this.checkBudget(workspaceId, requestedModel)

    if (status.reason === "soft_limit" && status.recommendedModel) {
      logger.debug(
        { workspaceId, requestedModel, recommendedModel: status.recommendedModel, percentUsed: status.percentUsed },
        "Recommending model degradation due to budget"
      )
      return status.recommendedModel
    }

    return requestedModel
  }

  async ensureBudget(workspaceId: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      const existing = await AIBudgetRepository.findByWorkspace(client, workspaceId)
      if (!existing) {
        await this.createDefaultBudget(client, workspaceId)
      }
    })
  }

  async setMonthlyBudget(workspaceId: string, budgetUsd: number): Promise<void> {
    // Single upsert query, INV-30
    await AIBudgetRepository.upsert(this.pool, {
      id: aiBudgetId(),
      workspaceId,
      monthlyBudgetUsd: budgetUsd,
    })
  }

  private getDegradedModel(modelId: string): string {
    return MODEL_DEGRADATION_MAP[modelId] ?? modelId
  }

  private async createDefaultBudget(client: PoolClient, workspaceId: string) {
    return AIBudgetRepository.upsert(client, {
      id: aiBudgetId(),
      workspaceId,
      monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
      alertThreshold50: true,
      alertThreshold80: true,
      alertThreshold100: true,
      degradationEnabled: true,
      hardLimitEnabled: false, // Don't block by default
    })
  }
}
