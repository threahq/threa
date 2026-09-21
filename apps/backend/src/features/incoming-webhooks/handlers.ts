import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import { BotTypes, type CreateIncomingWebhookResponse, type IncomingWebhook } from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import { resolveWorkspaceUserActorId } from "../public-api"
import type { IncomingWebhookRow } from "./repository"
import type { IncomingWebhookService } from "./service"

const createWebhookSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  streamId: z.string().min(1, "streamId is required"),
})

const updateWebhookSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(100).optional(),
    streamId: z.string().min(1).optional(),
  })
  .refine((data) => data.name !== undefined || data.streamId !== undefined, {
    message: "name or streamId is required",
  })

const hookParamsSchema = z.object({
  hookId: z.string().min(1),
})

function serializeWebhook(row: IncomingWebhookRow): IncomingWebhook {
  return {
    id: row.id,
    botId: row.botId,
    streamId: row.streamId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

export function createIncomingWebhookHandlers({
  incomingWebhookService,
}: {
  incomingWebhookService: IncomingWebhookService
}) {
  return {
    /** GET /api/workspaces/:workspaceId/bots/:botId/webhooks */
    async list(req: Request, res: Response) {
      const rows = await incomingWebhookService.listByBot(req.workspaceId!, req.params.botId)
      res.json({ data: rows.map(serializeWebhook) })
    },

    /** POST /api/workspaces/:workspaceId/bots/:botId/webhooks */
    async create(req: Request, res: Response) {
      if (req.bot!.archivedAt) {
        throw new HttpError("Bot is archived", { status: 409, code: "BOT_ARCHIVED" })
      }

      const createdBy = resolveWorkspaceUserActorId(req)
      if (!createdBy) {
        throw new HttpError("Not authenticated", { status: 401, code: "UNAUTHENTICATED" })
      }

      const data = validateRequest(createWebhookSchema, req.body)
      const { row, secret } = await incomingWebhookService.create({
        workspaceId: req.workspaceId!,
        botId: req.params.botId,
        streamId: data.streamId,
        name: data.name,
        createdBy,
        ...(req.bot!.type === BotTypes.PERSONAL && { personalOwnerId: createdBy }),
      })

      const payload: CreateIncomingWebhookResponse = { webhook: serializeWebhook(row), secret }
      res.status(201).json(payload)
    },

    /** PATCH /api/workspaces/:workspaceId/bots/:botId/webhooks/:hookId */
    async update(req: Request, res: Response) {
      const actorId = resolveWorkspaceUserActorId(req)
      if (!actorId) {
        throw new HttpError("Not authenticated", { status: 401, code: "UNAUTHENTICATED" })
      }

      const { hookId } = validateRequest(hookParamsSchema, req.params)
      const data = validateRequest(updateWebhookSchema, req.body)
      const row = await incomingWebhookService.update({
        workspaceId: req.workspaceId!,
        botId: req.params.botId,
        id: hookId,
        actorId,
        ...(req.bot!.type === BotTypes.PERSONAL && { personalOwnerId: actorId }),
        ...(data.name !== undefined && { name: data.name }),
        ...(data.streamId !== undefined && { streamId: data.streamId }),
      })

      res.json({ webhook: serializeWebhook(row) })
    },

    /** POST /api/workspaces/:workspaceId/bots/:botId/webhooks/:hookId/revoke */
    async revoke(req: Request, res: Response) {
      const { hookId } = validateRequest(hookParamsSchema, req.params)
      await incomingWebhookService.revoke(req.workspaceId!, req.params.botId, hookId)
      res.status(204).send()
    },
  }
}
