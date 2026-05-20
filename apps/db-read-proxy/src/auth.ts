import { timingSafeEqual } from "crypto"
import type { RequestHandler } from "express"

export const PROXY_SECRET_HEADER = "x-proxy-secret"

/**
 * Constant-time comparison of the `X-Proxy-Secret` header against the
 * configured secret. Returns 401 on missing/wrong secret without leaking
 * timing information about which characters matched.
 */
export function createSecretAuthMiddleware(expectedSecret: string): RequestHandler {
  const expected = Buffer.from(expectedSecret, "utf8")
  return function secretAuthMiddleware(req, res, next) {
    const raw = req.header(PROXY_SECRET_HEADER)
    if (!raw) {
      res.status(401).json({ error: "missing X-Proxy-Secret header" })
      return
    }
    const provided = Buffer.from(raw, "utf8")
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: "invalid X-Proxy-Secret" })
      return
    }
    next()
  }
}
