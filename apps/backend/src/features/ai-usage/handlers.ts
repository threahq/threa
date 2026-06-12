import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { withClient } from "../../db"
import { AIUsageRepository } from "./usage-repository"
import { AIBudgetRepository } from "./budget-repository"
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

/**
 * Get the current month's date range.
 */
function getCurrentMonthRange(): { start: Date; end: Date } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)
  return { start, end }
}

/**
 * Get the next budget reset date (first of next month).
 */
function getNextResetDate(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)
}

export function createAIUsageHandlers({ pool }: Dependencies) {
  return {
    /**
     * Get AI usage summary for the workspace.
     *
     * GET /api/workspaces/:workspaceId/ai-usage
     *
     * Response includes:
     * - total: overall usage summary
     * - byOrigin: breakdown by origin (system vs user)
     * - byUser: breakdown by user (for user-origin calls)
     */
    async getUsage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { start, end } = getCurrentMonthRange()

      const [total, byOrigin, byUser] = await withClient(pool, async (client) =>
        Promise.all([
          AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end),
          AIUsageRepository.getUsageByOrigin(client, workspaceId, start, end),
          AIUsageRepository.getUsageByUser(client, workspaceId, start, end),
        ])
      )

      res.json({
        period: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
        total,
        byOrigin,
        byUser,
      })
    },

    /**
     * Get recent AI usage records.
     *
     * GET /api/workspaces/:workspaceId/ai-usage/recent
     *
     * Query params:
     * - limit: max records to return (1-100, default 50)
     */
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

    /**
     * Get workspace AI budget configuration and current status.
     *
     * GET /api/workspaces/:workspaceId/ai-budget
     */
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

    /**
     * Update workspace AI budget configuration.
     *
     * PUT /api/workspaces/:workspaceId/ai-budget
     *
     * Body:
     * - monthlyBudgetUsd: number (optional)
     * - alertThreshold50: boolean (optional)
     * - alertThreshold80: boolean (optional)
     * - alertThreshold100: boolean (optional)
     * - degradationEnabled: boolean (optional)
     * - hardLimitEnabled: boolean (optional)
     * - hardLimitPercent: number (optional, 100-500)
     */
    async updateBudget(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const updates = validateRequest(updateBudgetSchema, req.body)
      const { start, end } = getCurrentMonthRange()

      const [budget, usage] = await withClient(pool, async (client) => {
        // Atomic upsert with partial update semantics:
        // - Creates with defaults if budget doesn't exist
        // - Only updates provided fields if budget exists
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
