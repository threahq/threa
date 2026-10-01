import type { Request, Response } from "express"
import { z } from "zod"
import { VISIBILITY_OPTIONS, streamConnectionSnapshotSchema } from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import type { StreamConnectionService } from "./service"

const streamParamsSchema = z.object({ streamId: z.string().min(1) })
const connectionParamsSchema = z.object({ connectionId: z.string().min(1) })
const acceptSchema = z
  .object({
    token: z.string().min(1).max(200),
    visibility: z.enum(VISIBILITY_OPTIONS),
  })
  .strict()

interface Dependencies {
  streamConnectionService: StreamConnectionService
}

export function createStreamConnectionHandlers({ streamConnectionService }: Dependencies) {
  return {
    async createInvite(req: Request, res: Response) {
      const { streamId } = validateRequest(streamParamsSchema, req.params)
      const result = await streamConnectionService.createInvite({
        workspaceId: req.workspaceId!,
        streamId,
        userId: req.user!.id,
      })
      res.setHeader("Cache-Control", "no-store")
      res.status(201).json(result)
    },

    async listForStream(req: Request, res: Response) {
      const { streamId } = validateRequest(streamParamsSchema, req.params)
      const connections = await streamConnectionService.listForStream({
        workspaceId: req.workspaceId!,
        streamId,
        userId: req.user!.id,
      })
      res.json({ connections })
    },

    async revokeInvite(req: Request, res: Response) {
      const { connectionId } = validateRequest(connectionParamsSchema, req.params)
      const connection = await streamConnectionService.revokeInvite({ workspaceId: req.workspaceId!, connectionId })
      res.json({ connection })
    },

    async accept(req: Request, res: Response) {
      const body = validateRequest(acceptSchema, req.body)
      const connection = await streamConnectionService.accept({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        ...body,
      })
      res.json({ connection })
    },

    /** Control-plane fan-out: the full current state, so replays are idempotent. */
    async sync(req: Request, res: Response) {
      const snapshot = validateRequest(streamConnectionSnapshotSchema, req.body)
      await streamConnectionService.applySnapshot(snapshot)
      res.status(204).send()
    },
  }
}
