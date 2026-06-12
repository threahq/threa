import type { Request, Response, NextFunction } from "express"
import { HttpError } from "../errors"
import { logger } from "../logger"

/**
 * Shared error middleware. Always returns JSON so API clients never have to
 * fall back to parsing Express' HTML error pages for unexpected failures.
 * Known `HttpError`s carry their own status/code; everything else is logged
 * and surfaced as a 500.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.code && { code: err.code }),
      ...(err.details !== undefined && { details: err.details }),
    })
    return
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled error")
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" })
}
