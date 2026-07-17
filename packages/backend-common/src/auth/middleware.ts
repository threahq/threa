import type { Request, Response, NextFunction } from "express"
import {
  AUTH_SESSION_INVALID_CODE,
  AUTH_TOKEN_EXPIRED_CODE,
  AUTH_UNAVAILABLE_CODE,
  THREA_AUTH_MODE_CLIENT_REFRESH,
  THREA_AUTH_MODE_HEADER,
} from "@threa/types"
import type { AuthService } from "./auth-service"
import { pickSealed } from "./auth-service"
import { SESSION_COOKIE_NAME, clearSessionCookie, setSessionCookie } from "../cookies"

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
       * read this — `req.cookies[SESSION_COOKIE_NAME]` is the pre-refresh
       * value, which WorkOS has already revoked after refresh-token rotation.
       */
      sealedSession?: string
    }
  }
}

interface Dependencies {
  authService: AuthService
}

// Express lower-cases incoming header names.
const AUTH_MODE_HEADER_LOWER = THREA_AUTH_MODE_HEADER.toLowerCase()

export function createAuthMiddleware({ authService }: Dependencies) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const session = req.cookies[SESSION_COOKIE_NAME]

    if (!session) {
      return res.status(401).json({ error: "Not authenticated", code: AUTH_SESSION_INVALID_CODE })
    }

    // Client-refresh mode (see THREA_AUTH_MODE_HEADER in @threa/types): verify
    // the JWT locally, NEVER refresh inline — an expired token 401s fast and
    // the client coordinates the single refresh. Keeps rotating-refresh-token
    // races out of the server on any replica/region topology. Requests without
    // the header (older cached bundles, scripts) keep the implicit refresh.
    const clientRefresh = req.headers?.[AUTH_MODE_HEADER_LOWER] === THREA_AUTH_MODE_CLIENT_REFRESH
    const result = clientRefresh
      ? await authService.verifySession(session)
      : await authService.authenticateSession(session)

    if (clientRefresh && !result.success) {
      // Verify-only failure: expiry is the client's cue to refresh-and-retry;
      // only a session that can never heal (terminal) clears the cookie.
      if (result.terminal) clearSessionCookie(res)
      return res.status(401).json({
        error: "Session expired",
        code: result.terminal ? AUTH_SESSION_INVALID_CODE : AUTH_TOKEN_EXPIRED_CODE,
      })
    }

    if (!result.success || !result.user) {
      // Clear the cookie only when the session is definitively dead
      // (result.terminal). On an invalid_grant race a sibling request just
      // rotated the token and its Set-Cookie is already on the wire — clearing
      // here would arrive later and destroy that newer session. On a WorkOS
      // outage (refresh threw) the session may be perfectly valid — clearing
      // turns a provider blip into a mass forced logout.
      if (result.terminal) clearSessionCookie(res)
      // The code lets a client tell a dead session (redirect to login) from a
      // transient validation failure (keep the session, retry later).
      return res.status(401).json({
        error: "Session expired",
        code: result.terminal ? AUTH_SESSION_INVALID_CODE : AUTH_UNAVAILABLE_CODE,
      })
    }

    if (result.refreshed && result.sealedSession) {
      setSessionCookie(res, result.sealedSession)
    }

    req.workosUserId = result.user.id
    req.authUser = result.user
    req.sealedSession = pickSealed(result, session)
    next()
  }
}
