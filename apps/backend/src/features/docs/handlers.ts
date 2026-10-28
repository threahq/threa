import { z } from "zod"
import type { Request, Response } from "express"
import type {
  DocMovePreviewResponse,
  DocBacklinksResponse,
  DocListResponse,
  DocSectionResponse,
  DocThreadsResponse,
  DocUpdatesResponse,
} from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import { callerIsWorkspaceAdmin } from "../../middleware/workspace-admin"
import type { StreamService } from "../streams"
import type { DocService } from "./service"

interface Dependencies {
  docService: DocService
  streamService: Pick<StreamService, "moveDoc" | "previewDocMove">
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

const movePreviewQuerySchema = z.object({ toStreamId: z.string().min(1) })

const moveSchema = z.object({ fromStreamId: z.string().min(1), toStreamId: z.string().min(1) })

export function createDocHandlers({ docService, streamService }: Dependencies) {
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
      const page = await docService.listUpdates({ workspaceId: req.workspaceId!, userId: req.user!.id, docId, after })
      res.json(page satisfies DocUpdatesResponse)
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

    async previewMove(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const { toStreamId } = validateRequest(movePreviewQuerySchema, req.query)
      const preview = await streamService.previewDocMove({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        docId,
        toStreamId,
      })
      res.json(preview satisfies DocMovePreviewResponse)
    },

    async move(req: Request, res: Response) {
      const { docId } = validateRequest(paramsSchema, req.params)
      const { fromStreamId, toStreamId } = validateRequest(moveSchema, req.body)
      const stream = await streamService.moveDoc({
        workspaceId: req.workspaceId!,
        docId,
        fromStreamId,
        toStreamId,
        principal: { kind: "user", userId: req.user!.id },
        isWorkspaceAdmin: callerIsWorkspaceAdmin(req),
      })
      res.json({ stream })
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
