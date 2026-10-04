import type { Request, Response } from "express"
import { z } from "zod"
import {
  BRIDGE_WORKSPACE_HEADER,
  acceptStreamConnectionSchema,
  bridgeAddReactionSchema,
  bridgeDeleteMessageQuerySchema,
  bridgeEditMessageSchema,
  bridgeRemoveReactionQuerySchema,
  bridgeSendMessageSchema,
  streamConnectionIdSchema,
  streamConnectionSnapshotSchema,
} from "@threahq/types"
import { setAuditSubjects } from "../access-log"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { toShortcode } from "../emoji"
import { connectionNotFound } from "./errors"
import type { StreamConnectionExportService } from "./export"
import type { StreamConnectionImportService } from "./import"
import type { StreamConnectionService } from "./service"
import type { StreamConnectionWriteService } from "./write"

declare global {
  namespace Express {
    interface Request {
      /** Set on another region's bridge call once it names its workspace. */
      bridgeCaller?: { workspaceId: string; connectionId: string }
    }
  }
}

const streamParamsSchema = z.object({ streamId: z.string().min(1) })
const connectionParamsSchema = z.object({ connectionId: streamConnectionIdSchema })
const channelQuerySchema = z.object({
  workspaceId: z.string().min(1),
  streamId: z.string().min(1),
  invitedBy: z.string().min(1),
})

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
      const connection = await streamConnectionService.revokeInvite({
        workspaceId: req.workspaceId!,
        connectionId,
        userId: req.user!.id,
      })
      res.json({ connection })
    },

    /** The invite page's workspace picker: answers with the same refusals accept would. */
    async canAccept(req: Request, res: Response) {
      await streamConnectionService.assertCanAccept({ workspaceId: req.workspaceId!, userId: req.user!.id })
      res.status(204).send()
    },

    async accept(req: Request, res: Response) {
      const body = validateRequest(acceptStreamConnectionSchema, req.body)
      const connection = await streamConnectionService.accept({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        ...body,
      })
      res.json({ connection })
    },

    async channel(req: Request, res: Response) {
      const query = validateRequest(channelQuerySchema, req.query)
      res.json(await streamConnectionService.describeChannel(query))
    },

    /** Control-plane fan-out: the full current state, so replays are idempotent. */
    async sync(req: Request, res: Response) {
      const snapshot = validateRequest(streamConnectionSnapshotSchema, req.body)
      await streamConnectionService.applySnapshot(snapshot)
      res.status(204).send()
    },
  }
}

