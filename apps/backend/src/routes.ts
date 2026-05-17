import { z } from "zod"
import type { Express, RequestHandler } from "express"
import { createAuthMiddleware } from "@threa/backend-common"
import { createWorkspaceUserMiddleware } from "./middleware/workspace"
import { createUploadMiddleware, createAvatarUploadMiddleware } from "./middleware/upload"
import { createRateLimiters, type RateLimiterConfig } from "./middleware/rate-limit"
import { createOpsAccessMiddleware } from "./middleware/ops-access"
import { createRequireBotManagement } from "./middleware/bot-management"
import { createRequireWorkspacePermission } from "./middleware/workspace-permission"
import { createWorkspaceAuthzHandlers, WorkspaceAuthzService } from "./features/workspace-authz"
import { createAuthHandlers } from "./auth/handlers"
import { createWorkspaceHandlers, WorkspaceRepository } from "./features/workspaces"
import { createWorkspaceMemberManagementHandlers } from "./features/workspace-members"
import type { ControlPlaneClient } from "./lib/control-plane-client"
import { createStreamHandlers } from "./features/streams"
import { createMessageHandlers } from "./features/messaging"
import { createAttachmentHandlers } from "./features/attachments"
import { createSearchHandlers } from "./features/search"
import { createMemoHandlers } from "./features/memos"
import { createEmojiHandlers } from "./features/emoji"
import { createConversationHandlers } from "./features/conversations"
import { createCommandHandlers } from "./features/commands"
import { createUserPreferencesHandlers } from "./features/user-preferences"
import { createAIUsageHandlers } from "./features/ai-usage"
import type { AI } from "./lib/ai/ai"
import { createInvitationHandlers } from "./features/invitations"
import { createActivityHandlers } from "./features/activity"
import { createSavedMessagesHandlers } from "./features/saved-messages"
import { createScheduledMessagesHandlers } from "./features/scheduled-messages"
import { createPushHandlers } from "./features/push"
import { createDebugHandlers } from "./handlers/debug-handlers"
import { createInternalHandlers } from "./handlers/internal-handlers"
import { createAuthStubHandlers } from "./auth/auth-stub-handlers"
import { createAgentSessionHandlers, createContextBagHandlers } from "./features/agents"
import { createLinkPreviewHandlers } from "./features/link-previews"
import { createWorkspaceIntegrationHandlers } from "./features/workspace-integrations"
import { createPublicApiHandlers, createBotHandlers } from "./features/public-api"
import { BotRuntimeService } from "./features/bot-runtimes"
import { createUserApiKeyHandlers, type UserApiKeyService } from "./features/user-api-keys"
import {
  createInternalAuthMiddleware,
  errorHandler,
  StubAuthService,
  type AuthService,
  type ApiKeyService,
} from "@threa/backend-common"
import { createPublicApiAuthMiddleware, requireApiKeyScope } from "./middleware/public-api-auth"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import type { WorkspaceService } from "./features/workspaces"
import type { StreamService } from "./features/streams"
import type { EventService } from "./features/messaging"
import type { AttachmentService } from "./features/attachments"
import type { SearchService } from "./features/search"
import type { MemoExplorerService } from "./features/memos"
import type { ConversationService } from "./features/conversations"
import type { InvitationService } from "./features/invitations"
import type { ActivityService } from "./features/activity"
import type { SavedMessagesService } from "./features/saved-messages"
import type { ScheduledMessagesService } from "./features/scheduled-messages"
import type { PushService } from "./features/push"
import type { S3Config } from "./lib/env"
import type { StorageProvider } from "./lib/storage/s3-client"
import type { CommandRegistry } from "./features/commands"
import type { UserPreferencesService } from "./features/user-preferences"
import type { AvatarService } from "./features/workspaces"
import type { BotChannelService } from "./features/api-keys"
import type { LinkPreviewService } from "./features/link-previews"
import type { WorkspaceIntegrationService } from "./features/workspace-integrations"
import type { WorkosOrgService } from "@threa/backend-common"
import type { BotApiKeyService } from "./features/public-api"
import type { Pool } from "pg"
import type { PoolMonitor } from "./lib/observability"

