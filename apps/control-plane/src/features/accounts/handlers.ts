import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import type { AccountsService } from "./service"

interface Dependencies {
  accountsService: AccountsService
}

const targetSchema = z.object({
  targetUserId: z.string().min(1),
})

const resolveQuerySchema = z
  .object({
    userId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .refine((d) => !!d.userId || !!d.workspaceId, { message: "userId or workspaceId required" })

export function createAccountsHandlers({ accountsService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      if (!req.workosUserId || !req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      res.json(await accountsService.list(res, req.cookies, req.authUser))
    },

    async resolve(req: Request, res: Response) {
      if (!req.workosUserId || !req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const parsed = resolveQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid query", { status: 400, code: "VALIDATION_ERROR" })
      }
      res.json(await accountsService.resolve(res, req.cookies, req.authUser, parsed.data))
    },

    async switch(req: Request, res: Response) {
      if (!req.workosUserId || !req.authUser || !req.sealedSession) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const parsed = targetSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      res.json(
        await accountsService.switch(res, req.cookies, req.sealedSession, req.authUser, parsed.data.targetUserId)
      )
    },

    async remove(req: Request, res: Response) {
      if (!req.workosUserId || !req.authUser || !req.sealedSession) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }
      const parsed = targetSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      res.json(
        await accountsService.remove(res, req.cookies, req.sealedSession, req.authUser, parsed.data.targetUserId)
      )
    },
  }
}
