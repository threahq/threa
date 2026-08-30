import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threa/backend-common"
import type { BotConnectService } from "./service"

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

// RFC 8628 §3.1: `client_id` is required by the spec; Threa has one public
// client (the CLI), so it is accepted and ignored. `name`/`host` are what the
// approval page shows.
const authorizeSchema = z.object({
  client_id: z.string().max(100).optional(),
  scope: z.string().max(500).optional(),
  name: z.string().trim().min(1).max(60).optional(),
  host: z.string().trim().min(1).max(100).optional(),
})
const tokenSchema = z.object({
  grant_type: z.literal(DEVICE_CODE_GRANT),
  device_code: z.string().min(20).max(200),
  client_id: z.string().max(100).optional(),
})
const codeSchema = z.string().trim().min(8).max(12)
const lookupSchema = z.object({ code: codeSchema })
const approveSchema = z.object({
  code: codeSchema,
  workspaceId: z.string().min(1).max(64),
  workspaceName: z.string().trim().min(1).max(200),
  botId: z.string().min(1).max(64),
  botSlug: z.string().min(1).max(100),
  scope: z.string().min(1).max(500),
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
    async authorize(req: Request, res: Response) {
      const parsed = authorizeSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" })
        return
      }
      res.json(
        await botConnectService.authorize({
          requestedName: parsed.data.name ?? null,
          requestedHost: parsed.data.host ?? null,
        })
      )
    },

    // RFC 8628 §3.5: errors are 400 with `{ error }`, so they are written here
    // rather than thrown through the `{ error, code }` HttpError formatter.
    async token(req: Request, res: Response) {
      const parsed = tokenSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        const grant = (req.body as { grant_type?: unknown } | undefined)?.grant_type
        res.status(400).json({ error: grant === DEVICE_CODE_GRANT ? "invalid_request" : "unsupported_grant_type" })
        return
      }
      const result = await botConnectService.token(parsed.data.device_code)
      res.setHeader("Cache-Control", "no-store")
      if ("error" in result) res.status(400).json(result)
      else res.json(result)
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
        scope: body.scope,
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
