import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import { aiSpendingPolicyUpdateSchema, type AISpendingPolicyUpdateResult } from "@threahq/types"
import type { ControlPlaneAISpendingService } from "./service"

const paramsSchema = z.object({ id: z.string().min(1) })

interface Dependencies {
  aiSpendingService: ControlPlaneAISpendingService
}

export function createAISpendingHandlers({ aiSpendingService }: Dependencies) {
  return {
    async getWorkspaceSpending(req: Request, res: Response) {
      const params = paramsSchema.safeParse(req.params)
      if (!params.success) throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      res.json(await aiSpendingService.getWorkspaceSpending(params.data.id))
    },

    async setWorkspacePolicy(req: Request, res: Response) {
      const operatorWorkosUserId = req.workosUserId
      if (!operatorWorkosUserId) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const params = paramsSchema.safeParse(req.params)
      const body = aiSpendingPolicyUpdateSchema.safeParse(req.body)
      if (!params.success || !body.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const policy = await aiSpendingService.setWorkspacePolicy({
        workspaceId: params.data.id,
        operatorWorkosUserId,
        update: body.data,
      })
      res.json({ policy } satisfies AISpendingPolicyUpdateResult)
    },
  }
}
