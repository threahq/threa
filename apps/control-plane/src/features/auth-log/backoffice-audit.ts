import type { NextFunction, Request, RequestHandler, Response } from "express"
import type { AuthLogService } from "./service"

/**
 * Audit middleware for the platform-admin backoffice surface, mounted as
 * `app.use("/api/backoffice", ...)` ahead of the per-route auth chain. The
 * finish hook reads identity off `req` at response time (the `auth` middleware
 * has run by then on success paths), so one mount line covers every backoffice
 * route — including denials, which fire before any handler.
 */
export function createBackofficeAuditMiddleware(authLogService: AuthLogService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path
    // Fire once on 'finish' OR 'close': an aborted response may already have
    // streamed customer data to the admin's client, so it still records (same
    // rule as the backend audit middleware's onResponseDone).
    let fired = false
    const record = (aborted: boolean) => {
      if (fired) return
      fired = true
      void authLogService.recordBackofficeRequest({
        workosUserId: req.workosUserId ?? null,
        email: req.authUser?.email ?? null,
        ip: req.ip ?? null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        outcome: res.statusCode >= 400 ? "denied" : "success",
        detail: aborted
          ? { method: req.method, path, status: res.statusCode, aborted: true }
          : { method: req.method, path, status: res.statusCode },
      })
    }
    res.on("finish", () => record(false))
    res.on("close", () => record(!res.writableFinished))
    next()
  }
}
