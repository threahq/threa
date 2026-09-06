import type { Request, Response, NextFunction } from "express"
import { HttpError } from "../errors"
import { logger } from "../logger"
import type { AnalyticsReporter } from "../posthog/reporter"

/**
 * `/api/streams/stream_01H.../messages` becomes `/api/streams/:id/messages`.
 * Error reports leave the region before anyone has consented to anything, so
 * the path must not carry entity ids. Any segment that is not lowercase-kebab
 * is an id, which fails closed: every prefixed ULID (INV-2) holds `_` and
 * uppercase, and no route here has a free-text segment.
 */
const ROUTE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function sanitizeRoutePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === "" || ROUTE_SEGMENT.test(segment) ? segment : ":id"))
    .join("/")
}

/**
 * Shared error middleware. Always returns JSON so API clients never have to
 * fall back to parsing Express' HTML error pages for unexpected failures.
 * Known `HttpError`s carry their own status/code; everything else is logged,
 * reported, and surfaced as a 500.
 */
export function createErrorHandler(deps: { analyticsReporter: AnalyticsReporter }) {
  return function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.message,
        ...(err.code && { code: err.code }),
        ...(err.details !== undefined && { details: err.details }),
      })
      return
    }

    deps.analyticsReporter.captureException(err, {
      ...(req.authUser?.id !== undefined && { distinctId: req.authUser.id }),
      properties: { path: sanitizeRoutePath(req.path), method: req.method, status_code: 500 },
    })

    logger.error({ err, path: req.path, method: req.method }, "Unhandled error")
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" })
  }
}
