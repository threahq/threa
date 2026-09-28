import type { Request, Response, NextFunction } from "express"
import { HttpError, safeErrorCode } from "../errors"
import { logger } from "../logger"
import type { AnalyticsReporter } from "../posthog/reporter"
import { redactHookSecret } from "./request-log"

/**
 * `/api/streams/stream_01H.../messages` becomes `/api/streams/:id/messages`.
 * Error reports leave the region before anyone has consented to anything, so
 * the path must not carry entity ids. Any segment that is not lowercase-kebab
 * is an id, which fails closed: every prefixed ULID (INV-2) holds `_` and
 * uppercase, and no route here has a free-text segment.
 */
const ROUTE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function sanitizeRoutePath(path: string): string {
  return redactHookSecret(path)
    .split("/")
    .map((segment) => (segment === "" || ROUTE_SEGMENT.test(segment) ? segment : ":id"))
    .join("/")
}

/**
 * Shared error middleware. Always returns JSON so API clients never have to
 * fall back to parsing Express' HTML error pages for unexpected failures.
 * Known `HttpError`s carry their own status/code; everything else is logged,
 * reported, and surfaced as a 500.
 *
 * `isAnonymous` marks requests whose failures must not link to anyone: they
 * are still logged and reported, with the route template, method and error
 * code only, never the caller's identity, the raw error or its message.
 */
export function createErrorHandler(deps: {
  analyticsReporter: AnalyticsReporter
  isAnonymous?: (req: Request) => boolean
}) {
  return function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.message,
        ...(err.code && { code: err.code }),
        ...(err.details !== undefined && { details: err.details }),
      })
      return
    }

    if (deps.isAnonymous?.(req)) {
      const errorCode = safeErrorCode(err)
      const path = sanitizeRoutePath(req.path)
      deps.analyticsReporter.captureException(new Error(`Unhandled error (${errorCode ?? "no code"})`), {
        properties: { path, method: req.method, status_code: 500, error_code: errorCode },
      })
      logger.error({ path, method: req.method, errorCode }, "Unhandled error")
    } else {
      deps.analyticsReporter.captureException(err, {
        ...(req.authUser?.id !== undefined && { distinctId: req.authUser.id }),
        properties: { path: sanitizeRoutePath(req.path), method: req.method, status_code: 500 },
      })
      logger.error({ err, path: redactHookSecret(req.path), method: req.method }, "Unhandled error")
    }
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" })
  }
}
