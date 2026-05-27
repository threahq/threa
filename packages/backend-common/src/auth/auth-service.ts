import { WorkOS } from "@workos-inc/node"
import type { SocialProvider } from "@threa/types"
import { logger } from "../logger"
import type { WorkosConfig } from "./types"

export interface AuthResult {
  success: boolean
  user?: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    /**
     * Workspace permission slugs from the WorkOS session JWT.
     *
     * `null` means the JWT carried no `permissions` claim (older tokens issued
     * before WorkOS authz rollout, or the OAuth callback path). Callers should
     * fall back to a role-derived permission set in that case.
     *
     * An empty array (`[]`) means WorkOS explicitly granted no permissions —
     * do **not** fall back, treat as the literal empty set.
     */
    permissions: string[] | null
  }
  sealedSession?: string
  refreshed: boolean
  reason?: string
}

/**
 * Pick the sealed session value to commit/use after `authenticateSession`.
 *
 * WorkOS rotates the refresh token transparently when the access token has
 * expired and returns the rotated sealed in `result.sealedSession` together
 * with `refreshed: true`. The pre-refresh `original` value is revoked at
 * WorkOS the moment rotation runs, so any caller that wants to keep the
 * session alive (write the cookie, re-park, revoke) MUST use the rotated
 * value when one was issued. Centralized here so middleware, the accounts
 * service, and any future caller share one source of truth.
 */
export function pickSealed(result: AuthResult, original: string): string {
  return result.refreshed && result.sealedSession ? result.sealedSession : original
}

export interface AuthService {
  authenticateSession(sealedSession: string): Promise<AuthResult>
  authenticateWithCode(code: string): Promise<AuthResult>
  /**
   * Build the WorkOS authorization URL.
   *
   * @param redirectTo  Optional path/state passed through to the callback.
   * @param redirectUri Optional per-request redirect URI override. When set,
   *                    WorkOS will redirect back to this URI instead of the
   *                    service's default `WORKOS_REDIRECT_URI`. Used by the
   *                    control-plane to support multiple origins (e.g. the
   *                    backoffice on a different TLD) without cookie-domain
   *                    gymnastics.
   * @param options.provider Bypass AuthKit and route directly to a social IdP.
   *                    The add-account flow needs this because AuthKit's
   *                    hosted UI silent-refreshes through its own session
   *                    cookie regardless of `prompt`. When set, we also pass
   *                    `prompt=select_account` to the IdP so the user can
   *                    actually pick a different account.
   */
  getAuthorizationUrl(redirectTo?: string, redirectUri?: string, options?: { provider?: SocialProvider }): string
  /**
   * Send a 6-digit Magic Auth code to the given email.
   *
   * Used as the universal fallback for the custom add-account flow when the
   * user didn't sign up via Google/Microsoft. WorkOS auto-creates a user if
   * none exists for the email — that's intentional: the verify step proves
   * email ownership, which is equivalent to a sign-up.
   */
  sendMagicAuthCode(email: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Verify a Magic Auth code and produce a sealed session for the user.
   *
   * Mirrors {@link authenticateWithCode} shape so the add-account path can
   * funnel both OAuth and Magic Auth through the same park/coalesce logic.
   */
  authenticateWithMagicAuth(email: string, code: string): Promise<AuthResult>
  /**
   * Build a WorkOS single-logout URL.
   *
   * @param sealedSession The encrypted session cookie value.
   * @param returnTo      Optional origin to redirect to after WorkOS clears
   *                      the session. Defaults to the configured
   *                      `WORKOS_REDIRECT_URI`'s origin. Pass a dedicated
   *                      origin (e.g. `https://admin.threa.io`) to send the
   *                      user back to the same origin they started on when
   *                      it can't share cookies with the default.
   */
  getLogoutUrl(sealedSession: string, returnTo?: string): Promise<string | null>
  /**
   * Revoke the real WorkOS session backing a sealed session cookie. Used by
   * the multi-account remove flow so a forgotten account's session is dead at
   * WorkOS, not merely cookie-cleared. Returns `true` if a session was
   * revoked, `false` if the value couldn't be unsealed/authenticated.
   */
  revokeSession(sealedSession: string): Promise<boolean>
}

export class WorkosAuthService implements AuthService {
  private workos: WorkOS
  private clientId: string
  private cookiePassword: string
  private redirectUri: string

  constructor(config: WorkosConfig) {
    this.clientId = config.clientId
    this.cookiePassword = config.cookiePassword
    this.redirectUri = config.redirectUri
    this.workos = new WorkOS(config.apiKey, { clientId: this.clientId })
  }

  async authenticateSession(sealedSession: string): Promise<AuthResult> {
    if (!sealedSession) {
      return {
        success: false,
        refreshed: false,
        reason: "no_session_cookie_provided",
      }
    }

    const session = this.workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.cookiePassword,
    })

    const authRes = await session.authenticate()

