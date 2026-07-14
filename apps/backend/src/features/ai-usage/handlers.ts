import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { withClient } from "../../db"
import { AIUsageRepository } from "./usage-repository"
import { AIBudgetRepository } from "./budget-repository"
import { categorizeFunction, aggregateUsageByDay } from "./categories"
import { aiBudgetId } from "../../lib/id"
import { validateRequest } from "../../lib/validation"

const updateBudgetSchema = z.object({
  monthlyBudgetUsd: z.number().min(0).optional(),
  alertThreshold50: z.boolean().optional(),
  alertThreshold80: z.boolean().optional(),
  alertThreshold100: z.boolean().optional(),
  degradationEnabled: z.boolean().optional(),
  hardLimitEnabled: z.boolean().optional(),
  hardLimitPercent: z.number().min(100).max(500).optional(),
})

interface Dependencies {
  pool: Pool
}

function getCurrentMonthRange(): { start: Date; end: Date } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)
  return { start, end }
}

/** First of next month. */
function getNextResetDate(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)
}

export function createAIUsageHandlers({ pool }: Dependencies) {
  return {
    async getUsage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { start, end } = getCurrentMonthRange()

      const [total, byOrigin, byUser, byFunctionRows, byModel, byDayRows] = await withClient(pool, async (client) =>
        Promise.all([
          AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end),
          AIUsageRepository.getUsageByOrigin(client, workspaceId, start, end),
          AIUsageRepository.getUsageByUser(client, workspaceId, start, end),
          AIUsageRepository.getUsageByFunction(client, workspaceId, start, end),
          AIUsageRepository.getUsageByModel(client, workspaceId, start, end),
          AIUsageRepository.getUsageByDay(client, workspaceId, start, end),
        ])
      )

      const byFunction = byFunctionRows.map((row) => ({ ...row, category: categorizeFunction(row.functionId) }))
      const byDay = aggregateUsageByDay(byDayRows)

      res.json({
        period: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
        total,
        byOrigin,
        byUser,
        byFunction,
        byModel,
        byDay,
      })
    },

    async getRecentUsage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 100)

      const records = await AIUsageRepository.listRecent(pool, workspaceId, { limit })

      res.json({
        records: records.map((r) => ({
          id: r.id,
          functionId: r.functionId,
          model: r.model,
          provider: r.provider,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.totalTokens,
          costUsd: r.costUsd,
          userId: r.userId,
          sessionId: r.sessionId,
          createdAt: r.createdAt.toISOString(),
        })),
      })
    },

    async getBudget(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { start, end } = getCurrentMonthRange()

      const [budget, usage] = await withClient(pool, async (client) =>
        Promise.all([
          AIBudgetRepository.findByWorkspace(client, workspaceId),
          AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end),
        ])
      )

      if (!budget) {
        return res.json({
          budget: null,
          currentUsage: usage,
          percentUsed: 0,
          nextReset: getNextResetDate().toISOString(),
        })
      }

      const percentUsed = budget.monthlyBudgetUsd > 0 ? (usage.totalCostUsd / budget.monthlyBudgetUsd) * 100 : 0

      res.json({
        budget: {
          monthlyBudgetUsd: budget.monthlyBudgetUsd,
          alertThreshold50: budget.alertThreshold50,
          alertThreshold80: budget.alertThreshold80,
          alertThreshold100: budget.alertThreshold100,
          degradationEnabled: budget.degradationEnabled,
          hardLimitEnabled: budget.hardLimitEnabled,
          hardLimitPercent: budget.hardLimitPercent,
        },
        currentUsage: usage,
        percentUsed: Math.round(percentUsed * 100) / 100,
        nextReset: getNextResetDate().toISOString(),
      })
    },

    async updateBudget(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const updates = validateRequest(updateBudgetSchema, req.body)
      const { start, end } = getCurrentMonthRange()

      const [budget, usage] = await withClient(pool, async (client) => {
        // Creates with defaults if absent; otherwise updates only provided fields.
        const updatedBudget = await AIBudgetRepository.upsertPartial(client, {
          id: aiBudgetId(),
          workspaceId,
          ...updates,
        })

        const currentUsage = await AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end)
        return [updatedBudget, currentUsage]
      })

      if (!budget) {
        return res.status(500).json({ error: "Failed to update budget" })
      }

      const percentUsed = budget.monthlyBudgetUsd > 0 ? (usage.totalCostUsd / budget.monthlyBudgetUsd) * 100 : 0

      res.json({
        budget: {
          monthlyBudgetUsd: budget.monthlyBudgetUsd,
          alertThreshold50: budget.alertThreshold50,
          alertThreshold80: budget.alertThreshold80,
          alertThreshold100: budget.alertThreshold100,
          degradationEnabled: budget.degradationEnabled,
          hardLimitEnabled: budget.hardLimitEnabled,
          hardLimitPercent: budget.hardLimitPercent,
        },
        currentUsage: usage,
        percentUsed: Math.round(percentUsed * 100) / 100,
        nextReset: getNextResetDate().toISOString(),
      })
    },
  }
}
