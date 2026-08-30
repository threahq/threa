import express, { type Express, type Request } from "express"
import type { Pool } from "pg"
import {
  createAuthMiddleware,
  createRateLimit,
  getClientIp,
  errorHandler,
  type AuthService,
  type SessionCookies,
  StubAuthService,
} from "@threa/backend-common"
import { createControlPlaneAuthHandlers, createAuthStubHandlers } from "./features/auth"
import { createAccountsHandlers, AccountsService } from "./features/accounts"
import { createIntegrationHandlers } from "./features/integrations"
import { createIntegrationRouteHandlers } from "./features/integration-routes"
import { createGithubWebhookHandlers, GithubWebhookService, GITHUB_WEBHOOK_PATH } from "./features/github-webhooks"
import { createWorkspaceHandlers, type ControlPlaneWorkspaceService } from "./features/workspaces"
import { createInvitationShadowHandlers, type InvitationShadowService } from "./features/invitation-shadows"
import { createWaitlistHandlers, type WaitlistService } from "./features/waitlist"
import { createBotConnectHandlers, type BotConnectService } from "./features/bot-connect"
import { createBackofficeHandlers, createPlatformAdminMiddleware, type BackofficeService } from "./features/backoffice"
import { createFeatureFlagHandlers, type ControlPlaneFeatureFlagService } from "./features/feature-flags"
import {
  createBackofficeAuthzAdminHandlers,
  createInternalAuthzAdminHandlers,
  type WorkosAuthzAdminService,
} from "./features/workos-authz"
import { createBackofficeAuditMiddleware, type AuthLogService } from "./features/auth-log"
import { createInternalAuthMiddleware } from "./lib/internal-auth"
import type { RegionConfig } from "./config"

interface RateLimitConfig {
  globalMax: number
  authMax: number
  waitlistMax: number
}

interface Dependencies {
  pool: Pool
  authService: AuthService
  sessionCookies: SessionCookies
  workspaceService: ControlPlaneWorkspaceService
  shadowService: InvitationShadowService
  waitlistService: WaitlistService
  botConnectService: BotConnectService
  backofficeService: BackofficeService
  workosAuthzAdminService: WorkosAuthzAdminService
  featureFlagService: ControlPlaneFeatureFlagService
  authLogService: AuthLogService
  internalApiKey: string
  allowDevAuthRoutes: boolean
  frontendUrl: string
  regions: Record<string, RegionConfig>
  workosDedicatedRedirectHosts: string[]
  rateLimits: RateLimitConfig
  githubWebhookSecret: string | null
}

