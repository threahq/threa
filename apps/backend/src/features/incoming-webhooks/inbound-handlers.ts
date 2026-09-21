import { z } from "zod"
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import { logger } from "../../lib/logger"
import { validateRequest } from "../../lib/validation"
import type { IncomingWebhookRow } from "./repository"
import { MAX_WEBHOOK_MARKDOWN_LENGTH, type IncomingWebhookService } from "./service"
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
const HOOK_PATH_IDS = /^ws_[0-9a-z]{10,40}\/hook_[0-9a-z]{10,40}$/i
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
  content: z.string().min(1, "content is required").max(MAX_WEBHOOK_MARKDOWN_LENGTH),
})

/**
 * Slack senders post JSON or a `payload=<json>` form, and the Content-Type is no guide to which:
 * `curl -d '{"text":"hi"}'` announces a form. The body arrives as raw text and is sniffed.
 */
function readSlackPayload(body: unknown): unknown {
  if (typeof body !== "string") throw new SlackReplyError(400, "invalid_payload")
  const raw = body.trimStart().startsWith("{") ? body : new URLSearchParams(body).get("payload")
  try {
    return JSON.parse(raw ?? "")
  } catch {
    throw new SlackReplyError(400, "invalid_payload")
  }
}

// body-parser rejects an oversized or undecodable entity with a plain Error carrying a `type`,
// which the shared error handler would otherwise report as a 500.
function isBodyParserRejection(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type
  return typeof type === "string" && type.startsWith("entity.")
}

interface InboundWebhookHandlers {
  requireNativePath: RequestHandler
  requireSlackPath: RequestHandler
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

  // Runs ahead of the audit layer, which records the path's workspace id on a denial: an
  // unauthenticated caller must not choose what lands in that column.
  function requireHookPath(onFailure: () => Error): RequestHandler {
    return (req, _res, next) =>
      next(HOOK_PATH_IDS.test(`${req.params.workspaceId}/${req.params.hookId}`) ? undefined : onFailure())
  }

  const notFound = () => new HttpError("Webhook not found", { status: 404, code: "NOT_FOUND" })
  const noService = () => new SlackReplyError(404, "no_service")

  return {
    requireNativePath: requireHookPath(notFound),
    requireSlackPath: requireHookPath(noService),
    authenticateNative: authenticate(notFound),
    authenticateSlack: authenticate(noService),

    /** POST /api/v1/workspaces/:workspaceId/hooks/:hookId/:secret */
    async native(req: Request, res: Response) {
      const hook = req.incomingWebhook!

      const { content } = validateRequest(nativeBodySchema, req.body)
      await incomingWebhookService.post(hook, content)
      res.status(201).json({ ok: true })
    },

    /** POST /api/v1/workspaces/:workspaceId/hooks/:hookId/:secret/slack */
    async slack(req: Request, res: Response) {
      const hook = req.incomingWebhook!

      const payload = slackPayloadToMarkdown(readSlackPayload(req.body))
      if ("error" in payload) throw new SlackReplyError(400, payload.error)
      if (payload.markdown.length > MAX_WEBHOOK_MARKDOWN_LENGTH) throw new SlackReplyError(400, "invalid_payload")

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
