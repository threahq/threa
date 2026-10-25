import { z } from "zod"
import type { Request, Response } from "express"
import { validateRequest } from "../../lib/validation"
import type { DocService } from "./service"

interface Dependencies {
  docService: DocService
}

/** ~3 MB decoded, under the 10 MB JSON body limit with room for a pasted long document. */
const MAX_UPDATE_BASE64_LENGTH = 4_000_000

const paramsSchema = z.object({ docId: z.string().min(1) })

const listUpdatesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(2_147_483_647),
})

const postUpdateSchema = z.object({
  update: z.base64().min(1).max(MAX_UPDATE_BASE64_LENGTH),
})

export function createDocHandlers({ docService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const doc = await docService.get({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        docId,
      })
      res.json(doc)
    },

    async listUpdates(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const { after } = validateRequest(listUpdatesQuerySchema, req.query)
      const updates = await docService.listUpdates({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        docId,
        after,
      })
      res.json({ updates })
    },

    async postUpdate(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const { update } = validateRequest(postUpdateSchema, req.body)
      const result = await docService.postUpdate({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        docId,
        update,
      })
      res.json(result)
    },
  }
}
