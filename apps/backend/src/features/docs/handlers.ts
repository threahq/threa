import { z } from "zod"
import type { Request, Response } from "express"
import type {
  DocBacklinksResponse,
  DocListResponse,
  DocSectionResponse,
  DocThreadsResponse,
  DocUpdatesResponse,
} from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import type { DocService } from "./service"

interface Dependencies {
  docService: DocService
}

/** ~3 MB decoded, under the 10 MB JSON body limit with room for a pasted long document. */
const MAX_UPDATE_BASE64_LENGTH = 4_000_000
/** A Yjs state vector: two varints per client that ever wrote to the doc. */
const MAX_STATE_VECTOR_BASE64_LENGTH = 65_536

const paramsSchema = z.object({ docId: z.string().min(1) })

const sectionParamsSchema = paramsSchema.extend({ blockId: z.string().min(1) })

const listQuerySchema = z.object({}).strict()

const getQuerySchema = z.object({ sv: z.base64().max(MAX_STATE_VECTOR_BASE64_LENGTH).optional() })

const listUpdatesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(2_147_483_647),
})

const postUpdateSchema = z.object({
  update: z.base64().min(1).max(MAX_UPDATE_BASE64_LENGTH),
})

export function createDocHandlers({ docService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      validateRequest(listQuerySchema, req.query)
      const docs = await docService.list({ workspaceId: req.workspaceId!, userId: req.user!.id })
      res.json({ docs } satisfies DocListResponse)
    },

    async get(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const { sv } = validateRequest(getQuerySchema, req.query)
      const doc = await docService.get({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        docId,
        stateVector: sv,
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
      res.json({ updates } satisfies DocUpdatesResponse)
    },

    async listThreads(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const threads = await docService.listThreads({ workspaceId: req.workspaceId!, userId: req.user!.id, docId })
      res.json({ threads } satisfies DocThreadsResponse)
    },

    async listBacklinks(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const backlinks = await docService.listBacklinks({ workspaceId: req.workspaceId!, userId: req.user!.id, docId })
      res.json({ backlinks } satisfies DocBacklinksResponse)
    },

    async getSection(req: Request, res: Response) {
      const { docId, blockId } = validateRequest(sectionParamsSchema, req.params)
      const section = await docService.getSection({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        docId,
        blockId,
      })
      res.json({ section } satisfies DocSectionResponse)
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