    if (authRes.authenticated) {
      return {
        success: true,
        user: {
          id: authRes.user.id,
          email: authRes.user.email,
          firstName: authRes.user.firstName,
          lastName: authRes.user.lastName,
          permissions: authRes.permissions ?? null,
        },
        refreshed: false,
      }
    }

    if (authRes.reason !== "no_session_cookie_provided") {
      try {
        const refreshResult = await session.refresh({
          cookiePassword: this.cookiePassword,
        })
        if (refreshResult.authenticated && refreshResult.sealedSession) {
          logger.debug({ email: refreshResult.user.email }, "Session refreshed successfully")
          return {
            success: true,
            user: {
              id: refreshResult.user.id,
              email: refreshResult.user.email,
              firstName: refreshResult.user.firstName,
              lastName: refreshResult.user.lastName,
              permissions: refreshResult.permissions ?? null,
            },
            sealedSession: refreshResult.sealedSession,
            refreshed: true,
          }
        }
      } catch (error) {
        logger.error({ err: error, reason: authRes.reason }, "Session refresh error")
      }
    }

    return {
      success: false,
      refreshed: false,
      reason: authRes.reason,
    }
  }

  async authenticateWithCode(code: string): Promise<AuthResult> {
    try {
      const { user, sealedSession } = await this.workos.userManagement.authenticateWithCode({
        code,
        clientId: this.clientId,
        session: { sealSession: true, cookiePassword: this.cookiePassword },
      })

      logger.info({ email: user.email, sealedSession: !!sealedSession }, "User authenticated with code")

      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          // OAuth callback response has no permissions claim; downstream
          // callers fall back to role-derived permissions until the next
          // authenticated request through authenticateSession populates them.
          permissions: null,
        },
        sealedSession: sealedSession!,
        refreshed: false,
      }
    } catch (error) {
      logger.error({ err: error }, "Authentication with code failed")
      return {
        success: false,
        refreshed: false,
        reason: "authentication_failed",
      }
    }
  }

  getAuthorizationUrl(redirectTo?: string, redirectUri?: string, options?: { provider?: SocialProvider }): string {
    // Social providers bypass AuthKit's hosted UI. We forward `prompt=select_account`
    // via `providerQueryParams` so the IdP renders its native account picker —
    // the only reliable way to add a *different* account when the user already
    // has a live session at the IdP.
    if (options?.provider) {
      return this.workos.userManagement.getAuthorizationUrl({
        provider: options.provider,
        providerQueryParams: { prompt: "select_account" },
        redirectUri: redirectUri ?? this.redirectUri,
        clientId: this.clientId,
        state: redirectTo ? Buffer.from(redirectTo).toString("base64") : undefined,
      })
    }
    return this.workos.userManagement.getAuthorizationUrl({
      provider: "authkit",
      redirectUri: redirectUri ?? this.redirectUri,
      clientId: this.clientId,
      state: redirectTo ? Buffer.from(redirectTo).toString("base64") : undefined,
    })
  }

  async sendMagicAuthCode(email: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.workos.userManagement.sendMagicAuthCode({ email })
      return { ok: true }
    } catch (error) {
      logger.error({ err: error }, "Failed to send magic auth code")
      return { ok: false, reason: "send_failed" }
    }
  }

  async authenticateWithMagicAuth(email: string, code: string): Promise<AuthResult> {
    try {
      const { user, sealedSession } = await this.workos.userManagement.authenticateWithMagicAuth({
        email,
        code,
        clientId: this.clientId,
        session: { sealSession: true, cookiePassword: this.cookiePassword },
      })

      logger.info({ userId: user.id, sealedSession: !!sealedSession }, "User authenticated with magic auth")

      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          // Same as the OAuth callback path: no JWT permission claim is in the
          // initial authenticate response. The next authenticated request
          // through authenticateSession will populate it.
          permissions: null,
        },
        sealedSession: sealedSession!,
        refreshed: false,
      }
    } catch (error) {
      logger.error({ err: error }, "Authentication with magic auth failed")
      return {
        success: false,
        refreshed: false,
        reason: "authentication_failed",
      }
    }
  }

  async getLogoutUrl(sealedSession: string, returnTo?: string): Promise<string | null> {
    try {
      const session = this.workos.userManagement.loadSealedSession({
        sessionData: sealedSession,
        cookiePassword: this.cookiePassword,
      })

      const resolvedReturnTo = returnTo ?? new URL(this.redirectUri).origin
      return await session.getLogoutUrl({ returnTo: resolvedReturnTo })
    } catch (error) {
      logger.error({ err: error }, "Failed to get logout URL")
      return null
    }
  }

  async revokeSession(sealedSession: string): Promise<boolean> {
    if (!sealedSession) return false
    try {
      const session = this.workos.userManagement.loadSealedSession({
        sessionData: sealedSession,
        cookiePassword: this.cookiePassword,
      })
      const authRes = await session.authenticate()
      if (!authRes.authenticated) return false
      await this.workos.userManagement.revokeSession({ sessionId: authRes.sessionId })
      return true
    } catch (error) {
      logger.error({ err: error }, "Failed to revoke WorkOS session")
      return false
    }
  }
}
