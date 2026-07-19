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
    res.on("finish", () => {
      void authLogService.recordBackofficeRequest({
        workosUserId: req.workosUserId ?? null,
        email: req.authUser?.email ?? null,
        ip: req.ip ?? null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        outcome: res.statusCode >= 400 ? "denied" : "success",
        detail: { method: req.method, path, status: res.statusCode },
      })
    })
    next()
  }
}
