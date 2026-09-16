import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import type { AISpendControlsService } from "./service"

const setControlsSchema = z
  .object({
    // Largest value NUMERIC(10, 2) holds.
    operatorCeilingUsd: z.number().min(0).max(99_999_999.99),
    operatorAiDisabled: z.boolean(),
  })
  .strict()

interface Dependencies {
  aiSpendControlsService: AISpendControlsService
}

export function createAISpendControlsHandlers({ aiSpendControlsService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      res.json({ controls: await aiSpendControlsService.get(id) })
    },

    async set(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const parsed = setControlsSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      res.json({ controls: await aiSpendControlsService.set(id, parsed.data) })
    },
  }
}
