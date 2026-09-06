import { timingSafeEqual } from "crypto"
import type { NextFunction, Request, Response } from "express"
import { INTERNAL_API_KEY_HEADER } from "@threahq/types"
import { HttpError } from "../errors"

export { INTERNAL_API_KEY_HEADER }

/**
 * Middleware that validates inter-service requests using a shared secret.
 * Uses timing-safe comparison to prevent side-channel leakage.
 */
export function createInternalAuthMiddleware(internalApiKey: string) {
  const expectedBuf = Buffer.from(internalApiKey)

  return function internalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const provided = req.headers[INTERNAL_API_KEY_HEADER.toLowerCase()]
    if (typeof provided !== "string") {
      next(new HttpError("Invalid or missing internal API key", { status: 401, code: "UNAUTHORIZED" }))
      return
    }
    const providedBuf = Buffer.from(provided)
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      next(new HttpError("Invalid or missing internal API key", { status: 401, code: "UNAUTHORIZED" }))
      return
    }
    next()
  }
}
