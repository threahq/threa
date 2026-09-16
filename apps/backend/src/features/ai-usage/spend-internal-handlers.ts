import type { Request, Response } from "express"
import { z } from "zod"
import {
  AI_SPENDING_COVERAGE,
  aiSpendingInternalPolicyUpdateSchema,
  type AISpendingOverview,
  type AISpendingPeriod,
  type AISpendingPeriodWire,
  type AISpendingPolicy,
  type AISpendingPolicyUpdateResult,
  type AISpendingPolicyWire,
} from "@threahq/types"
import { InvalidUsdError } from "@threahq/agent-runtime"
import { HttpError } from "../../lib/errors"
import {
  InvalidSpendPolicyError,
  SpendCoverageNotAcknowledgedError,
  StaleSpendPolicyError,
  type AISpendingService,
} from "./spend-service"
import { SpendWorkspaceNotFoundError } from "./spend-repository"

const paramsSchema = z.object({ workspaceId: z.string().min(1) })

interface Dependencies {
  aiSpendingService: AISpendingService
}

function policyToWire(policy: AISpendingPolicy): AISpendingPolicyWire {
  return { ...policy, statusChangedAt: policy.statusChangedAt.toISOString() }
}

function periodToWire(period: AISpendingPeriod): AISpendingPeriodWire {
  return { ...period, startsAt: period.startsAt.toISOString(), endsAt: period.endsAt.toISOString() }
}

function workspaceNotFound(): HttpError {
  return new HttpError("Workspace not found", { status: 404, code: "WORKSPACE_NOT_FOUND" })
}

/** Known domain rejections keep their code; anything else is a server fault. */
function toHttpError(err: unknown): unknown {
  if (err instanceof SpendWorkspaceNotFoundError) return workspaceNotFound()
  if (err instanceof InvalidSpendPolicyError || err instanceof InvalidUsdError) {
    return new HttpError(err.message, { status: 400, code: err.code })
  }
  if (err instanceof StaleSpendPolicyError || err instanceof SpendCoverageNotAcknowledgedError) {
    return new HttpError(err.message, { status: 409, code: err.code })
  }
  return err
}

/** Control plane → region operator commands. This region's ledger is the only policy authority. */
export function createAISpendingInternalHandlers({ aiSpendingService }: Dependencies) {
  return {
    async getWorkspace(req: Request, res: Response) {
      const params = paramsSchema.safeParse(req.params)
      if (!params.success) throw new HttpError("Invalid workspace id", { status: 400, code: "VALIDATION_ERROR" })

      const overview = await aiSpendingService.getOverview(params.data.workspaceId)
      if (!overview) throw workspaceNotFound()
      res.json({
        workspaceId: params.data.workspaceId,
        policy: overview.policy && policyToWire(overview.policy),
        currentPeriod: overview.currentPeriod && periodToWire(overview.currentPeriod),
        coverage: AI_SPENDING_COVERAGE,
      } satisfies AISpendingOverview)
    },

    async setWorkspacePolicy(req: Request, res: Response) {
      const params = paramsSchema.safeParse(req.params)
      const body = aiSpendingInternalPolicyUpdateSchema.safeParse(req.body)
      if (!params.success || !body.success) {
        throw new HttpError("Invalid request", { status: 400, code: "VALIDATION_ERROR" })
      }

      let policy: AISpendingPolicy
      try {
        policy = await aiSpendingService.setPolicy({ ...body.data, workspaceId: params.data.workspaceId })
      } catch (err) {
        throw toHttpError(err)
      }
      res.json({ policy: policyToWire(policy) } satisfies AISpendingPolicyUpdateResult)
    },
  }
}
