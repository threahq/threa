import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import { CREATABLE_VISIBILITIES, streamConnectionIdSchema, streamConnectionTokenSchema } from "@threahq/types"
import { parseRequest } from "../../lib/validation"
import type { StreamConnectionService } from "./service"

const idSchema = z.string().min(1).max(64)

const createInviteSchema = z.object({
  hostWorkspaceId: idSchema,
  hostStreamId: idSchema,
  invitedBy: idSchema,
})
const revokeSchema = z.object({ hostWorkspaceId: idSchema })
const acceptSchema = z.object({
  token: streamConnectionTokenSchema,
  partnerWorkspaceId: idSchema,
  visibility: z.enum(CREATABLE_VISIBILITIES),
  acceptedBy: idSchema,
})
const lookupSchema = z.object({ token: streamConnectionTokenSchema })
const listSchema = z.object({
  workspaceId: idSchema,
  streamId: idSchema,
  includeIds: z.array(streamConnectionIdSchema),
})

interface Dependencies {
  streamConnectionService: StreamConnectionService
}

export function createStreamConnectionHandlers({ streamConnectionService }: Dependencies) {
  return {
    async createInvite(req: Request, res: Response) {
      const body = parseRequest(createInviteSchema, req.body)
      res.status(201).json(await streamConnectionService.createInvite(body))
    },

    async revokeInvite(req: Request, res: Response) {
      const body = parseRequest(revokeSchema, req.body)
      const connectionId = parseRequest(streamConnectionIdSchema, req.params.id)
      res.json({ snapshot: await streamConnectionService.revokeInvite({ connectionId, ...body }) })
    },

    async accept(req: Request, res: Response) {
      const body = parseRequest(acceptSchema, req.body)
      res.json({ snapshot: await streamConnectionService.accept(body) })
    },

    async list(req: Request, res: Response) {
      const body = parseRequest(listSchema, req.body)
      res.json({ snapshots: await streamConnectionService.listForWorkspace(body) })
    },

    /** Session-authenticated: the invite page before the user picks a workspace. */
    async lookup(req: Request, res: Response) {
      res.setHeader("Cache-Control", "no-store")
      if (!req.workosUserId) throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      const query = parseRequest(lookupSchema, req.query)
      res.json(await streamConnectionService.lookup(query.token, req.workosUserId))
    },
  }
}
