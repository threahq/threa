import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { withClient, type Querier } from "../../db"
import { AIUsageRepository } from "./usage-repository"
import type { AIBudgetConfig, AIUserLimits } from "@threahq/types"
import { AIBudgetRepository, DEFAULT_AI_BUDGET_CONFIG, type AIBudget, type AIUserQuota } from "./budget-repository"
import { categorizeFunction, aggregateUsageByDay } from "./categories"
import { resolveBudgetMonthRange } from "./billing-window"
import { workspaceSpendLimitUsd } from "./spend-gate"
import { aiBudgetId, aiQuotaId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import { UserRepository } from "../workspaces"
import { validateRequest } from "../../lib/validation"
import { isValidIanaTimezone, monthRangeInTimezone } from "../../lib/temporal"

const updateBudgetSchema = z
  .object({
    monthlyBudgetUsd: z.number().min(0).optional(),
    alertThreshold50: z.boolean().optional(),
    alertThreshold80: z.boolean().optional(),
    alertThreshold100: z.boolean().optional(),
    aiDisabled: z.boolean().optional(),
    defaultUserAgentAllowanceUsd: z.number().min(0).nullable().optional(),
  })
  .strict()

const userLimitsParamsSchema = z.object({ userId: z.string().min(1) })

const setUserLimitsSchema = z
  .object({
    monthlyQuotaUsd: z.number().min(0).nullable(),
    agentAllowanceUsd: z.number().min(0).nullable(),
    aiDisabled: z.boolean(),
  })
  .strict()

interface Dependencies {
  pool: Pool
}

const syncOperatorControlsSchema = z
  .object({
    workspaceId: z.string().min(1),
    operatorCeilingUsd: z.number().min(0),
    operatorAiDisabled: z.boolean(),
  })
  .strict()

// The dashboard's day buckets and month window follow whatever zone the caller
// names — the viewer's device zone or the workspace's own (Stripe's model: money
// is stored as timestamps, day/month lines are drawn at presentation).
//
// This lens governs what is *read*, never what is enforced: `nextReset` and
// `AISpendGate` both resolve the workspace's `billingTimezone`
// regardless of `tz`, so switching the dashboard to your device zone cannot move
// the instant your budget rolls over.
const timezoneQuerySchema = z.object({
  tz: z
    .string()
    .refine(isValidIanaTimezone, { message: "must be a valid IANA timezone identifier" })
    .optional()
    .default("UTC"),
})

export function createAIUsageHandlers({ pool }: Dependencies) {
  return {
    async getUsage(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const { tz } = validateRequest(timezoneQuerySchema, req.query)
      const { start, end } = monthRangeInTimezone(tz)

      const [total, byOrigin, byUser, byFunctionRows, byModel, byDayRows] = await withClient(pool, async (client) =>
        Promise.all([
          AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end),
          AIUsageRepository.getUsageByOrigin(client, workspaceId, start, end),
          AIUsageRepository.getUsageByUser(client, workspaceId, start, end),
          AIUsageRepository.getUsageByFunction(client, workspaceId, start, end),
          AIUsageRepository.getUsageByModel(client, workspaceId, start, end),
          AIUsageRepository.getUsageByDay(client, workspaceId, start, end, tz),
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

      const { tz } = validateRequest(timezoneQuerySchema, req.query)
      const { start, end } = monthRangeInTimezone(tz)

      const [budget, usage, nextReset] = await withClient(pool, async (client) =>
        Promise.all([
          AIBudgetRepository.findByWorkspace(client, workspaceId),
          AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end),
          resolveNextReset(client, workspaceId),
        ])
      )

      res.json({
        budget: toBudgetConfig(budget),
        currentUsage: usage,
        percentUsed: percentUsed(usage.totalCostUsd, budget),
        nextReset,
      })
    },

    async updateBudget(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const updates = validateRequest(updateBudgetSchema, req.body)
      const { tz } = validateRequest(timezoneQuerySchema, req.query)
      const { start, end } = monthRangeInTimezone(tz)

      const [budget, usage, nextReset] = await withClient(pool, async (client) => {
        // Creates with defaults if absent; otherwise updates only provided fields.
        const updatedBudget = await AIBudgetRepository.upsertPartial(client, {
          id: aiBudgetId(),
          workspaceId,
          ...updates,
        })

        const currentUsage = await AIUsageRepository.getWorkspaceUsage(client, workspaceId, start, end)
        return [updatedBudget, currentUsage, await resolveNextReset(client, workspaceId)] as const
      })

      res.json({
        budget: toBudgetConfig(budget),
        currentUsage: usage,
        percentUsed: percentUsed(usage.totalCostUsd, budget),
        nextReset,
      })
    },

    /** Control-plane fan-out: full snapshot of the operator controls, so replays are idempotent. */
    async syncOperatorControls(req: Request, res: Response) {
      const controls = validateRequest(syncOperatorControlsSchema, req.body)
      await AIBudgetRepository.upsertOperatorControls(pool, { id: aiBudgetId(), ...controls })
      res.status(204).send()
    },

    async listUserLimits(req: Request, res: Response) {
      const quotas = await AIBudgetRepository.listUserQuotas(pool, req.workspaceId!)
      res.json({ limits: quotas.map(toUserLimits) })
    },

    async setUserLimits(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const { userId } = validateRequest(userLimitsParamsSchema, req.params)
      const limits = validateRequest(setUserLimitsSchema, req.body)

      const quota = await withClient(pool, async (client) => {
        const user = await UserRepository.findById(client, workspaceId, userId)
        if (!user) throw new HttpError("User not found", { status: 404, code: "USER_NOT_FOUND" })
        return AIBudgetRepository.upsertUserQuota(client, { id: aiQuotaId(), workspaceId, userId, ...limits })
      })

      res.json({ limits: toUserLimits(quota) })
    },

    async deleteUserLimits(req: Request, res: Response) {
      const { userId } = validateRequest(userLimitsParamsSchema, req.params)
      await AIBudgetRepository.deleteUserQuota(pool, req.workspaceId!, userId)
      res.status(204).send()
    },
  }
}

/** A workspace with no budget row is enforced against the defaults, so it reports them. */
function toBudgetConfig(budget: AIBudget | null): AIBudgetConfig {
  if (!budget) return DEFAULT_AI_BUDGET_CONFIG
  return {
    monthlyBudgetUsd: budget.monthlyBudgetUsd,
    alertThreshold50: budget.alertThreshold50,
    alertThreshold80: budget.alertThreshold80,
    alertThreshold100: budget.alertThreshold100,
    aiDisabled: budget.aiDisabled,
    defaultUserAgentAllowanceUsd: budget.defaultUserAgentAllowanceUsd,
    operatorCeilingUsd: budget.operatorCeilingUsd,
    operatorAiDisabled: budget.operatorAiDisabled,
  }
}

function percentUsed(totalCostUsd: number, budget: AIBudget | null): number {
  const limitUsd = workspaceSpendLimitUsd(toBudgetConfig(budget))
  return limitUsd > 0 ? Math.round((totalCostUsd / limitUsd) * 10000) / 100 : 100
}

function toUserLimits(quota: AIUserQuota): AIUserLimits {
  return {
    userId: quota.userId,
    monthlyQuotaUsd: quota.monthlyQuotaUsd,
    agentAllowanceUsd: quota.agentAllowanceUsd,
    aiDisabled: quota.aiDisabled,
  }
}

/**
 * When the budget actually resets — the workspace's own month boundary, not the
 * end of the caller's `?tz=` window. The lens changes which slice of history the
 * dashboard reads; it cannot move the instant enforcement rolls over, and saying
 * otherwise would promise a reset date that never happens.
 */
async function resolveNextReset(db: Querier, workspaceId: string): Promise<string> {
  const { end } = await resolveBudgetMonthRange(db, workspaceId)
  return end.toISOString()
}
