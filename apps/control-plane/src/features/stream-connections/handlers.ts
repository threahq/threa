import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import { STREAM_CONNECTION_TOKEN_MAX_LENGTH, VISIBILITY_OPTIONS } from "@threahq/types"
import { parseRequest } from "../../lib/validation"
import type { StreamConnectionService } from "./service"

const idSchema = z.string().min(1).max(64)
const tokenSchema = z.string().min(1).max(STREAM_CONNECTION_TOKEN_MAX_LENGTH)

const createInviteSchema = z
  .object({
    hostWorkspaceId: idSchema,
    hostStreamId: idSchema,
    hostStreamSlug: z.string().max(200).nullable(),
    hostStreamDisplayName: z.string().max(200).nullable(),
    invitedByUserId: idSchema,
  })
  .strict()
const revokeSchema = z.object({ hostWorkspaceId: idSchema }).strict()
const acceptSchema = z
  .object({
    token: tokenSchema,
    partnerWorkspaceId: idSchema,
    acceptedByUserId: idSchema,
    visibility: z.enum(VISIBILITY_OPTIONS),
  })
  .strict()
const lookupSchema = z.object({ token: tokenSchema })

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
      const connectionId = parseRequest(idSchema, req.params.id)
      res.json({ snapshot: await streamConnectionService.revokeInvite({ connectionId, ...body }) })
    },

    async accept(req: Request, res: Response) {
      const body = parseRequest(acceptSchema, req.body)
      res.json({ snapshot: await streamConnectionService.accept(body) })
    },

    /** Session-authenticated: the invite page before the user picks a workspace. */
    async lookup(req: Request, res: Response) {
      if (!req.workosUserId) throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      const query = parseRequest(lookupSchema, req.query)
      res.setHeader("Cache-Control", "no-store")
      res.json(await streamConnectionService.lookup(query.token, req.workosUserId))
    },
  }
}
