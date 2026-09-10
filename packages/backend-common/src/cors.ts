import { HttpError } from "./errors"
import { logger } from "./logger"

type CorsOriginCallback = (err: Error | null, origin?: boolean) => void
type CorsOriginChecker = (origin: string | undefined, callback: CorsOriginCallback) => void

export function createCorsOriginChecker(allowedOrigins: string[]): CorsOriginChecker {
  const allowlist = new Set(allowedOrigins)

  return (origin, callback) => {
    // Allow requests without Origin header (same-origin, mobile apps, curl, health checks).
    if (!origin) {
      callback(null, true)
      return
    }

    if (allowlist.has(origin)) {
      callback(null, true)
      return
    }

    // The error middleware answers an HttpError without logging it, so this is
    // the only record of which origin was turned away.
    logger.warn({ origin }, "Rejected a request from a disallowed CORS origin")
    callback(new HttpError("CORS origin not allowed", { status: 403, code: "CORS_ORIGIN_NOT_ALLOWED" }), false)
  }
}