export function registerRoutes(app: Express, deps: Dependencies) {
  const {
    pool,
    authService,
    sessionCookies,
    workspaceService,
    shadowService,
    waitlistService,
    botConnectService,
    backofficeService,
    workosAuthzAdminService,
    featureFlagService,
    authLogService,
    internalApiKey,
    allowDevAuthRoutes,
  } = deps

  const auth = createAuthMiddleware({ authService, sessionCookies })
  const internalAuth = createInternalAuthMiddleware(internalApiKey)
  const requirePlatformAdmin = createPlatformAdminMiddleware({ backofficeService })

  const ipKey = (req: Request) => getClientIp(req, "unknown")
  const globalLimit = createRateLimit({
    name: "cp-global",
    windowMs: 60_000,
    max: deps.rateLimits.globalMax,
    key: ipKey,
    // GitHub webhooks arrive from a small pool of source IPs and a delivery storm
    // (force-push / review flurry) can exceed the global per-IP cap. A 429 reads
    // as a broken endpoint and GitHub auto-disables the App's single webhook URL,
    // so the global limiter must never apply here — authenticity is the HMAC
    // signature. The path gets its own generous limiter (`webhookLimit`) instead of
    // running unbounded, closing the unauthenticated byte-sink.
    // Trailing-slash tolerance mirrors app.ts's JSON-parser skip and the router
    // regex so `/webhook/` is exempt too.
    skip: (req: Request) => {
      const path = req.path.length > 1 ? req.path.replace(/\/$/, "") : req.path
      return path === GITHUB_WEBHOOK_PATH
    },
  })
  // Dedicated limiter for the webhook path: exempt from the global cap (above) but
  // still bounded so an attacker can't stream unbounded bytes at an unauthenticated
  // route. 5000/min per IP is far above GitHub's real delivery rate (a storm from
  // one org's few source IPs never approaches it), so it can only ever throttle
  // abuse, never a legitimate delivery.
  const webhookLimit = createRateLimit({
    name: "cp-github-webhook",
    windowMs: 60_000,
    max: 5000,
    key: ipKey,
  })
  const authLimit = createRateLimit({ name: "cp-auth", windowMs: 60_000, max: deps.rateLimits.authMax, key: ipKey })
  const waitlistLimit = createRateLimit({
    name: "cp-waitlist",
    windowMs: 60_000,
    max: deps.rateLimits.waitlistMax,
    key: ipKey,
  })

  const accountsService = new AccountsService({ authService, sessionCookies, membership: workspaceService })
  const authHandlers = createControlPlaneAuthHandlers({
    authService,
    sessionCookies,
    accountsService,
    frontendUrl: deps.frontendUrl,
    dedicatedRedirectHosts: deps.workosDedicatedRedirectHosts,
    authLogService,
  })
  const workspace = createWorkspaceHandlers({ workspaceService, shadowService })
  const shadow = createInvitationShadowHandlers({ shadowService })
  const waitlist = createWaitlistHandlers({ waitlistService })
  const botConnect = createBotConnectHandlers({ botConnectService })
  // A connecting device polls the token endpoint every 3s (20/min); an office
  // NAT with a dozen devices connecting at once must not trip this, and the
  // device code is what gates the data, not the limiter.
  const botConnectLimit = createRateLimit({ name: "cp-bot-connect", windowMs: 60_000, max: 300, key: ipKey })
  // The user code is the short, human one; its lookup/approve/deny budget is
  // its own and far smaller than the device's polling budget.
  const botConnectCodeLimit = createRateLimit({ name: "cp-bot-connect-code", windowMs: 60_000, max: 20, key: ipKey })
  const integrations = createIntegrationHandlers({ workspaceService, regions: deps.regions })
  const integrationRoutes = createIntegrationRouteHandlers({ pool })
  const backoffice = createBackofficeHandlers({ backofficeService })
  const featureFlags = createFeatureFlagHandlers({ featureFlagService })
  const backofficeAuthz = createBackofficeAuthzAdminHandlers({ pool, adminService: workosAuthzAdminService })
  const internalAuthz = createInternalAuthzAdminHandlers({ pool, adminService: workosAuthzAdminService })
  const accounts = createAccountsHandlers({ accountsService })

  app.get("/readyz", (_, res) => res.json({ status: "ok" }))

  app.use(globalLimit)

  app.get("/api/auth/login", authLimit, authHandlers.login)
  app.all("/api/auth/callback", authLimit, authHandlers.callback)
  app.get("/api/auth/logout", authHandlers.logout)
  // Custom add-account fallback. The hosted AuthKit UI silent-refreshes
  // through its own cookie, so the add-account picker exposes Magic Auth as
  // the cross-IdP fallback alongside provider-direct social buttons.
  app.post("/api/auth/magic/send", authLimit, authHandlers.magicSend)
  app.post("/api/auth/magic/verify", authLimit, authHandlers.magicVerify)

  // Public waitlist signup from the marketing site (threa.io). Unauthenticated;
  // its own IP rate limit guards against spam.
  app.post("/api/waitlist", waitlistLimit, waitlist.signUp)

  // OAuth 2.0 device authorization grant (RFC 8628) for `threa-bot connect`:
  // the device authorizes and polls for its token unauthenticated; the user
  // looks the code up and approves or denies it with a session.
  app.post("/api/oauth/device_authorization", botConnectLimit, botConnect.authorize)
  app.post("/api/oauth/token", botConnectLimit, botConnect.token)
  app.get("/api/bot-connect/lookup", auth, botConnectCodeLimit, botConnect.lookup)
  app.post("/api/bot-connect/approve", auth, botConnectCodeLimit, botConnect.approve)
  app.post("/api/bot-connect/deny", auth, botConnectCodeLimit, botConnect.deny)

  if (authService instanceof StubAuthService) {
    if (!allowDevAuthRoutes) {
      throw new Error("StubAuthService is active but dev auth routes are not allowed in this environment")
    }

    const authStub = createAuthStubHandlers({
      authStubService: authService,
      sessionCookies,
      accountsService,
    })
    app.get("/test-auth-login", authStub.getLoginPage)
    app.post("/test-auth-login", authLimit, authStub.handleLogin)
    app.post("/api/dev/login", authStub.handleDevLogin)
  }

  app.get("/api/auth/me", auth, authHandlers.me)
  app.get("/api/integrations/github/callback", auth, integrations.githubCallback)
  app.get("/api/integrations/linear/callback", auth, integrations.linearCallback)

  // GitHub App webhook ingress. Unauthenticated by session — authenticity is the
  // HMAC signature over the raw body. Mounted only when the secret is configured
  // (INV-11); otherwise the path 404s. express.raw preserves the exact bytes the
  // signature was computed over (the JSON parser is skipped for this path in app.ts).
  if (deps.githubWebhookSecret) {
    const githubWebhookService = new GithubWebhookService({ pool, webhookSecret: deps.githubWebhookSecret })
    const githubWebhook = createGithubWebhookHandlers({ service: githubWebhookService })
    app.post(
      GITHUB_WEBHOOK_PATH,
      webhookLimit,
      express.raw({ type: "application/json", limit: "5mb" }),
      githubWebhook.receive
    )
  }

  // Multi-account: list/resolve/switch/remove run *after* the existing `auth`
  // middleware, which validates only the single active session cookie. Parked
  // alt slots are storage-only and read solely by these handlers.
  app.get("/api/accounts", auth, authLimit, accounts.list)
  app.get("/api/accounts/resolve", auth, authLimit, accounts.resolve)
  app.post("/api/accounts/switch", auth, authLimit, accounts.switch)
  app.post("/api/accounts/remove", auth, authLimit, accounts.remove)

  app.get("/api/workspaces", auth, workspace.list)
  app.post("/api/workspaces", auth, workspace.create)
  app.get("/api/regions", workspace.listRegions)

  app.post("/api/invitations/:id/accept", auth, shadow.accept)

  // Public/unauthenticated link-invite surface (the /join page).
  // Tight rate limit on claim — submitting an email is an effect (sends WorkOS email)
  // and we want to make token-guessing expensive too.
  app.get("/api/invitations/lookup", authLimit, shadow.lookup)
  app.post("/api/invitations/claim", authLimit, shadow.claim)

  // Backoffice app surface. `/me` returns both identity and admin status so
  // the frontend can render a friendly "not authorised" screen; every other
  // backoffice route is gated by requirePlatformAdmin.
  // One mount covers the whole surface: platform-admin access to customer data
  // is auth_log-audited per request (reads AND denials), since WorkOS events
  // only cover identity lifecycle.
  app.use("/api/backoffice", createBackofficeAuditMiddleware(authLogService))
  app.get("/api/backoffice/me", auth, backoffice.me)
  app.get("/api/backoffice/config", auth, requirePlatformAdmin, backoffice.getConfig)
  app.get("/api/backoffice/workspaces", auth, requirePlatformAdmin, backoffice.listWorkspaces)
  app.get("/api/backoffice/workspaces/:id", auth, requirePlatformAdmin, backoffice.getWorkspace)
  app.get("/api/backoffice/workspaces/:id/members", auth, requirePlatformAdmin, backoffice.listWorkspaceMembers)
  app.post(
    "/api/backoffice/workspaces/:id/members/resync",
    auth,
    requirePlatformAdmin,
    backoffice.resyncWorkspaceMembers
  )
  app.get("/api/backoffice/outbox-events/status", auth, requirePlatformAdmin, backoffice.getOutboxEventsStatus)
  app.get("/api/backoffice/workspaces/:id/feature-flags", auth, requirePlatformAdmin, featureFlags.listWorkspaceFlags)
  app.put("/api/backoffice/workspaces/:id/feature-flags", auth, requirePlatformAdmin, featureFlags.setWorkspaceFlag)
  app.get("/api/backoffice/waitlist", auth, requirePlatformAdmin, backoffice.listWaitlist)
  app.get("/api/backoffice/workspaces/:id/invitations", auth, requirePlatformAdmin, backoffice.listWorkspaceInvitations)
  app.get(
    "/api/backoffice/workspace-owner-invitations",
    auth,
    requirePlatformAdmin,
    backoffice.listWorkspaceOwnerInvitations
  )
  app.post(
    "/api/backoffice/workspace-owner-invitations",
    auth,
    requirePlatformAdmin,
    backoffice.createWorkspaceOwnerInvitation
  )
  app.post(
    "/api/backoffice/workspace-owner-invitations/:id/resend",
    auth,
    requirePlatformAdmin,
    backoffice.resendWorkspaceOwnerInvitation
  )
  app.post(
    "/api/backoffice/workspace-owner-invitations/:id/revoke",
    auth,
    requirePlatformAdmin,
    backoffice.revokeWorkspaceOwnerInvitation
  )

  // Backoffice member management — actor is the authenticated platform admin.
  app.post("/api/backoffice/workspaces/:id/members", auth, requirePlatformAdmin, backofficeAuthz.assignMember)
  app.post(
    "/api/backoffice/workspaces/:id/members/:userId/role",
    auth,
    requirePlatformAdmin,
    backofficeAuthz.changeRole
  )
  app.delete("/api/backoffice/workspaces/:id/members/:userId", auth, requirePlatformAdmin, backofficeAuthz.removeMember)

  app.get("/internal/workspaces/:workspaceId/region", internalAuth, workspace.getRegion)
  app.get("/internal/workspaces/:workspaceId/members/:workosUserId", internalAuth, workspace.confirmMembership)
  app.post("/internal/invitation-shadows", internalAuth, shadow.create)
  app.patch("/internal/invitation-shadows/:id", internalAuth, shadow.update)
  app.post("/internal/invitation-shadows/:id/claim", internalAuth, shadow.notifyClaim)
  app.post("/internal/workspaces/:workspaceId/members/:userId/role", internalAuth, internalAuthz.changeRole)
  app.delete("/internal/workspaces/:workspaceId/members/:userId", internalAuth, internalAuthz.removeMember)
  app.put("/internal/integration-routes", internalAuth, integrationRoutes.register)
  app.delete("/internal/integration-routes", internalAuth, integrationRoutes.unregister)

  app.use(errorHandler)
}
