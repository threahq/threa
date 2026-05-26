import type { Request, Response } from "express"
import { z } from "zod/v4"
import {
  HttpError,
  SESSION_COOKIE_NAME,
  clearAltSessionCookie,
  clearSessionCookie,
  displayNameFromWorkos,
  readAltSessionCookies,
  setSessionCookie,
  type AuthService,
} from "@threa/backend-common"
import { MAGIC_CODE_LENGTH, SOCIAL_PROVIDERS } from "@threa/types"
import type { AccountsService } from "../accounts"
import { parseCallbackState, splitInnerState } from "./callback-state"

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
})

const magicSendSchema = z.object({
  email: z.email(),
})

// `intent=add` is required: today the verify endpoint only powers the
// add-account flow. If a plain magic-auth sign-in ever lands, widen this.
const magicVerifySchema = z.object({
  email: z.email(),
  code: z.string().length(MAGIC_CODE_LENGTH),
  intent: z.literal("add"),
})

const logoutQuerySchema = z.object({
  scope: z.enum(["current"]).optional(),
})

/**
 * Validate that a forwarded host is an allowed staging subdomain.
 * Prevents open redirect via X-Forwarded-Host spoofing.
 *
 * Matches both nested subdomains (foo.staging.threa.io) and flat PR subdomains
 * (pr-123-staging.threa.io) which are siblings of the allowed domain, not children.
 */
function isAllowedForwardedHost(host: string, allowedDomain: string): boolean {
  if (host === allowedDomain) return true
  // Nested subdomain: foo.staging.threa.io
  if (host.endsWith(`.${allowedDomain}`)) return true
  // Flat PR subdomain: pr-N-staging.threa.io is a sibling of staging.threa.io
  // under the same base domain. Match the explicit PR pattern only.
  const prPrefix = /^pr-\d+-/
  if (prPrefix.test(host) && host.endsWith(`-${allowedDomain}`)) return true
  return false
}

interface Dependencies {
  authService: AuthService
  /** Owns the park/coalesce cookie-mutation sequence for the add-account flow. */
  accountsService: AccountsService
  /** Base URL of the frontend app (e.g. "https://threa-staging.pages.dev"). Empty string for same-origin. */
  frontendUrl: string
  /** Allowed staging domain for forwarded-host redirects (e.g. "staging.threa.io") */
  allowedRedirectDomain: string
  /**
   * Forwarded hosts that get a dedicated WorkOS redirect URI (and are trusted
   * as redirect targets in the callback independent of `allowedRedirectDomain`).
   * Used for origins that can't share cookies with the default redirect host,
   * e.g. the backoffice at admin.threa.io.
   */
  dedicatedRedirectHosts: string[]
}

/** Is `host` a trusted redirect target? */
function isTrustedHost(host: string, allowedDomain: string, dedicatedHosts: string[]): boolean {
  if (dedicatedHosts.includes(host)) return true
  if (allowedDomain && isAllowedForwardedHost(host, allowedDomain)) return true
  return false
}