const bridgeParamsSchema = z.object({ workspaceId: z.string().min(1), connectionId: streamConnectionIdSchema })
const bridgeStreamParamsSchema = bridgeParamsSchema.extend({ streamId: z.string().min(1) })
const bridgeMessageParamsSchema = bridgeStreamParamsSchema.extend({ messageId: z.string().min(1) })
const bridgeReactionParamsSchema = bridgeMessageParamsSchema.extend({ emoji: z.string().min(1) })
const bridgeAttachmentParamsSchema = bridgeParamsSchema.extend({ attachmentId: z.string().min(1) })
const bridgeEventsQuerySchema = z.object({
  after: z
    .string()
    .regex(/^\d{1,19}$/)
    .default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

interface BridgeDependencies {
  streamConnectionExportService: StreamConnectionExportService
  streamConnectionImportService: StreamConnectionImportService
  streamConnectionWriteService: StreamConnectionWriteService
}

/** Another region's calls about a shared channel: the partner's reads and writes on a channel this workspace hosts, and the host's pokes. */
export function createStreamConnectionBridgeHandlers({
  streamConnectionExportService,
  streamConnectionImportService,
  streamConnectionWriteService,
}: BridgeDependencies) {
  return {
    async manifest(req: Request, res: Response) {
      const params = validateRequest(bridgeParamsSchema, req.params)
      const manifest = await streamConnectionExportService.getManifest({
        ...params,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(
        res,
        manifest.streams.map((stream) => ({ type: "stream", id: stream.id }))
      )
      res.setHeader("Cache-Control", "no-store")
      res.json(manifest)
    },

    async events(req: Request, res: Response) {
      const params = validateRequest(bridgeStreamParamsSchema, req.params)
      const { after, limit } = validateRequest(bridgeEventsQuerySchema, req.query)
      const events = await streamConnectionExportService.listEvents({
        ...params,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
        after: BigInt(after),
        limit,
      })
      setAuditSubjects(res, [
        { type: "stream", id: params.streamId, fromSeq: Number(after), toSeq: Number(events.cursor) },
        ...events.changes.map((change) => ({
          type: "message",
          id: change.kind === "message" ? change.message.id : change.messageId,
        })),
      ])
      res.setHeader("Cache-Control", "no-store")
      res.json(events)
    },

    async attachment(req: Request, res: Response) {
      const params = validateRequest(bridgeAttachmentParamsSchema, req.params)
      const answer = await streamConnectionExportService.getAttachment({
        ...params,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(res, [{ type: "attachment", id: params.attachmentId }])
      res.setHeader("Cache-Control", "no-store")
      res.json(answer)
    },

    async sendMessage(req: Request, res: Response) {
      const params = validateRequest(bridgeStreamParamsSchema, req.params)
      const body = validateRequest(bridgeSendMessageSchema, req.body)
      const { messageId } = await streamConnectionWriteService.sendMessage({
        ...params,
        ...body,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(res, [
        { type: "stream", id: params.streamId },
        { type: "message", id: messageId },
      ])
      res.status(201).json({ messageId })
    },

    async editMessage(req: Request, res: Response) {
      const params = validateRequest(bridgeMessageParamsSchema, req.params)
      const body = validateRequest(bridgeEditMessageSchema, req.body)
      await streamConnectionWriteService.editMessage({
        ...params,
        ...body,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(res, [{ type: "message", id: params.messageId }])
      res.status(204).end()
    },

    async deleteMessage(req: Request, res: Response) {
      const params = validateRequest(bridgeMessageParamsSchema, req.params)
      const { authorId } = validateRequest(bridgeDeleteMessageQuerySchema, req.query)
      await streamConnectionWriteService.deleteMessage({
        ...params,
        authorId,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(res, [{ type: "message", id: params.messageId }])
      res.status(204).end()
    },

    async addReaction(req: Request, res: Response) {
      const { emoji: rawEmoji, ...params } = validateRequest(bridgeReactionParamsSchema, req.params)
      const body = validateRequest(bridgeAddReactionSchema, req.body)
      await streamConnectionWriteService.addReaction({
        ...params,
        ...body,
        emoji: requireShortcode(rawEmoji),
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(res, [{ type: "message", id: params.messageId }])
      res.status(204).end()
    },

    async removeReaction(req: Request, res: Response) {
      const { emoji: rawEmoji, ...params } = validateRequest(bridgeReactionParamsSchema, req.params)
      const { authorId } = validateRequest(bridgeRemoveReactionQuerySchema, req.query)
      await streamConnectionWriteService.removeReaction({
        ...params,
        authorId,
        emoji: requireShortcode(rawEmoji),
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      setAuditSubjects(res, [{ type: "message", id: params.messageId }])
      res.status(204).end()
    },

    async poke(req: Request, res: Response) {
      const params = validateRequest(bridgeParamsSchema, req.params)
      await streamConnectionImportService.requestPull({
        ...params,
        callerWorkspaceId: identifyCaller(req, params.connectionId),
      })
      // Every shared-channel change sends one and it carries no data, so only a refusal earns a row.
      res.locals.auditSkip = true
      res.status(204).end()
    },
  }
}

function requireShortcode(emoji: string): string {
  const shortcode = toShortcode(emoji)
  if (!shortcode) throw new HttpError("Invalid emoji", { status: 400, code: "INVALID_EMOJI" })
  return shortcode
}

/** The workspace the request names itself as, recorded as the access log's actor. */
function identifyCaller(req: Request, connectionId: string): string {
  const workspaceId = req.get(BRIDGE_WORKSPACE_HEADER)
  if (!workspaceId) throw connectionNotFound()
  req.bridgeCaller = { workspaceId, connectionId }
  return workspaceId
}