interface Dependencies {
  pool: Pool
  poolMonitor: PoolMonitor
  authService: AuthService
  workspaceService: WorkspaceService
  streamService: StreamService
  eventService: EventService
  attachmentService: AttachmentService
  searchService: SearchService
  memoExplorerService: MemoExplorerService
  conversationService: ConversationService
  userPreferencesService: UserPreferencesService
  invitationService: InvitationService
  activityService: ActivityService
  savedMessagesService: SavedMessagesService
  scheduledMessagesService: ScheduledMessagesService
  pushService: PushService
  s3Config: S3Config
  commandRegistry: CommandRegistry
  avatarService: AvatarService
  rateLimiterConfig: RateLimiterConfig
  corsAllowedOrigins: string[]
  allowDevAuthRoutes: boolean
  internalApiKey: string | null
  apiKeyService: ApiKeyService
  botChannelService: BotChannelService
  linkPreviewService: LinkPreviewService
  workspaceIntegrationService: WorkspaceIntegrationService
  workspaceAuthzService: WorkspaceAuthzService
  workosOrgService: WorkosOrgService
  userApiKeyService: UserApiKeyService
  botApiKeyService: BotApiKeyService
  storage: StorageProvider
  ai: AI
  controlPlaneClient: ControlPlaneClient | null
}

