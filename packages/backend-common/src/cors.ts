import { HttpError } from "./errors"

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

    callback(new HttpError("CORS origin not allowed", { status: 403, code: "CORS_ORIGIN_NOT_ALLOWED" }), false)
  }
}
