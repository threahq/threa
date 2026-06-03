import type { Express, Request } from "express"
import type { Pool } from "pg"
import {
  createAuthMiddleware,
  createRateLimit,
  getClientIp,
  errorHandler,
  type AuthService,
  StubAuthService,
} from "@threa/backend-common"
import { createControlPlaneAuthHandlers, createAuthStubHandlers } from "./features/auth"
import { createAccountsHandlers, AccountsService } from "./features/accounts"
import { createIntegrationHandlers } from "./features/integrations"
import { createWorkspaceHandlers, type ControlPlaneWorkspaceService } from "./features/workspaces"
import { createInvitationShadowHandlers, type InvitationShadowService } from "./features/invitation-shadows"
import { createWaitlistHandlers, type WaitlistService } from "./features/waitlist"
import { createBackofficeHandlers, createPlatformAdminMiddleware, type BackofficeService } from "./features/backoffice"
import {
  createBackofficeAuthzAdminHandlers,
  createInternalAuthzAdminHandlers,
  type WorkosAuthzAdminService,
} from "./features/workos-authz"
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
  workspaceService: ControlPlaneWorkspaceService
  shadowService: InvitationShadowService
  waitlistService: WaitlistService
  backofficeService: BackofficeService
  workosAuthzAdminService: WorkosAuthzAdminService
  internalApiKey: string
  allowDevAuthRoutes: boolean
  frontendUrl: string
  allowedRedirectDomain: string
  regions: Record<string, RegionConfig>
  workosDedicatedRedirectHosts: string[]
  rateLimits: RateLimitConfig
}

export function registerRoutes(app: Express, deps: Dependencies) {
  const {
    pool,
    authService,
    workspaceService,
    shadowService,
    waitlistService,
    backofficeService,
    workosAuthzAdminService,
    internalApiKey,
    allowDevAuthRoutes,
  } = deps

  const auth = createAuthMiddleware({ authService })
  const internalAuth = createInternalAuthMiddleware(internalApiKey)
  const requirePlatformAdmin = createPlatformAdminMiddleware({ backofficeService })

  const ipKey = (req: Request) => getClientIp(req, "unknown")
  const globalLimit = createRateLimit({
    name: "cp-global",
    windowMs: 60_000,
    max: deps.rateLimits.globalMax,
    key: ipKey,
  })
  const authLimit = createRateLimit({ name: "cp-auth", windowMs: 60_000, max: deps.rateLimits.authMax, key: ipKey })
  const waitlistLimit = createRateLimit({
    name: "cp-waitlist",
    windowMs: 60_000,
    max: deps.rateLimits.waitlistMax,
    key: ipKey,
  })

  const accountsService = new AccountsService({ authService, membership: workspaceService })
  const authHandlers = createControlPlaneAuthHandlers({
    authService,
    accountsService,
    frontendUrl: deps.frontendUrl,
    allowedRedirectDomain: deps.allowedRedirectDomain,
    dedicatedRedirectHosts: deps.workosDedicatedRedirectHosts,
  })
  const workspace = createWorkspaceHandlers({ workspaceService, shadowService })
  const shadow = createInvitationShadowHandlers({ shadowService })
  const waitlist = createWaitlistHandlers({ waitlistService })
  const integrations = createIntegrationHandlers({ workspaceService, regions: deps.regions })
  const backoffice = createBackofficeHandlers({ backofficeService })
  const backofficeAuthz = createBackofficeAuthzAdminHandlers({ pool, adminService: workosAuthzAdminService })
  const internalAuthz = createInternalAuthzAdminHandlers({ pool, adminService: workosAuthzAdminService })
  const accounts = createAccountsHandlers({ accountsService })

  // Readiness probe
  app.get("/readyz", (_, res) => res.json({ status: "ok" }))

  // Global rate limit on all routes
  app.use(globalLimit)

  // Auth routes (auth-specific rate limit on login/callback)
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

  // Dev/test auth stub routes
  if (authService instanceof StubAuthService) {
    if (!allowDevAuthRoutes) {
      throw new Error("StubAuthService is active but dev auth routes are not allowed in this environment")
    }

    const authStub = createAuthStubHandlers({
      authStubService: authService,
      accountsService,
    })
    app.get("/test-auth-login", authStub.getLoginPage)
    app.post("/test-auth-login", authLimit, authStub.handleLogin)
    app.post("/api/dev/login", authStub.handleDevLogin)
  }

  app.get("/api/auth/me", auth, authHandlers.me)
  app.get("/api/integrations/github/callback", auth, integrations.githubCallback)
  app.get("/api/integrations/linear/callback", auth, integrations.linearCallback)

  // Multi-account: list/resolve/switch/remove run *after* the existing `auth`
  // middleware, which validates only the single active session cookie. Parked
  // alt slots are storage-only and read solely by these handlers.
  app.get("/api/accounts", auth, authLimit, accounts.list)
  app.get("/api/accounts/resolve", auth, authLimit, accounts.resolve)
  app.post("/api/accounts/switch", auth, authLimit, accounts.switch)
  app.post("/api/accounts/remove", auth, authLimit, accounts.remove)

  // Workspace routes
  app.get("/api/workspaces", auth, workspace.list)
  app.post("/api/workspaces", auth, workspace.create)
  app.get("/api/regions", workspace.listRegions)

  // User-facing invitation acceptance
  app.post("/api/invitations/:id/accept", auth, shadow.accept)

  // Public/unauthenticated link-invite surface (the /join page).
  // Tight rate limit on claim — submitting an email is an effect (sends WorkOS email)
  // and we want to make token-guessing expensive too.
  app.get("/api/invitations/lookup", authLimit, shadow.lookup)
  app.post("/api/invitations/claim", authLimit, shadow.claim)

  // Backoffice app surface. `/me` returns both identity and admin status so
  // the frontend can render a friendly "not authorised" screen; every other
  // backoffice route is gated by requirePlatformAdmin.
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

  // Internal API (inter-service)
  app.get("/internal/workspaces/:workspaceId/region", internalAuth, workspace.getRegion)
  app.get("/internal/workspaces/:workspaceId/members/:workosUserId", internalAuth, workspace.confirmMembership)
  app.post("/internal/invitation-shadows", internalAuth, shadow.create)
  app.patch("/internal/invitation-shadows/:id", internalAuth, shadow.update)
  app.post("/internal/invitation-shadows/:id/claim", internalAuth, shadow.notifyClaim)
  app.post("/internal/workspaces/:workspaceId/members/:userId/role", internalAuth, internalAuthz.changeRole)
  app.delete("/internal/workspaces/:workspaceId/members/:userId", internalAuth, internalAuthz.removeMember)

  app.use(errorHandler)
}
