import type { Request, Response, NextFunction } from "express"
import { HttpError } from "@threahq/backend-common"
import type { BackofficeService } from "./service"

interface Dependencies {
  backofficeService: BackofficeService
}

/**
 * Gate for `/api/backoffice/*` endpoints. Requires a prior auth middleware to
 * have populated `req.workosUserId`. Checks that the user has a platform role
 * in the control-plane `platform_roles` table.
 *
 * Returns 403 (not 401) on a recognised-but-unauthorised session so the
 * frontend can distinguish "log in" from "you are not authorised".
 */
export function createPlatformAdminMiddleware({ backofficeService }: Dependencies) {
  return async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
    const workosUserId = req.workosUserId
    if (!workosUserId) {
      // Auth middleware must run first — if it didn't, treat as an unauthenticated request.
      return next(new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" }))
    }

    const allowed = await backofficeService.isPlatformAdmin(workosUserId)
    if (!allowed) {
      return next(new HttpError("Not authorized for backoffice", { status: 403, code: "NOT_PLATFORM_ADMIN" }))
    }

    next()
  }
}
