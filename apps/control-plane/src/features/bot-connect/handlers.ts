import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import type { BotConnectService } from "./service"

const startSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  host: z.string().trim().min(1).max(100).optional(),
})
const pollSchema = z.object({ deviceCode: z.string().min(20).max(200) })
const codeSchema = z.string().trim().min(8).max(12)
const lookupSchema = z.object({ code: codeSchema })
const approveSchema = z.object({
  code: codeSchema,
  workspaceId: z.string().min(1).max(64),
  workspaceName: z.string().trim().min(1).max(200),
  botId: z.string().min(1).max(64),
  botSlug: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(500),
})
const denySchema = z.object({ code: codeSchema })

interface Dependencies {
  botConnectService: BotConnectService
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HttpError("Invalid request", { status: 400, code: "VALIDATION_ERROR" })
  return parsed.data
}

function requireUser(req: Request): string {
  if (!req.workosUserId) throw new HttpError("Unauthorized", { status: 401, code: "UNAUTHORIZED" })
  return req.workosUserId
}

export function createBotConnectHandlers({ botConnectService }: Dependencies) {
  return {
    async start(req: Request, res: Response) {
      const body = parse(startSchema, req.body ?? {})
      const started = await botConnectService.start({
        requestedName: body.name ?? null,
        requestedHost: body.host ?? null,
      })
      res.status(201).json(started)
    },

    async poll(req: Request, res: Response) {
      const query = parse(pollSchema, req.query)
      res.json(await botConnectService.poll(query.deviceCode))
    },

    async lookup(req: Request, res: Response) {
      requireUser(req)
      const query = parse(lookupSchema, req.query)
      res.json(await botConnectService.lookup(query.code))
    },

    async approve(req: Request, res: Response) {
      const workosUserId = requireUser(req)
      const body = parse(approveSchema, req.body)
      await botConnectService.approve({
        rawCode: body.code,
        workosUserId,
        workspaceId: body.workspaceId,
        workspaceName: body.workspaceName,
        botId: body.botId,
        botSlug: body.botSlug,
        apiKey: body.apiKey,
      })
      res.json({ ok: true })
    },

    async deny(req: Request, res: Response) {
      const workosUserId = requireUser(req)
      const body = parse(denySchema, req.body)
      await botConnectService.deny({ rawCode: body.code, workosUserId })
      res.json({ ok: true })
    },
  }
}
