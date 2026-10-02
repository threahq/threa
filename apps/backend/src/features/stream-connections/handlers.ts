import type { Request, Response } from "express"
import { z } from "zod"
import { acceptStreamConnectionSchema, streamConnectionSnapshotSchema } from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import type { StreamConnectionService } from "./service"

const streamParamsSchema = z.object({ streamId: z.string().min(1) })
const connectionParamsSchema = z.object({ connectionId: z.string().min(1) })
const shareableQuerySchema = z.object({ workspaceId: z.string().min(1), streamId: z.string().min(1) })

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

    /** The invite page's workspace picker: answers with the same refusals accept would. */
    async canAccept(req: Request, res: Response) {
      await streamConnectionService.assertCanAccept(req.workspaceId!)
      res.status(204).send()
    },

    async accept(req: Request, res: Response) {
      const body = validateRequest(acceptStreamConnectionSchema, req.body)
      const connection = await streamConnectionService.accept({ workspaceId: req.workspaceId!, ...body })
      res.json({ connection })
    },

    async shareable(req: Request, res: Response) {
      const query = validateRequest(shareableQuerySchema, req.query)
      res.json({ shareable: await streamConnectionService.isStreamShareable(query) })
    },

    /** Control-plane fan-out: the full current state, so replays are idempotent. */
    async sync(req: Request, res: Response) {
      const snapshot = validateRequest(streamConnectionSnapshotSchema, req.body)
      await streamConnectionService.applySnapshot(snapshot)
      res.status(204).send()
    },
  }
}
