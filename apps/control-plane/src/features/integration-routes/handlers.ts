import type { Request, Response } from "express"
import type { Pool } from "pg"
import { z } from "zod/v4"
import { HttpError, integrationRouteId } from "@threahq/backend-common"
import { IntegrationRouteRepository } from "./repository"

interface Dependencies {
  pool: Pool
}

const registerSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
  region: z.string().min(1),
  workspaceId: z.string().min(1),
})

const unregisterSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
  workspaceId: z.string().min(1),
})

export function createIntegrationRouteHandlers({ pool }: Dependencies) {
  return {
    async register(req: Request, res: Response) {
      const parsed = registerSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const route = await IntegrationRouteRepository.upsert(pool, {
        id: integrationRouteId(),
        provider: parsed.data.provider,
        externalId: parsed.data.externalId,
        region: parsed.data.region,
        workspaceId: parsed.data.workspaceId,
      })

      res.status(200).json({ route })
    },

    async unregister(req: Request, res: Response) {
      const parsed = unregisterSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const deleted = await IntegrationRouteRepository.delete(pool, {
        provider: parsed.data.provider,
        externalId: parsed.data.externalId,
        workspaceId: parsed.data.workspaceId,
      })

      res.status(200).json({ deleted })
    },
  }
}
