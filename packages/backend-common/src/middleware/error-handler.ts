import type { Request, Response, NextFunction } from "express"
import { HttpError } from "../errors"
import { logger } from "../logger"
import type { ErrorReporter } from "../posthog/error-reporter"

/**
 * Shared error middleware. Always returns JSON so API clients never have to
 * fall back to parsing Express' HTML error pages for unexpected failures.
 * Known `HttpError`s carry their own status/code; everything else is logged,
 * reported, and surfaced as a 500.
 */
export function createErrorHandler(deps: { errorReporter: ErrorReporter }) {
  return function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.message,
        ...(err.code && { code: err.code }),
        ...(err.details !== undefined && { details: err.details }),
      })
      return
    }

    deps.errorReporter.captureException(err, {
      ...(req.authUser?.id !== undefined && { distinctId: req.authUser.id }),
      properties: { path: req.path, method: req.method, status_code: 500 },
    })

    logger.error({ err, path: req.path, method: req.method }, "Unhandled error")
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" })
  }
}
