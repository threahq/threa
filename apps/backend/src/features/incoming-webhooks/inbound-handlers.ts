import { z } from "zod"
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import { logger } from "../../lib/logger"
import { validateRequest } from "../../lib/validation"
import type { IncomingWebhookRow } from "./repository"
import type { IncomingWebhookService } from "./service"
import { slackPayloadToMarkdown } from "./slack-translator"

declare global {
  namespace Express {
    interface Request {
      /** Set once an inbound webhook request has proven its secret. */
      incomingWebhook?: IncomingWebhookRow
    }
  }
}

/** Case-insensitive because Express routing is: `/SLACK` reaches the Slack handler. */
const INBOUND_WEBHOOK_URL = /^\/api\/v1\/workspaces\/[^/?#]+\/hooks\/[^/?#]+\/[^/?#]+(\/slack)?\/?(?:[?#]|$)/i

export function isInboundWebhookUrl(url: string): boolean {
  return INBOUND_WEBHOOK_URL.test(url)
}

export function isSlackWebhookUrl(url: string): boolean {
  return INBOUND_WEBHOOK_URL.exec(url)?.[1] !== undefined
}

/** Slack shows the response body verbatim in its delivery log, so failures reply in plain text. */
class SlackReplyError extends Error {
  constructor(
    readonly status: number,
    readonly reply: string
  ) {
    super(reply)
    this.name = "SlackReplyError"
  }
}

const nativeBodySchema = z.object({
  content: z.string().min(1, "content is required"),
})

/** Slack senders post a JSON object, a `payload=<json>` form, or JSON the text parser hands over as a string. */
function readSlackPayload(body: unknown): unknown {
  if (typeof body === "string") {
    if (body.trim() === "") throw new SlackReplyError(400, "invalid_payload")
    try {
      return JSON.parse(body)
    } catch {
      throw new SlackReplyError(400, "invalid_payload")
    }
  }
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const form = (body as { payload?: unknown }).payload
    if (typeof form === "string") {
      try {
        return JSON.parse(form)
      } catch {
        throw new SlackReplyError(400, "invalid_payload")
      }
    }
    return body
  }
  throw new SlackReplyError(400, "invalid_payload")
}

// body-parser rejects an oversized or undecodable entity with a plain Error carrying a `type`,
// which the shared error handler would otherwise report as a 500.
function isBodyParserRejection(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type
  return typeof type === "string" && type.startsWith("entity.")
}

export interface InboundWebhookHandlers {
  authenticateNative: RequestHandler
  authenticateSlack: RequestHandler
  native: (req: Request, res: Response) => Promise<void>
  slack: (req: Request, res: Response) => Promise<void>
  nativeErrors: ErrorRequestHandler
  slackErrors: ErrorRequestHandler
}

export function createInboundWebhookHandlers({
  incomingWebhookService,
}: {
  incomingWebhookService: IncomingWebhookService
}): InboundWebhookHandlers {
  // Mounted ahead of the per-hook rate limiter so only a caller that proved the secret
  // consumes a hook's bucket.
  function authenticate(onFailure: () => Error): RequestHandler {
    return (req, _res, next) => {
      incomingWebhookService
        .authenticate(req.params.workspaceId, req.params.hookId, req.params.secret)
        .then((auth) => {
          if (!auth) return next(onFailure())
          req.incomingWebhook = auth.hook
          next()
        })
        .catch(next)
    }
  }

  function authenticated(req: Request): IncomingWebhookRow {
    const hook = req.incomingWebhook
    if (!hook) throw new HttpError("Webhook not found", { status: 404, code: "NOT_FOUND" })
    return hook
  }

  return {
    authenticateNative: authenticate(() => new HttpError("Webhook not found", { status: 404, code: "NOT_FOUND" })),
    authenticateSlack: authenticate(() => new SlackReplyError(404, "no_service")),

    /** POST /api/v1/workspaces/:workspaceId/hooks/:hookId/:secret */
    async native(req: Request, res: Response) {
      const hook = authenticated(req)

      const { content } = validateRequest(nativeBodySchema, req.body)
      await incomingWebhookService.post(hook, content)
      res.status(201).json({ ok: true })
    },

    /** POST /api/v1/workspaces/:workspaceId/hooks/:hookId/:secret/slack */
    async slack(req: Request, res: Response) {
      const hook = authenticated(req)

      const payload = slackPayloadToMarkdown(readSlackPayload(req.body))
      if ("error" in payload) throw new SlackReplyError(400, payload.error)

      await incomingWebhookService.post(hook, payload.markdown)
      res.status(200).type("text/plain").send("ok")
    },

    nativeErrors: ((err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
      next(
        isBodyParserRejection(err)
          ? new HttpError("Request body is not valid JSON or is too large", { status: 400, code: "INVALID_PAYLOAD" })
          : err
      )
    }) satisfies ErrorRequestHandler,

    // `no_service` covers every downstream refusal (archived or sealed stream, revoked grant):
    // the reason belongs to the workspace, not to an unauthenticated caller.
    slackErrors: ((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
      if (res.headersSent) return next(err)

      if (err instanceof SlackReplyError) {
        res.status(err.status).type("text/plain").send(err.reply)
        return
      }
      if (err instanceof HttpError && err.status < 500) {
        res.status(404).type("text/plain").send("no_service")
        return
      }
      if (isBodyParserRejection(err)) {
        res.status(400).type("text/plain").send("invalid_payload")
        return
      }

      logger.error({ err }, "Incoming webhook slack delivery failed")
      res.status(500).type("text/plain").send("server_error")
    }) satisfies ErrorRequestHandler,
  }
}
