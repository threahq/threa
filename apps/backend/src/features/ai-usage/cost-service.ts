import type { Pool, PoolClient } from "pg"
import { withTransaction } from "../../db"
import { AIUsageRepository, type AIUsageOrigin } from "./usage-repository"
import { AIBudgetRepository, DEFAULT_AI_BUDGET_CONFIG } from "./budget-repository"
import { resolveBudgetMonthRange } from "./billing-window"
import { workspaceSpendLimitUsd } from "./spend-gate"
import { OutboxRepository } from "../../lib/outbox"
import { aiUsageId, aiAlertId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { UsageWithCost, ParsedModel } from "@threahq/agent-runtime"

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

export interface AICostServiceLike {
  recordUsage(params: RecordUsageParams): Promise<void>
}

export class AICostService implements AICostServiceLike {
  private pool: Pool

  constructor(config: AICostServiceConfig) {
    this.pool = config.pool
  }

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
      await AIUsageRepository.insert(client, {
        id: aiUsageId(),
        workspaceId: params.workspaceId,
        userId: params.userId,
        sessionId: params.sessionId,
        functionId: params.functionId,
        model: params.model,
        provider: params.provider,
        promptTokens: params.usage.promptTokens ?? 0,
        cachedPromptTokens: params.usage.cachedPromptTokens ?? 0,
        completionTokens: params.usage.completionTokens ?? 0,
        totalTokens: params.usage.totalTokens ?? 0,
        costUsd: cost,
        origin: params.origin,
        metadata: params.metadata,
      })

      // Same transaction as the usage insert so the alert event commits atomically with it.
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

  private async checkAndFireAlerts(client: PoolClient, workspaceId: string): Promise<void> {
    const { start: periodStart, end: periodEnd } = await resolveBudgetMonthRange(client, workspaceId)
    const position = await AIBudgetRepository.findSpendPosition(client, {
      workspaceId,
      periodStart,
      periodEnd,
      agentFunctionIds: [],
    })
    const alertSettings = (await AIBudgetRepository.findByWorkspace(client, workspaceId)) ?? DEFAULT_AI_BUDGET_CONFIG

    const currentUsageUsd = position.workspaceSpendUsd
    const budgetUsd = workspaceSpendLimitUsd(position)
    const percentUsed = budgetUsd > 0 ? (currentUsageUsd / budgetUsd) * 100 : 0

    for (const threshold of ALERT_THRESHOLDS) {
      if (!alertSettings[threshold.alertField]) {
        continue
      }

      if (percentUsed >= threshold.percent) {
        // One alert per threshold per period — skip if already recorded.
        const existingAlert = await AIBudgetRepository.findAlert(client, workspaceId, threshold.type, periodStart)

        if (existingAlert) {
          continue
        }

        await AIBudgetRepository.insertAlert(client, {
          id: aiAlertId(),
          workspaceId,
          alertType: threshold.type,
          thresholdPercent: threshold.percent,
          periodStart,
        })

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

  async recordUsageWithParsedModel(
    params: Omit<RecordUsageParams, "provider"> & { parsedModel: ParsedModel }
  ): Promise<void> {
    return this.recordUsage({
      ...params,
      model: params.parsedModel.modelId,
      provider: params.parsedModel.provider,
    })
  }
}

export function createNoOpCostService(): AICostServiceLike {
  return {
    async recordUsage() {
      // No-op
    },
  }
}