export function createControlPlaneAuthHandlers({
  authService,
  accountsService,
  frontendUrl,
  allowedRedirectDomain,
  dedicatedRedirectHosts,
}: Dependencies) {
  return {
    async login(req: Request, res: Response) {
      const redirectTo = req.query.redirect_to as string | undefined

      // Capture the forwarded host so the callback can redirect back to the correct origin.
      // The workspace-router (and backoffice-router) set X-Forwarded-Host on all proxied
      // requests; we cross-check against the allow-list before trusting it.
      const forwardedHost = req.headers["x-forwarded-host"] as string | undefined
      const hostTrusted = !!forwardedHost && isTrustedHost(forwardedHost, allowedRedirectDomain, dedicatedRedirectHosts)

      const isAdd = typeof req.query.intent === "string" && req.query.intent === "add"
      const providerRaw = typeof req.query.provider === "string" ? req.query.provider : undefined
      const provider = SOCIAL_PROVIDERS.find((p) => p === providerRaw)

      // Bare `intent=add` with no provider: hand off to the in-app picker. The
      // hosted AuthKit UI silent-refreshes through its own session cookie, so
      // we can't reliably force an account picker through it. The picker page
      // lets the user choose Google / Microsoft (provider-direct, bypasses
      // AuthKit) or Email code (Magic Auth) instead.
      if (isAdd && !provider) {
        const targetOrigin = hostTrusted && forwardedHost ? `https://${forwardedHost}` : frontendUrl
        const qs = new URLSearchParams()
        if (redirectTo) qs.set("redirect_to", redirectTo)
        const q = qs.toString()
        return res.redirect(`${targetOrigin}/add-account${q ? `?${q}` : ""}`)
      }

      let statePayload = redirectTo
      let redirectUriOverride: string | undefined
      if (hostTrusted && forwardedHost) {
        statePayload = `${forwardedHost}|${redirectTo || "/"}`
        // Hosts on the dedicated list get their own WorkOS redirect URI so the
        // session cookie lands on the correct origin directly — the default
        // "single canonical callback + state redirect" flow can't work across
        // origins that don't share a cookie domain.
        if (dedicatedRedirectHosts.includes(forwardedHost)) {
          redirectUriOverride = `https://${forwardedHost}/api/auth/callback`
        }
      }

      // Multi-account add flow: prefix an `add|` sentinel onto the plaintext
      // state so the callback peels it back off and runs the park/coalesce
      // path. With a social provider the IdP itself shows an account picker
      // (we pass `prompt=select_account` through `getAuthorizationUrl`), so
      // a *different* WorkOS user can actually land in the callback.
      if (isAdd) {
        statePayload = `add|${statePayload ?? ""}`
      }

      const url = authService.getAuthorizationUrl(
        statePayload,
        redirectUriOverride,
        provider ? { provider } : undefined
      )
      res.redirect(url)
    },

    async callback(req: Request, res: Response) {
      const raw = { code: req.query.code || req.body?.code, state: req.query.state || req.body?.state }
      const parsed = callbackSchema.safeParse(raw)
      if (!parsed.success) {
        throw new HttpError("Missing or invalid authorization code", { status: 400, code: "INVALID_CALLBACK" })
      }

      const { code, state } = parsed.data
      const result = await authService.authenticateWithCode(code)

      if (!result.success || !result.user || !result.sealedSession) {
        throw new HttpError("Authentication failed", { status: 401, code: "AUTH_FAILED" })
      }

      const { isAdd, innerState } = parseCallbackState(state)

      const { host, redirectPath: basePath } = splitInnerState(innerState)
      let redirectPath = basePath
      // "host|path" state redirects back to the original forwarded host when
      // it's trusted; otherwise fall back to the canonical frontend origin.
      const appOrigin =
        host && isTrustedHost(host, allowedRedirectDomain, dedicatedRedirectHosts) ? `https://${host}` : frontendUrl

      if (isAdd) {
        const parked = await accountsService.addAndParkActive(
          res,
          req.cookies,
          req.cookies[SESSION_COOKIE_NAME] as string | undefined,
          result.sealedSession,
          result.user.id
        )
        if (parked.ok) {
          // A successful add makes the just-authenticated account active. The
          // pre-add state path belongs to the previous (now parked) account;
          // routing there 403s and bounces straight back via the workspace
          // resolve→switchAccount path, silently undoing the add. Land on the
          // workspace picker instead; ?accountAdded=1 lets the app drop its
          // stale last-workspace pointer so it can't redirect into the old account.
          redirectPath = "/workspaces?accountAdded=1"
        } else {
          // No throw mid-OAuth-callback: the user keeps their existing session
          // and the frontend surfaces the refusal from the query param.
          redirectPath += `${redirectPath.includes("?") ? "&" : "?"}accountError=${encodeURIComponent(parked.code)}`
        }
      } else {
        setSessionCookie(res, result.sealedSession)
      }
      res.redirect(`${appOrigin}${redirectPath}`)
    },

    async logout(req: Request, res: Response) {
      const session = req.cookies[SESSION_COOKIE_NAME]
      const forwardedHost = req.headers["x-forwarded-host"] as string | undefined
      const queryParse = logoutQuerySchema.safeParse(req.query)
      const scope = queryParse.success ? queryParse.data.scope : undefined

      // Where we land on a same-app redirect (no WorkOS round-trip). Falls
      // back to the configured frontend origin, then "/" — same precedence the
      // full-logout path uses below.
      const sameAppOrigin =
        forwardedHost && isTrustedHost(forwardedHost, allowedRedirectDomain, dedicatedRedirectHosts)
          ? `https://${forwardedHost}`
          : frontendUrl || "/"

      // scope=current: revoke just the active session and promote a parked
      // alt, keeping the user signed in as the next account. Reuses the
      // existing remove(active) path so revoke + promote stay in one place.
      // Falls through to full logout when there's no parked alt to promote
      // (or the active session is no longer authenticatable).
      if (scope === "current" && session) {
        const auth = await authService.authenticateSession(session)
        if (auth.success && auth.user) {
          const alts = readAltSessionCookies(req.cookies)
          if (alts.length > 0) {
            // WorkOS may have rotated the refresh token during authenticate;
            // the pre-refresh `session` is dead at WorkOS, so revoke must use
            // the post-refresh sealed (parallels addAndParkActive).
            const sealedToRevoke = auth.refreshed && auth.sealedSession ? auth.sealedSession : session
            try {
              await accountsService.remove(res, req.cookies, sealedToRevoke, auth.user, auth.user.id)
              return res.redirect(sameAppOrigin)
            } catch {
              // Fall through to full logout if the promote path fails — the
              // user still gets logged out, just everywhere at once.
            }
          }
        }
      }

      clearSessionCookie(res)

      // Logout ≠ remove: clear every parked alt cookie too, but leave their
      // WorkOS sessions intact (explicit revoke is the /api/accounts/remove
      // path). This just empties the local cookie jar of all accounts.
      for (const { slot } of readAltSessionCookies(req.cookies)) {
        clearAltSessionCookie(res, slot)
      }

      if (session) {
        // For dedicated-redirect-host sessions, tell WorkOS to single-logout
        // back to the same origin the user started on. Without this override,
        // WorkOS would redirect to the default `WORKOS_REDIRECT_URI`'s origin
        // and the user would land on the wrong frontend (e.g. the main app
        // when they started on the backoffice).
        const returnTo =
          forwardedHost && dedicatedRedirectHosts.includes(forwardedHost) ? `https://${forwardedHost}` : undefined
        const logoutUrl = await authService.getLogoutUrl(session, returnTo)
        if (logoutUrl) {
          return res.redirect(logoutUrl)
        }
      }

      // Fallback when there's no session or getLogoutUrl returned null.
      res.redirect(sameAppOrigin)
    },

    async me(req: Request, res: Response) {
      const authUser = req.authUser
      if (!authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const name = displayNameFromWorkos(authUser)
      res.json({
        id: authUser.id,
        email: authUser.email,
        name,
      })
    },

    async magicSend(req: Request, res: Response) {
      const parsed = magicSendSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid email", { status: 400, code: "INVALID_EMAIL" })
      }
      // Always reply 200 regardless of the underlying outcome — leaking
      // "no user for this email" turns this into an account-existence oracle.
      // Errors are logged inside the service.
      await authService.sendMagicAuthCode(parsed.data.email)
      res.json({ ok: true })
    },

    async magicVerify(req: Request, res: Response) {
      const parsed = magicVerifySchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid verification payload", { status: 400, code: "INVALID_VERIFY" })
      }
      const { email, code } = parsed.data

      const result = await authService.authenticateWithMagicAuth(email, code)
      if (!result.success || !result.user || !result.sealedSession) {
        throw new HttpError("Invalid or expired code", { status: 401, code: "INVALID_CODE" })
      }

      const parked = await accountsService.addAndParkActive(
        res,
        req.cookies,
        req.cookies[SESSION_COOKIE_NAME] as string | undefined,
        result.sealedSession,
        result.user.id
      )
      if (!parked.ok) {
        // Surface the same code the OAuth callback uses so the frontend can
        // render the same toast ("max accounts reached") without branching.
        return res.status(409).json({ ok: false, code: parked.code })
      }
      // Mirror the OAuth callback's post-add landing: workspace picker with
      // `accountAdded=1` so the SPA drops its stale last-workspace pointer.
      res.json({ ok: true, redirectPath: "/workspaces?accountAdded=1" })
    },
  }
}