export function registerRoutes(app: Express, deps: Dependencies) {
  const {
    pool,
    poolMonitor,
    authService,
    workspaceService,
    streamService,
    eventService,
    attachmentService,
    searchService,
    memoExplorerService,
    conversationService,
    userPreferencesService,
    invitationService,
    activityService,
    savedMessagesService,
    scheduledMessagesService,
    pushService,
    s3Config,
    commandRegistry,
    avatarService,
    rateLimiterConfig,
    corsAllowedOrigins,
    allowDevAuthRoutes,
    internalApiKey,
    apiKeyService,
    botChannelService,
    linkPreviewService,
    workspaceIntegrationService,
    workspaceAuthzService,
    workosOrgService,
    userApiKeyService,
    botApiKeyService,
    storage,
    ai,
    controlPlaneClient,
  } = deps

  const auth = createAuthMiddleware({ authService })
  const workspaceUser = createWorkspaceUserMiddleware({ pool, workspaceService, controlPlaneClient })
  const upload = createUploadMiddleware({ s3Config })
  // Express natively chains handlers - spread array at usage sites
  const authed: RequestHandler[] = [auth, workspaceUser]

  const requireWorkspacePermission = createRequireWorkspacePermission()
  const workspaceAuthz = createWorkspaceAuthzHandlers({ workspaceAuthzService })

  const rateLimits = createRateLimiters(rateLimiterConfig)
  const opsAccess = createOpsAccessMiddleware()

  const authHandlers = createAuthHandlers()
  const avatarUpload = createAvatarUploadMiddleware()
  const workspace = createWorkspaceHandlers({
    workspaceService,
    streamService,
    userPreferencesService,
    invitationService,
    activityService,
    commandRegistry,
    avatarService,
    workosOrgService,
    pool,
  })
  const stream = createStreamHandlers({ pool, streamService, eventService, activityService, linkPreviewService })
  const message = createMessageHandlers({ pool, eventService, streamService, commandRegistry })
  const attachment = createAttachmentHandlers({ attachmentService, streamService, storage, pool })
  const search = createSearchHandlers({ pool, searchService })
  const memo = createMemoHandlers({ pool, memoExplorerService })
  const emoji = createEmojiHandlers()
  const conversation = createConversationHandlers({ conversationService, streamService })
  const command = createCommandHandlers({ pool, commandRegistry, streamService })
  const preferences = createUserPreferencesHandlers({ userPreferencesService })
  const aiUsage = createAIUsageHandlers({ pool })
  const debug = createDebugHandlers({ pool, poolMonitor })
  const invitation = createInvitationHandlers({ invitationService })
  const activity = createActivityHandlers({ activityService })
  const savedMessages = createSavedMessagesHandlers({ savedMessagesService })
  const scheduledMessages = createScheduledMessagesHandlers({ scheduledMessagesService })
  const agentSession = createAgentSessionHandlers({ pool })
  const contextBag = createContextBagHandlers({ pool, ai })
  const linkPreview = createLinkPreviewHandlers({ linkPreviewService })
  const workspaceIntegration = createWorkspaceIntegrationHandlers({
    workspaceIntegrationService,
    allowedFrontendOrigins: corsAllowedOrigins,
  })

  // Ops endpoints - registered before rate limiter so probes aren't throttled
  app.get("/readyz", opsAccess, debug.readiness)
  app.get("/debug/pool", opsAccess, debug.poolState)
  app.get("/metrics", opsAccess, debug.metrics)

  // Internal API — control-plane → regional backend, protected by shared secret
  if (internalApiKey) {
    const internalAuth = createInternalAuthMiddleware(internalApiKey)
    const internal = createInternalHandlers({ workspaceService, invitationService })

    app.post("/internal/workspaces", internalAuth, internal.createWorkspace)
    app.post("/internal/invitations/:id/accept", internalAuth, internal.acceptInvitation)
    app.post("/internal/invitations/claim-link", internalAuth, invitation.claimLink)
    app.post("/internal/authz/memberships", internalAuth, workspaceAuthz.syncMembership)
  }

  // Global baseline rate limit
  app.use(rateLimits.globalBaseline)

  // The router proxies /api/auth/* to the control-plane in production.

  if (authService instanceof StubAuthService) {
    if (!allowDevAuthRoutes) {
      throw new Error("StubAuthService is active but dev auth routes are not allowed in this environment")
    }

    const authStub = createAuthStubHandlers({
      authStubService: authService,
      workspaceService,
      streamService,
      invitationService,
    })

    app.get("/test-auth-login", authStub.getLoginPage)
    app.post("/test-auth-login", authStub.handleLogin)
    app.post("/api/dev/login", authStub.handleDevLogin)
    app.post("/api/dev/workspaces/:workspaceId/join", auth, authStub.handleWorkspaceJoin)
    app.post("/api/dev/workspaces/:workspaceId/streams/:streamId/join", auth, workspaceUser, authStub.handleStreamJoin)
  }

  app.get("/api/auth/me", auth, authHandlers.me)

  // Workspace list/create are also on the control-plane. The router proxies
  // GET/POST /api/workspaces to the control-plane in production. These stay
  // here for direct backend testing and single-region dev without the router.
  app.get("/api/workspaces", auth, workspace.list)
  app.post("/api/workspaces", auth, workspace.create)
  app.get("/api/workspaces/:workspaceId", ...authed, workspace.get)
  app.get("/api/workspaces/:workspaceId/bootstrap", ...authed, workspace.bootstrap)
  app.get("/api/workspaces/:workspaceId/users", ...authed, workspace.getUsers)
  app.get("/api/workspaces/:workspaceId/emojis", ...authed, emoji.list)

  // User preferences
  app.get("/api/workspaces/:workspaceId/preferences", ...authed, preferences.get)
  app.patch("/api/workspaces/:workspaceId/preferences", ...authed, preferences.update)

  app.get("/api/workspaces/:workspaceId/streams", ...authed, stream.list)
  app.post("/api/workspaces/:workspaceId/streams", ...authed, stream.create)
  app.post("/api/workspaces/:workspaceId/streams/read-all", ...authed, workspace.markAllAsRead)
  app.get("/api/workspaces/:workspaceId/streams/slug-available", ...authed, stream.checkSlugAvailable)
  app.get("/api/workspaces/:workspaceId/streams/:streamId", ...authed, stream.get)
  app.patch("/api/workspaces/:workspaceId/streams/:streamId", ...authed, stream.update)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/bootstrap", ...authed, stream.bootstrap)
  app.patch("/api/workspaces/:workspaceId/streams/:streamId/companion", ...authed, stream.updateCompanionMode)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/pin", ...authed, stream.pin)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/notification-level", ...authed, stream.setNotificationLevel)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/join", ...authed, stream.join)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/read", ...authed, stream.markAsRead)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/archive", ...authed, stream.archive)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/unarchive", ...authed, stream.unarchive)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/members", ...authed, stream.addMember)
  app.delete(
    "/api/workspaces/:workspaceId/streams/:streamId/members/:memberId",
    ...authed,
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE),
    stream.removeMember
  )

  app.get("/api/workspaces/:workspaceId/streams/:streamId/events", ...authed, stream.listEvents)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/events/around", ...authed, stream.listEventsAround)

  // Search
  app.post("/api/workspaces/:workspaceId/search", ...authed, rateLimits.search, search.search)
  app.post("/api/workspaces/:workspaceId/memos/search", ...authed, rateLimits.search, memo.search)
  app.get("/api/workspaces/:workspaceId/memos/:memoId", ...authed, memo.getById)

  app.post("/api/workspaces/:workspaceId/messages", ...authed, rateLimits.messageCreate, message.create)
  app.post(
    "/api/workspaces/:workspaceId/messages/move-to-thread/validate",
    ...authed,
    rateLimits.messageCreate,
    message.validateMoveToThread
  )
  app.post(
    "/api/workspaces/:workspaceId/messages/move-to-thread",
    ...authed,
    rateLimits.messageCreate,
    message.moveToThread
  )
  app.patch("/api/workspaces/:workspaceId/messages/:messageId", ...authed, message.update)
  app.delete("/api/workspaces/:workspaceId/messages/:messageId", ...authed, message.delete)
  app.get("/api/workspaces/:workspaceId/messages/:messageId/versions", ...authed, message.getHistory)
  app.post("/api/workspaces/:workspaceId/messages/:messageId/reactions", ...authed, message.addReaction)
  app.delete("/api/workspaces/:workspaceId/messages/:messageId/reactions/:emoji", ...authed, message.removeReaction)

  // Attachments (workspace-scoped upload, stream assigned on message creation)
  app.post("/api/workspaces/:workspaceId/attachments", ...authed, rateLimits.upload, upload, attachment.upload)
  app.post("/api/workspaces/:workspaceId/attachments/search", ...authed, rateLimits.search, attachment.search)
  app.get("/api/workspaces/:workspaceId/attachments/:attachmentId/url", ...authed, attachment.getDownloadUrl)
  app.get("/api/workspaces/:workspaceId/attachments/:attachmentId/extraction", ...authed, attachment.getExtraction)
  app.delete("/api/workspaces/:workspaceId/attachments/:attachmentId", ...authed, attachment.delete)

  // Conversations
  app.get("/api/workspaces/:workspaceId/streams/:streamId/conversations", ...authed, conversation.listByStream)
  app.get("/api/workspaces/:workspaceId/conversations/:conversationId", ...authed, conversation.getById)
  app.get("/api/workspaces/:workspaceId/conversations/:conversationId/messages", ...authed, conversation.getMessages)

  // Commands
  app.post("/api/workspaces/:workspaceId/commands/dispatch", ...authed, rateLimits.commandDispatch, command.dispatch)
  app.get("/api/workspaces/:workspaceId/commands", ...authed, command.list)

  // Invitations and member management — gated on members:write
  const requireMembersWrite = requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)

  const memberManagement = createWorkspaceMemberManagementHandlers({ pool, controlPlaneClient })
  app.post(
    "/api/workspaces/:workspaceId/users/:userId/role",
    ...authed,
    requireMembersWrite,
    memberManagement.changeRole
  )
  app.delete(
    "/api/workspaces/:workspaceId/users/:userId",
    ...authed,
    requireMembersWrite,
    memberManagement.removeMember
  )

  app.get("/api/workspaces/:workspaceId/invitations", ...authed, requireMembersWrite, invitation.list)
  app.post("/api/workspaces/:workspaceId/invitations", ...authed, requireMembersWrite, invitation.send)
  app.post("/api/workspaces/:workspaceId/invitations/links", ...authed, requireMembersWrite, invitation.createLink)
  app.post(
    "/api/workspaces/:workspaceId/invitations/:invitationId/revoke",
    ...authed,
    requireMembersWrite,
    invitation.revoke
  )
  app.post(
    "/api/workspaces/:workspaceId/invitations/:invitationId/resend",
    ...authed,
    requireMembersWrite,
    invitation.resend
  )

  // User setup (any authenticated workspace user)
  app.get("/api/workspaces/:workspaceId/slug-available", ...authed, workspace.checkSlugAvailability)
  app.post("/api/workspaces/:workspaceId/setup", ...authed, workspace.completeUserSetup)

  // User profile
  app.patch("/api/workspaces/:workspaceId/profile", ...authed, workspace.updateProfile)
  app.post("/api/workspaces/:workspaceId/profile/avatar", ...authed, avatarUpload, workspace.uploadAvatar)
  app.delete("/api/workspaces/:workspaceId/profile/avatar", ...authed, workspace.removeAvatar)

  // Avatar file serving (unauthenticated — S3 keys contain unguessable ULIDs)
  app.get("/api/workspaces/:workspaceId/users/:userId/avatar/:file", workspace.serveAvatarFile)

  // AI Usage and Budget
  app.get("/api/workspaces/:workspaceId/ai-usage", ...authed, aiUsage.getUsage)
  app.get("/api/workspaces/:workspaceId/ai-usage/recent", ...authed, aiUsage.getRecentUsage)
  app.get("/api/workspaces/:workspaceId/ai-budget", ...authed, aiUsage.getBudget)
  app.put(
    "/api/workspaces/:workspaceId/ai-budget",
    ...authed,
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    aiUsage.updateBudget
  )

  // Activity feed
  app.get("/api/workspaces/:workspaceId/activity", ...authed, activity.list)
  app.post("/api/workspaces/:workspaceId/activity/read", ...authed, activity.markAllAsRead)
  app.post("/api/workspaces/:workspaceId/activity/:id/read", ...authed, activity.markOneAsRead)

  // Saved messages
  app.get("/api/workspaces/:workspaceId/saved", ...authed, savedMessages.list)
  app.post("/api/workspaces/:workspaceId/saved", ...authed, savedMessages.create)
  app.patch("/api/workspaces/:workspaceId/saved/:savedId", ...authed, savedMessages.update)
  app.delete("/api/workspaces/:workspaceId/saved/:savedId", ...authed, savedMessages.delete)

  // Scheduled messages
  app.get("/api/workspaces/:workspaceId/scheduled", ...authed, scheduledMessages.list)
  app.post("/api/workspaces/:workspaceId/scheduled", ...authed, scheduledMessages.create)
  app.get("/api/workspaces/:workspaceId/scheduled/:id", ...authed, scheduledMessages.getById)
  app.patch("/api/workspaces/:workspaceId/scheduled/:id", ...authed, scheduledMessages.update)
  app.delete("/api/workspaces/:workspaceId/scheduled/:id", ...authed, scheduledMessages.delete)
  app.post("/api/workspaces/:workspaceId/scheduled/:id/lock", ...authed, scheduledMessages.lockForEdit)
  app.post("/api/workspaces/:workspaceId/scheduled/:id/unlock", ...authed, scheduledMessages.releaseEditLock)
  app.post("/api/workspaces/:workspaceId/scheduled/:id/send-now", ...authed, scheduledMessages.sendNow)

  // Push notifications
  const push = createPushHandlers({ pushService })
  app.get("/api/workspaces/:workspaceId/push/vapid-key", ...authed, push.getVapidKey)
  app.post("/api/workspaces/:workspaceId/push/subscribe", ...authed, push.subscribe)
  app.post("/api/workspaces/:workspaceId/push/unsubscribe", ...authed, push.unsubscribe)
  app.post("/api/workspaces/:workspaceId/push/test", ...authed, rateLimits.pushTest, push.sendTest)
  // Non-workspace-scoped: cleans up all push subscriptions for a browser endpoint (used on logout)
  app.post("/api/push/cleanup-endpoint", auth, push.cleanupEndpoint)

  // Agent Sessions (trace viewing)
  app.get("/api/workspaces/:workspaceId/agent-sessions/:sessionId", ...authed, agentSession.getSession)

  // Context-bag standalone precompute (composer draft flow)
  app.post("/api/workspaces/:workspaceId/context-bag/precompute", ...authed, contextBag.precompute)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/context-bag", ...authed, contextBag.getStreamBag)

  // Link Previews
  app.get("/api/workspaces/:workspaceId/messages/:messageId/link-previews", ...authed, linkPreview.getForMessage)
  app.post(
    "/api/workspaces/:workspaceId/messages/:messageId/link-previews/:linkPreviewId/dismiss",
    ...authed,
    linkPreview.dismiss
  )
  app.get(
    "/api/workspaces/:workspaceId/link-previews/:linkPreviewId/resolve",
    ...authed,
    linkPreview.resolveMessageLink
  )

  // Workspace integrations — gated on workspace:admin
  const requireWorkspaceAdmin = requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  app.get(
    "/api/workspaces/:workspaceId/integrations/github",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.getGithub
  )
  app.get(
    "/api/workspaces/:workspaceId/integrations/github/connect",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.connectGithub
  )
  app.delete(
    "/api/workspaces/:workspaceId/integrations/github",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.disconnectGithub
  )
  app.post(
    "/api/workspaces/:workspaceId/integrations/github/sync",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.syncGithub
  )

  app.get(
    "/api/workspaces/:workspaceId/integrations/linear",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.getLinear
  )
  app.get(
    "/api/workspaces/:workspaceId/integrations/linear/connect",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.connectLinear
  )
  app.delete(
    "/api/workspaces/:workspaceId/integrations/linear",
    ...authed,
    requireWorkspaceAdmin,
    workspaceIntegration.disconnectLinear
  )

  // Fixed callback targets for provider installation flows (workspace resolved from signed state)
  app.get("/api/integrations/github/callback", auth, workspaceIntegration.githubCallback)
  app.get("/api/integrations/linear/callback", auth, workspaceIntegration.linearCallback)

  // User API key management (any authenticated user)
  const userApiKeys = createUserApiKeyHandlers({ userApiKeyService })
  app.get("/api/workspaces/:workspaceId/user-api-keys", ...authed, userApiKeys.list)
  app.post("/api/workspaces/:workspaceId/user-api-keys", ...authed, userApiKeys.create)
  app.post("/api/workspaces/:workspaceId/user-api-keys/:keyId/revoke", ...authed, userApiKeys.revoke)

  // Bot management. Management routes (update, archive, keys, avatar, grants)
  // are gated by `requireBotManagement()` middleware that resolves the bot,
  // authorizes the actor (ownership for personal bots, BOTS_MANAGE for shared),
  // and attaches the bot to req.bot so handlers don't re-fetch it.
  const botHandlers = createBotHandlers({ botApiKeyService, avatarService, streamService, pool })
  const requireBotManagement = createRequireBotManagement(pool)
  app.get("/api/workspaces/:workspaceId/bots", ...authed, botHandlers.list)
  app.post("/api/workspaces/:workspaceId/bots", ...authed, botHandlers.create)
  app.get("/api/workspaces/:workspaceId/bots/:botId", ...authed, botHandlers.get)
  app.patch("/api/workspaces/:workspaceId/bots/:botId", ...authed, requireBotManagement(), botHandlers.update)
  app.post("/api/workspaces/:workspaceId/bots/:botId/archive", ...authed, requireBotManagement(), botHandlers.archive)
  app.post("/api/workspaces/:workspaceId/bots/:botId/restore", ...authed, requireBotManagement(), botHandlers.restore)
  app.get("/api/workspaces/:workspaceId/bots/:botId/keys", ...authed, requireBotManagement(), botHandlers.listKeys)
  app.post("/api/workspaces/:workspaceId/bots/:botId/keys", ...authed, requireBotManagement(), botHandlers.createKey)
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/keys/:keyId/revoke",
    ...authed,
    requireBotManagement(),
    botHandlers.revokeKey
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/avatar",
    ...authed,
    requireBotManagement(),
    avatarUpload,
    botHandlers.uploadAvatar
  )
  app.delete(
    "/api/workspaces/:workspaceId/bots/:botId/avatar",
    ...authed,
    requireBotManagement(),
    botHandlers.removeAvatar
  )
  // Bot avatar serving (unauthenticated — S3 keys contain unguessable ULIDs)
  app.get("/api/workspaces/:workspaceId/bots/:botId/avatar/:file", botHandlers.serveAvatarFile)
  // Bot channel access grants
  app.get(
    "/api/workspaces/:workspaceId/bots/:botId/streams",
    ...authed,
    requireBotManagement(),
    botHandlers.listStreamGrants
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/streams/:streamId/grant",
    ...authed,
    requireBotManagement(),
    botHandlers.grantStreamAccess
  )
  app.delete(
    "/api/workspaces/:workspaceId/bots/:botId/streams/:streamId/grant",
    ...authed,
    requireBotManagement(),
    botHandlers.revokeStreamAccess
  )
  // Stream → bots reverse lookup (admin-only — only admins manage stream bot inventories)
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/bots",
    ...authed,
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE),
    botHandlers.listStreamBots
  )

  // Public API v1 — API key auth (workspace-scoped or user-scoped)
  const publicAuth = createPublicApiAuthMiddleware({ userApiKeyService, botApiKeyService, workspaceAuthzService, pool })
  const botRuntimeService = new BotRuntimeService({ pool })
  const publicApi = createPublicApiHandlers({
    searchService,
    memoExplorerService,
    attachmentService,
    botChannelService,
    botRuntimeService,
    streamService,
    eventService,
    pool,
  })
  const publicMiddleware = [rateLimits.publicApiWorkspace, rateLimits.publicApiKey, publicAuth] as const

  app.post(
    "/api/v1/workspaces/:workspaceId/messages/search",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH),
    publicApi.searchMessages
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/memos/search",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MEMOS_READ),
    publicApi.searchMemos
  )
  app.get(
    "/api/v1/workspaces/:workspaceId/memos/:memoId",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MEMOS_READ),
    publicApi.getMemo
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/attachments/search",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ),
    publicApi.searchAttachments
  )
  app.get(
    "/api/v1/workspaces/:workspaceId/attachments/:attachmentId",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ),
    publicApi.getAttachment
  )
  app.get(
    "/api/v1/workspaces/:workspaceId/attachments/:attachmentId/url",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ),
    publicApi.getAttachmentDownloadUrl
  )

  // Bot runtimes
  app.post(
    "/api/v1/workspaces/:workspaceId/bot-runtime/presence",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE),
    publicApi.upsertBotRuntimePresence
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/bot-invocations/claim",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE),
    publicApi.claimBotInvocation
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/complete",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE),
    publicApi.completeBotInvocation
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/fail",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE),
    publicApi.failBotInvocation
  )

  // Streams
  app.get(
    "/api/v1/workspaces/:workspaceId/streams",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.STREAMS_READ),
    publicApi.listStreams
  )
  app.get(
    "/api/v1/workspaces/:workspaceId/streams/:streamId",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.STREAMS_READ),
    publicApi.getStream
  )
  app.get(
    "/api/v1/workspaces/:workspaceId/streams/:streamId/members",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.STREAMS_READ),
    publicApi.listMembers
  )

  // Messages
  app.get(
    "/api/v1/workspaces/:workspaceId/streams/:streamId/messages",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ),
    publicApi.listMessages
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/streams/:streamId/messages",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE),
    publicApi.sendMessage
  )
  app.post(
    "/api/v1/workspaces/:workspaceId/messages/find-by-metadata",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ),
    publicApi.findMessagesByMetadata
  )
  app.patch(
    "/api/v1/workspaces/:workspaceId/messages/:messageId",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE),
    publicApi.updateMessage
  )
  app.delete(
    "/api/v1/workspaces/:workspaceId/messages/:messageId",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE),
    publicApi.deleteMessage
  )

  // Users
  app.get(
    "/api/v1/workspaces/:workspaceId/users",
    ...publicMiddleware,
    requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.USERS_READ),
    publicApi.listUsers
  )

  // Identity — no scope check. Authentication alone is sufficient for a key
  // to introspect itself and (for user keys) enumerate the owner's personal bots.
  app.get("/api/v1/workspaces/:workspaceId/me", ...publicMiddleware, publicApi.getMe)
  app.get("/api/v1/workspaces/:workspaceId/me/bots", ...publicMiddleware, publicApi.listMyBots)

  app.use(errorHandler)
}
