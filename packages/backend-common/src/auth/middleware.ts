import type { Request, Response, NextFunction } from "express"
import { ACCOUNT_ASSERTION_HEADER, AuthErrorCodes } from "@threahq/types"
import type { AuthService } from "./auth-service"
import { pickSealed } from "./auth-service"
import type { SessionCookies } from "../cookies"

interface AuthenticatedUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  /**
   * Permission slugs from the WorkOS session JWT, or `null` when the token
   * carried no `permissions` claim (older tokens / OAuth-callback path).
   * Bootstrap handlers fall back to role-derived permissions when `null`.
   */
  permissions: string[] | null
}

declare global {
  namespace Express {
    interface Request {
      workosUserId?: string
      authUser?: AuthenticatedUser
      /**
       * Latest valid sealed session for the active account. Equals the rotated
       * sealed when this request triggered a refresh, otherwise the original
       * cookie value. Handlers that re-park or re-set the active cookie MUST
       * read this — `sessionCookies.read(req.cookies)` is the pre-refresh
       * value, which WorkOS has already revoked after refresh-token rotation.
       */
      sealedSession?: string
    }
  }
}

interface Dependencies {
  authService: AuthService
  sessionCookies: SessionCookies
}

export function createAuthMiddleware({ authService, sessionCookies }: Dependencies) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const session = sessionCookies.read(req.cookies)

    if (!session) {
      return res.status(401).json({ error: "Not authenticated" })
    }

    const result = await authService.authenticateSession(session)

    if (!result.success || !result.user) {
      // Clear the cookie only when the session is definitively dead
      // (result.terminal). On an invalid_grant race a sibling request just
      // rotated the token and its Set-Cookie is already on the wire — clearing
      // here would arrive later and destroy that newer session. On a WorkOS
      // outage (refresh threw) the session may be perfectly valid — clearing
      // turns a provider blip into a mass forced logout.
      if (result.terminal) sessionCookies.clear(res)
      return res.status(401).json({ error: "Session expired" })
    }

    if (result.refreshed && result.sealedSession) {
      sessionCookies.set(res, result.sealedSession)
    }

    // The client states which signed-in account it formed this request for.
    // Refuse before any handler runs when the cookie names a different one:
    // work queued under an account that switched away must not execute as the
    // account that replaced it. An absent header is an older client or a
    // non-browser caller and keeps the previous behaviour.
    const asserted = req.headers[ACCOUNT_ASSERTION_HEADER.toLowerCase()]
    if (asserted !== undefined) {
      // Present but unreadable — a duplicated header arrives as an array, an
      // empty one states nothing. Treating either as absent is the bypass the
      // assertion exists to prevent, so a supplied claim we cannot read is
      // refused rather than waved through. Absent stays absent (older clients,
      // API-key and OAuth callers).
      const claim = typeof asserted === "string" ? asserted.trim() : ""
      if (!claim) {
        return res.status(400).json({
          error: "Malformed account assertion",
          code: AuthErrorCodes.INVALID_ACCOUNT_ASSERTION,
        })
      }
      if (claim !== result.user.id) {
        return res.status(409).json({
          error: "This browser is signed in as a different account",
          code: AuthErrorCodes.ACCOUNT_MISMATCH,
        })
      }
    }

    req.workosUserId = result.user.id
    req.authUser = result.user
    req.sealedSession = pickSealed(result, session)
    next()
  }
}
