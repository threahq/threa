import { z } from "zod"
import type { Express, RequestHandler } from "express"
import type { Server } from "socket.io"
import { createAuthMiddleware } from "@threa/backend-common"
import { createWorkspaceUserMiddleware } from "./middleware/workspace"
import { createUploadMiddleware, createAvatarUploadMiddleware } from "./middleware/upload"
import { createRateLimiters, type RateLimiterConfig } from "./middleware/rate-limit"
import { createOpsAccessMiddleware } from "./middleware/ops-access"
import { createRequireBotManagement } from "./middleware/bot-management"
import { createRequireWorkspacePermission } from "./middleware/workspace-permission"
import { createWorkspaceAuthzHandlers, WorkspaceAuthzService } from "./features/workspace-authz"
import { createFeatureFlagHandlers, type FeatureFlagService } from "./features/feature-flags"
import { createPlatformAdminHandlers, type PlatformAdminService } from "./features/platform-admin"
import { createAuthHandlers } from "./auth/handlers"
import { createWorkspaceHandlers, WorkspaceRepository } from "./features/workspaces"
import { createWorkspaceMemberManagementHandlers } from "./features/workspace-members"
import type { ControlPlaneClient } from "./lib/control-plane-client"
import { createStreamHandlers, createStreamBriefHandlers, StreamBriefService } from "./features/streams"
import { createMessageHandlers } from "./features/messaging"
import { createAttachmentHandlers } from "./features/attachments"
import { createSearchHandlers } from "./features/search"
import { createMemoHandlers } from "./features/memos"
import { createEmojiHandlers } from "./features/emoji"
import { createConversationHandlers, BoardExclusionService, BoundaryExtractionService } from "./features/conversations"
import { CommandAvailabilityService, createCommandHandlers } from "./features/commands"
import { createUserPreferencesHandlers } from "./features/user-preferences"
import { createWorkspaceSettingsHandlers } from "./features/workspace-settings"
import { createSidebarConfigHandlers } from "./features/sidebar-config"
import { createBoardViewHandlers, BoardViewService } from "./features/board-views"
import { createUserE2eKeysHandlers } from "./features/user-e2e-keys"
import { createAIUsageHandlers } from "./features/ai-usage"
import type { AICostServiceLike } from "./features/ai-usage"
import type { AI } from "@threa/agent-runtime"
import { createInvitationHandlers } from "./features/invitations"
import { createActivityHandlers } from "./features/activity"
import { createSyncHandlers } from "./features/sync"
import { createSavedMessagesHandlers } from "./features/saved-messages"
import { createSavedSuggestionsHandlers } from "./features/saved-suggestions"
import { createScheduledMessagesHandlers } from "./features/scheduled-messages"
import { createDraftsHandlers } from "./features/drafts"
import { createLabelHandlers } from "./features/labels"
import { createPushHandlers } from "./features/push"
import { createDebugHandlers } from "./handlers/debug-handlers"
import { createInternalHandlers } from "./handlers/internal-handlers"
import { createAuthStubHandlers } from "./auth/auth-stub-handlers"
import {
  createAgentSessionHandlers,
  createContextBagHandlers,
  createAgentFollowUpHandlers,
  createPersonaConfigHandlers,
} from "./features/agents"
import { createLinkPreviewHandlers } from "./features/link-previews"
import { createGiphyHandlers } from "./features/giphy"
import { createWorkspaceIntegrationHandlers } from "./features/workspace-integrations"
import {
  createPublicApiHandlers,
  createBotHandlers,
  createDelegationPublicApiHandlers,
  PUBLIC_API_ROUTES,
  type OperationId,
  toExpressPath,
  assertHandlerParity,
} from "./features/public-api"
import { BotRuntimeService, type BotRuntimeWriteOps } from "./features/bot-runtimes"
import { createUserApiKeyHandlers, type UserApiKeyService } from "./features/user-api-keys"
import { createVoiceTranscriptionHandlers, type VoiceTranscriptionService } from "./features/voice-transcription"
import {
  createEnclaveRuntimesHandlers,
  createEnclaveSessionHandlers,
  type EnclaveClaimService,
  type EnclaveClaimWaiter,
  type EnclaveRuntimesService,
} from "./features/enclave-runtimes"
import {
  createInternalAuthMiddleware,
  errorHandler,
  StubAuthService,
  type AuthService,
  type ApiKeyService,
} from "@threa/backend-common"
import { createPublicApiAuthMiddleware, requireApiKeyScope } from "./middleware/public-api-auth"
import { createApiVersionGate } from "./middleware/api-version"
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
import type { SyncService } from "./features/sync"
import type { SavedMessagesService } from "./features/saved-messages"
import type { SavedSuggestionsService } from "./features/saved-suggestions"
import type { ScheduledMessagesService } from "./features/scheduled-messages"
import type { AgentFollowUpService, PersonaConfigService } from "./features/agents"
import { createDelegationHandlers, type DelegationService } from "./features/delegations"
import { BotAccessRequestService, createBotAccessRequestHandlers } from "./features/bot-access-requests"
import type { DraftsService } from "./features/drafts"
import type { LabelService, LabelAssignmentService, LabelMessageService } from "./features/labels"
import type { PushService } from "./features/push"
import type { S3Config } from "./lib/env"
import type { StorageProvider } from "./lib/storage/s3-client"
import type { CommandRegistry } from "./features/commands"
import type { UserPreferencesService } from "./features/user-preferences"
import type { WorkspaceSettingsService } from "./features/workspace-settings"
import type { SidebarConfigService } from "./features/sidebar-config"
import type { UserE2eKeysService } from "./features/user-e2e-keys"
import type { AvatarService } from "./features/workspaces"
import type { BotChannelService } from "./features/api-keys"
import type { LinkPreviewService } from "./features/link-previews"
import type { GiphyService } from "./features/giphy"
import type { WorkspaceIntegrationService } from "./features/workspace-integrations"
import type { WorkosOrgService } from "@threa/backend-common"
import type { BotApiKeyService } from "./features/public-api"
import type { Pool } from "pg"
import type { PoolMonitor } from "./lib/observability"

interface Dependencies {
  pool: Pool
  io: Server
  poolMonitor: PoolMonitor
  authService: AuthService
  workspaceService: WorkspaceService
  streamService: StreamService
  eventService: EventService
  attachmentService: AttachmentService
  searchService: SearchService
  memoExplorerService: MemoExplorerService
  conversationService: ConversationService
  boundaryExtractionService: BoundaryExtractionService
  userPreferencesService: UserPreferencesService
  workspaceSettingsService: WorkspaceSettingsService
  featureFlagService: FeatureFlagService
  platformAdminService: PlatformAdminService
  sidebarConfigService: SidebarConfigService
  userE2eKeysService: UserE2eKeysService
  invitationService: InvitationService
  activityService: ActivityService
  syncService: SyncService
  savedMessagesService: SavedMessagesService
  savedSuggestionsService: SavedSuggestionsService
  scheduledMessagesService: ScheduledMessagesService
  agentFollowUpService: AgentFollowUpService
  personaConfigService: PersonaConfigService
  delegationService: DelegationService
  draftsService: DraftsService
  labelService: LabelService
  labelAssignmentService: LabelAssignmentService
  labelMessageService: LabelMessageService
  pushService: PushService
  s3Config: S3Config
  commandRegistry: CommandRegistry
  avatarService: AvatarService
  rateLimiterConfig: RateLimiterConfig
  corsAllowedOrigins: string[]
  allowDevAuthRoutes: boolean
  internalApiKey: string | null
  /** Dedicated enclave-channel secret, distinct from internalApiKey (Phase 2.4c, E2EE-22). */
  enclaveInternalApiKey: string | null
  apiKeyService: ApiKeyService
  botChannelService: BotChannelService
  linkPreviewService: LinkPreviewService
  giphyService: GiphyService
  workspaceIntegrationService: WorkspaceIntegrationService
  workspaceAuthzService: WorkspaceAuthzService
  workosOrgService: WorkosOrgService
  userApiKeyService: UserApiKeyService
  voiceTranscriptionService: VoiceTranscriptionService
  enclaveRuntimesService: EnclaveRuntimesService
  enclaveClaimService: EnclaveClaimService
  enclaveClaimNudge: EnclaveClaimWaiter | null
  botApiKeyService: BotApiKeyService
  botRuntimeService: BotRuntimeService
  botRuntimeWriteOps: BotRuntimeWriteOps
  storage: StorageProvider
  ai: AI
  controlPlaneClient: ControlPlaneClient | null
  costService: AICostServiceLike
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
    boundaryExtractionService,
    userPreferencesService,
    workspaceSettingsService,
    featureFlagService,
    platformAdminService,
    sidebarConfigService,
    userE2eKeysService,
    invitationService,
    activityService,
    syncService,
    savedMessagesService,
    savedSuggestionsService,
    scheduledMessagesService,
    agentFollowUpService,
    personaConfigService,
    delegationService,
    draftsService,
    labelService,
    labelAssignmentService,
    labelMessageService,
    pushService,
    s3Config,
    commandRegistry,
    avatarService,
    rateLimiterConfig,
    corsAllowedOrigins,
    allowDevAuthRoutes,
    internalApiKey,
    enclaveInternalApiKey,
    apiKeyService,
    botChannelService,
    linkPreviewService,
    giphyService,
    workspaceIntegrationService,
    workspaceAuthzService,
    workosOrgService,
    userApiKeyService,
    voiceTranscriptionService,
    enclaveRuntimesService,
    enclaveClaimService,
    enclaveClaimNudge,
    botApiKeyService,
    botRuntimeService,
    botRuntimeWriteOps,
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
  const featureFlags = createFeatureFlagHandlers({ featureFlagService })
  const platformAdmin = createPlatformAdminHandlers({ platformAdminService })

  const rateLimits = createRateLimiters(rateLimiterConfig)
  const opsAccess = createOpsAccessMiddleware()

  const authHandlers = createAuthHandlers()
  const avatarUpload = createAvatarUploadMiddleware()
  const commandAvailabilityService = new CommandAvailabilityService({ pool, commandRegistry })
  const boardViewService = new BoardViewService(pool)
  const workspace = createWorkspaceHandlers({
    workspaceService,
    streamService,
    userPreferencesService,
    workspaceSettingsService,
    featureFlagService,
    platformAdminService,
    sidebarConfigService,
    boardViewService,
    invitationService,
    workspaceIntegrationService,
    activityService,
    commandAvailabilityService,
    avatarService,
    labelService,
    labelAssignmentService,
    workosOrgService,
    pool,
  })
  const streamBriefService = new StreamBriefService({ pool })
  const streamBrief = createStreamBriefHandlers({ pool, streamBriefService })
  const stream = createStreamHandlers({
    pool,
    streamService,
    eventService,
    activityService,
    linkPreviewService,
    botRuntimeService,
    commandAvailabilityService,
    workspaceIntegrationService,
  })
  const message = createMessageHandlers({
    pool,
    eventService,
    streamService,
    commandRegistry,
  })
  const attachment = createAttachmentHandlers({ attachmentService, streamService, storage, pool })
  const search = createSearchHandlers({ pool, searchService })
  const memo = createMemoHandlers({ pool, memoExplorerService })
  const emoji = createEmojiHandlers()
  const boardExclusionService = new BoardExclusionService(pool)
  const conversation = createConversationHandlers({
    conversationService,
    boundaryExtractionService,
    boardExclusionService,
    streamService,
  })
  const command = createCommandHandlers({ pool, commandAvailabilityService, botRuntimeService })
  const preferences = createUserPreferencesHandlers({ userPreferencesService })
  const workspaceSettings = createWorkspaceSettingsHandlers({ workspaceSettingsService })
  const sidebarConfig = createSidebarConfigHandlers({ sidebarConfigService })
  const boardView = createBoardViewHandlers({ boardViewService })
  const userE2eKeys = createUserE2eKeysHandlers({ userE2eKeysService })
  const aiUsage = createAIUsageHandlers({ pool })
  const debug = createDebugHandlers({ pool, poolMonitor })
  const invitation = createInvitationHandlers({ invitationService })
  const activity = createActivityHandlers({ activityService })
  const sync = createSyncHandlers({ syncService })
  const savedMessages = createSavedMessagesHandlers({ savedMessagesService })
  const savedSuggestions = createSavedSuggestionsHandlers({ savedSuggestionsService })
  const scheduledMessages = createScheduledMessagesHandlers({ scheduledMessagesService })
  const drafts = createDraftsHandlers({ draftsService })
  const label = createLabelHandlers({ labelService, labelAssignmentService, labelMessageService })
  const persona = createPersonaConfigHandlers({ personaConfigService, avatarService })
  const agentSession = createAgentSessionHandlers({ pool })
  const agentFollowUps = createAgentFollowUpHandlers({ pool, agentFollowUpService })
  const delegations = createDelegationHandlers({ pool, delegationService })
  const botAccessRequestService = new BotAccessRequestService({ pool, streamService })
  const botAccessRequests = createBotAccessRequestHandlers({ botAccessRequestService, streamService })
  const contextBag = createContextBagHandlers({ pool, ai })
  const linkPreview = createLinkPreviewHandlers({ linkPreviewService })
  const giphy = createGiphyHandlers({ giphyService })
  const workspaceIntegration = createWorkspaceIntegrationHandlers({
    workspaceIntegrationService,
    allowedFrontendOrigins: corsAllowedOrigins,
  })

  // Ops endpoints - registered before rate limiter so probes aren't throttled
  app.get("/readyz", opsAccess, debug.readiness)
  app.get("/debug/pool", opsAccess, debug.poolState)
  app.get("/metrics", opsAccess, debug.metrics)

  const enclave = createEnclaveRuntimesHandlers({
    enclaveRuntimesService,
    enclaveClaimService,
    enclaveClaimNudge,
  })

  // Internal API — control-plane → regional backend, protected by shared secret
  if (internalApiKey) {
    const internalAuth = createInternalAuthMiddleware(internalApiKey)
    const internal = createInternalHandlers({ workspaceService, invitationService })

    app.post("/internal/workspaces", internalAuth, internal.createWorkspace)
    app.post("/internal/invitations/:id/accept", internalAuth, internal.acceptInvitation)
    app.post("/internal/invitations/claim-link", internalAuth, invitation.claimLink)
    app.post("/internal/authz/memberships", internalAuth, workspaceAuthz.syncMembership)
    app.post("/internal/feature-flags", internalAuth, featureFlags.sync)
    app.post("/internal/platform-admin", internalAuth, platformAdmin.sync)
  }

  // Enclave runtime registry — gated by the dedicated enclave credential
  // (ENCLAVE_INTERNAL_API_KEY), mounted independently of the control-plane
  // block above so the enclave channel doesn't require INTERNAL_API_KEY. A
  // separate middleware instance means a shared INTERNAL_API_KEY holder
  // (e.g. the bot-runtime) cannot register an EIK and become an SSK wrap
  // recipient (Phase 2.4c, E2EE-22).
  if (enclaveInternalApiKey) {
    const enclaveAuth = createInternalAuthMiddleware(enclaveInternalApiKey)
    app.post("/internal/enclave-runtimes/register-key", enclaveAuth, enclave.registerKey)
    app.post("/internal/enclave-runtimes/heartbeat", enclaveAuth, enclave.heartbeat)
    app.post("/internal/enclave-runtimes/revoke", enclaveAuth, enclave.revoke)
    // The pull transport's turn start (§2.7): instances poll here and claim
    // the oldest turn their EIK can serve. Same enclave-credential gate.
    app.post("/internal/enclave-runtimes/claims", enclaveAuth, enclave.claim)

    // Session callbacks: a live enclave drives a claimed turn over these
    // (liveness refresh + sealed replies on completion). Same enclave-credential gate.
    const enclaveSession = createEnclaveSessionHandlers({
      pool,
      eventService,
      io: deps.io,
      costService: deps.costService,
    })
    app.post("/internal/enclave-runtimes/sessions/:id/heartbeat", enclaveAuth, enclaveSession.heartbeat)
    app.post("/internal/enclave-runtimes/sessions/:id/messages", enclaveAuth, enclaveSession.message)
    app.get("/internal/enclave-runtimes/sessions/:id/messages", enclaveAuth, enclaveSession.pollMessages)
    app.post("/internal/enclave-runtimes/sessions/:id/sealed-name", enclaveAuth, enclaveSession.sealedName)
    app.post("/internal/enclave-runtimes/sessions/:id/sealed-summary", enclaveAuth, enclaveSession.sealedSummary)
    app.post("/internal/enclave-runtimes/sessions/:id/steps/started", enclaveAuth, enclaveSession.stepStarted)
    app.post("/internal/enclave-runtimes/sessions/:id/steps", enclaveAuth, enclaveSession.steps)
    app.post("/internal/enclave-runtimes/sessions/:id/substeps", enclaveAuth, enclaveSession.substep)
    app.post("/internal/enclave-runtimes/sessions/:id/complete", enclaveAuth, enclaveSession.complete)
    app.post("/internal/enclave-runtimes/sessions/:id/fail", enclaveAuth, enclaveSession.fail)
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

  app.get("/api/workspaces/:workspaceId/preferences", ...authed, preferences.get)
  app.patch("/api/workspaces/:workspaceId/preferences", ...authed, preferences.update)

  // Workspace settings (workspace-wide defaults; writes are admin-only)
  app.get("/api/workspaces/:workspaceId/workspace-settings", ...authed, workspaceSettings.get)
  app.patch(
    "/api/workspaces/:workspaceId/workspace-settings",
    ...authed,
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    workspaceSettings.update
  )

  // Personas (config editing; roadmap 7.1/7.2, user-scoped-personas). The list
  // is member-visible. Every lifecycle route below is plain `authed` and
  // authorized per-persona in the service — workspace-admin for built-in and
  // workspace rows, ownership for personal rows (a non-owner 404s, never sees
  // it). The one exception is the built-in override PUT, which is inherently
  // admin-managed and keeps its route-level admin gate.
  app.get("/api/workspaces/:workspaceId/personas", ...authed, persona.list)
  app.get("/api/workspaces/:workspaceId/personas/archived", ...authed, persona.listArchived)
  // Fork a source persona into a new workspace custom (admin) or personal
  // persona (any member); the service enforces the scope rule.
  app.post("/api/workspaces/:workspaceId/personas", ...authed, persona.create)
  app.get("/api/workspaces/:workspaceId/personas/:personaId/config", ...authed, persona.getConfig)
  // Built-in override write stays admin-only at the route layer (built-ins are
  // inherently admin-managed).
  app.put(
    "/api/workspaces/:workspaceId/personas/:personaId/override",
    ...authed,
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    persona.putOverride
  )
  // Full-field update of a custom/personal persona (customs only — built-ins 400).
  app.put("/api/workspaces/:workspaceId/personas/:personaId", ...authed, persona.update)
  app.post("/api/workspaces/:workspaceId/personas/:personaId/archive", ...authed, persona.archive)
  app.post("/api/workspaces/:workspaceId/personas/:personaId/unarchive", ...authed, persona.unarchive)
  // Revision history (roadmap 7.1): list a persona's committed revisions and
  // restore one (re-commits an old patch as a new revision).
  app.get("/api/workspaces/:workspaceId/personas/:personaId/revisions", ...authed, persona.listRevisions)
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/revisions/:revisionId/restore",
    ...authed,
    persona.restoreRevision
  )
  // Draft lifecycle (test-drive substrate, per caller): upsert own draft,
  // discard (archives the bound test stream), and idempotently create-or-return
  // the bound test scratchpad.
  app.put("/api/workspaces/:workspaceId/personas/:personaId/draft", ...authed, persona.putDraft)
  app.delete("/api/workspaces/:workspaceId/personas/:personaId/draft", ...authed, persona.deleteDraft)
  app.post("/api/workspaces/:workspaceId/personas/:personaId/draft/test-stream", ...authed, persona.createTestStream)
  // Custom/personal persona avatar image (customs only — a built-in id 400s in
  // the service). Upload/remove mirror the bot avatar flow; serving is
  // unauthenticated by path (S3 keys carry unguessable ULIDs).
  app.post("/api/workspaces/:workspaceId/personas/:personaId/avatar", ...authed, avatarUpload, persona.uploadAvatar)
  app.delete("/api/workspaces/:workspaceId/personas/:personaId/avatar", ...authed, persona.removeAvatar)
  app.get("/api/workspaces/:workspaceId/personas/:personaId/avatar/:file", persona.serveAvatarFile)
  // Custom/personal persona context attachments (persona-context-attachments):
  // the bytes reach S3 through the shared composer upload transport (reserve →
  // content); this JSON POST binds an already-uploaded attachment to the persona,
  // so there is one frontend upload path (INV-35/37). The list rides the config
  // GET — no separate GET route.
  app.post("/api/workspaces/:workspaceId/personas/:personaId/attachments", ...authed, persona.bindAttachment)
  // Knowledge-by-reference: copy an existing readable workspace file into a fresh
  // persona-owned attachment (copy-on-attach). The service authorizes + copies.
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/attachments/from-existing",
    ...authed,
    persona.attachFromExisting
  )
  app.delete(
    "/api/workspaces/:workspaceId/personas/:personaId/attachments/:attachmentId",
    ...authed,
    persona.deleteAttachment
  )

  // Sidebar config (per-user, per-workspace layout)
  app.get("/api/workspaces/:workspaceId/sidebar-config", ...authed, sidebarConfig.get)
  app.patch("/api/workspaces/:workspaceId/sidebar-config", ...authed, sidebarConfig.update)

  // End-to-end encryption keys (Phase 0)
  // Server stores only ciphertext + public key. Body is the encrypted private
  // bundle (passphrase-wrapped) plus KDF metadata so any device the user logs
  // into can derive the KEK and unwrap locally.
  app.get("/api/workspaces/:workspaceId/users/me/e2e-key", ...authed, userE2eKeys.get)
  app.post("/api/workspaces/:workspaceId/users/me/e2e-key", ...authed, userE2eKeys.set)
  app.delete("/api/workspaces/:workspaceId/users/me/e2e-key", ...authed, userE2eKeys.revoke)

  // Live enclave instance keys. Workspace-member auth gates the read; the
  // EIK set itself is global. The frontend wraps the per-stream SSK to each
  // live EIK so the dispatcher-picked enclave instance can decrypt.
  app.get("/api/workspaces/:workspaceId/enclave/active-keys", ...authed, enclave.listActiveKeys)

  app.get("/api/workspaces/:workspaceId/streams", ...authed, stream.list)
  app.post("/api/workspaces/:workspaceId/streams", ...authed, stream.create)
  app.post("/api/workspaces/:workspaceId/streams/read-all", ...authed, workspace.markAllAsRead)
  app.get("/api/workspaces/:workspaceId/streams/slug-available", ...authed, stream.checkSlugAvailable)
  app.get("/api/workspaces/:workspaceId/streams/:streamId", ...authed, stream.get)
  app.patch("/api/workspaces/:workspaceId/streams/:streamId", ...authed, stream.update)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/bootstrap", ...authed, stream.bootstrap)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/brief", ...authed, streamBrief.get)
  app.put("/api/workspaces/:workspaceId/streams/:streamId/brief", ...authed, streamBrief.put)
  app.patch("/api/workspaces/:workspaceId/streams/:streamId/companion", ...authed, stream.updateCompanionMode)
  app.patch("/api/workspaces/:workspaceId/streams/:streamId/tool-policy", ...authed, stream.updateToolPolicy)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/notification-level", ...authed, stream.setNotificationLevel)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/join", ...authed, stream.join)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/e2e/actors", ...authed, stream.inviteActor)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/e2e/key-wraps", ...authed, stream.getE2eKeyWraps)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/e2e/key-wraps", ...authed, stream.storeE2eKeyWrap)
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/e2e/actor-key-wraps",
    ...authed,
    stream.reviveE2eActorKeyWraps
  )
  app.post("/api/workspaces/:workspaceId/streams/:streamId/e2e/key-generations", ...authed, stream.rollE2eKey)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/read", ...authed, stream.markAsRead)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/unread", ...authed, stream.markUnread)
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

  app.post("/api/workspaces/:workspaceId/search", ...authed, rateLimits.search, search.search)
  app.post("/api/workspaces/:workspaceId/memos/search", ...authed, rateLimits.search, memo.search)
  app.get("/api/workspaces/:workspaceId/memos/:memoId", ...authed, memo.getById)
  app.patch("/api/workspaces/:workspaceId/memos/:memoId", ...authed, memo.update)
  app.post("/api/workspaces/:workspaceId/memos/:memoId/archive", ...authed, memo.archive)
  app.post("/api/workspaces/:workspaceId/memos/:memoId/unarchive", ...authed, memo.unarchive)
  app.delete("/api/workspaces/:workspaceId/memos/:memoId", ...authed, memo.delete)

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
  // Reserved background uploads: id first, bytes later (send-while-uploading).
  app.post("/api/workspaces/:workspaceId/attachments/reservations", ...authed, rateLimits.upload, attachment.reserve)
  app.post(
    "/api/workspaces/:workspaceId/attachments/:attachmentId/content",
    ...authed,
    rateLimits.upload,
    // Must run before `upload`: multer-s3 streams bytes to the reserved key,
    // so reservation ownership/state has to be checked before any byte lands.
    attachment.validateReservedUpload,
    upload,
    attachment.completeReservedContent
  )
  app.post(
    "/api/workspaces/:workspaceId/attachments/:attachmentId/upload-failure",
    ...authed,
    attachment.reportUploadFailure
  )
  app.post("/api/workspaces/:workspaceId/attachments/search", ...authed, rateLimits.search, attachment.search)
  app.get("/api/workspaces/:workspaceId/attachments/:attachmentId/url", ...authed, attachment.getDownloadUrl)
  app.get("/api/workspaces/:workspaceId/attachments/:attachmentId/content", ...authed, attachment.getContent)
  app.get("/api/workspaces/:workspaceId/attachments/:attachmentId/extraction", ...authed, attachment.getExtraction)
  app.delete("/api/workspaces/:workspaceId/attachments/:attachmentId", ...authed, attachment.delete)

  app.get("/api/workspaces/:workspaceId/conversations", ...authed, conversation.listByWorkspace)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/conversations", ...authed, conversation.listByStream)
  app.get("/api/workspaces/:workspaceId/conversations/:conversationId", ...authed, conversation.getById)
  app.get("/api/workspaces/:workspaceId/conversations/:conversationId/messages", ...authed, conversation.getMessages)
  app.get(
    "/api/workspaces/:workspaceId/conversations/:conversationId/board-messages",
    ...authed,
    conversation.getBoardMessages
  )
  app.get("/api/workspaces/:workspaceId/conversations/:conversationId/board-post", ...authed, conversation.getBoardPost)
  app.patch("/api/workspaces/:workspaceId/conversations/:conversationId", ...authed, conversation.updateConversation)
  app.get("/api/workspaces/:workspaceId/board/exclusions", ...authed, conversation.getBoardExclusions)
  app.get("/api/workspaces/:workspaceId/board/views", ...authed, boardView.list)
  app.post("/api/workspaces/:workspaceId/board/views", ...authed, boardView.create)
  app.patch("/api/workspaces/:workspaceId/board/views/:boardViewId", ...authed, boardView.update)
  app.delete("/api/workspaces/:workspaceId/board/views/:boardViewId", ...authed, boardView.remove)
  app.post("/api/workspaces/:workspaceId/conversations/:conversationId/hide", ...authed, conversation.hideConversation)
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/unhide",
    ...authed,
    conversation.unhideConversation
  )
  app.post("/api/workspaces/:workspaceId/streams/:streamId/board-mute", ...authed, conversation.muteStream)
  app.post("/api/workspaces/:workspaceId/streams/:streamId/board-unmute", ...authed, conversation.unmuteStream)
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/reassign",
    ...authed,
    conversation.reassignMessage
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/split-thread",
    ...authed,
    conversation.splitThread
  )
  app.post("/api/workspaces/:workspaceId/conversations/reassign-messages", ...authed, conversation.reassignMessages)
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/split-proposal",
    ...authed,
    conversation.proposeSplit
  )
  app.post("/api/workspaces/:workspaceId/conversations/:conversationId/split", ...authed, conversation.applySplit)
  app.post("/api/workspaces/:workspaceId/conversations/:conversationId/read", ...authed, conversation.markRead)
  app.post("/api/workspaces/:workspaceId/conversations/:conversationId/unread", ...authed, conversation.markUnread)

  app.post("/api/workspaces/:workspaceId/commands/dispatch", ...authed, rateLimits.commandDispatch, command.dispatch)
  app.get("/api/workspaces/:workspaceId/commands", ...authed, command.list)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/commands", ...authed, command.listForStream)

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

  app.patch("/api/workspaces/:workspaceId/profile", ...authed, workspace.updateProfile)
  app.put("/api/workspaces/:workspaceId/status", ...authed, workspace.setStatus)
  app.delete("/api/workspaces/:workspaceId/status", ...authed, workspace.clearStatus)
  app.put("/api/workspaces/:workspaceId/notifications/pause", ...authed, workspace.pauseNotifications)
  app.delete("/api/workspaces/:workspaceId/notifications/pause", ...authed, workspace.resumeNotifications)
  app.post("/api/workspaces/:workspaceId/profile/avatar", ...authed, avatarUpload, workspace.uploadAvatar)
  app.delete("/api/workspaces/:workspaceId/profile/avatar", ...authed, workspace.removeAvatar)

  // Avatar file serving (unauthenticated — S3 keys contain unguessable ULIDs)
  app.get("/api/workspaces/:workspaceId/users/:userId/avatar/:file", workspace.serveAvatarFile)

  app.get("/api/workspaces/:workspaceId/ai-usage", ...authed, aiUsage.getUsage)
  app.get("/api/workspaces/:workspaceId/ai-usage/recent", ...authed, aiUsage.getRecentUsage)
  app.get("/api/workspaces/:workspaceId/ai-budget", ...authed, aiUsage.getBudget)
  app.put(
    "/api/workspaces/:workspaceId/ai-budget",
    ...authed,
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    aiUsage.updateBudget
  )

  // Sync-log catch-up (sync engine v2 step 1): ordered entries after a cursor,
  // ACL-filtered to the requester's delivery groups.
  app.get("/api/workspaces/:workspaceId/sync", ...authed, sync.catchUp)

  app.get("/api/workspaces/:workspaceId/activity", ...authed, activity.list)
  app.post("/api/workspaces/:workspaceId/activity/read", ...authed, activity.markAllAsRead)
  app.post("/api/workspaces/:workspaceId/activity/:id/read", ...authed, activity.markOneAsRead)

  app.get("/api/workspaces/:workspaceId/saved", ...authed, savedMessages.list)
  app.post("/api/workspaces/:workspaceId/saved", ...authed, savedMessages.create)
  app.patch("/api/workspaces/:workspaceId/saved/:savedId", ...authed, savedMessages.update)
  app.delete("/api/workspaces/:workspaceId/saved/:savedId", ...authed, savedMessages.delete)

  // Saved suggestions (passively collected to-do candidates)
  app.get("/api/workspaces/:workspaceId/saved/suggestions", ...authed, savedSuggestions.list)
  app.post("/api/workspaces/:workspaceId/saved/suggestions/:suggestionId/accept", ...authed, savedSuggestions.accept)
  app.post("/api/workspaces/:workspaceId/saved/suggestions/:suggestionId/dismiss", ...authed, savedSuggestions.dismiss)

  app.get("/api/workspaces/:workspaceId/labels", ...authed, label.list)
  app.get("/api/workspaces/:workspaceId/labels/:labelId/messages", ...authed, label.listMessages)
  app.post("/api/workspaces/:workspaceId/labels", ...authed, label.create)
  app.patch("/api/workspaces/:workspaceId/labels/:labelId", ...authed, label.update)
  app.delete("/api/workspaces/:workspaceId/labels/:labelId", ...authed, label.delete)
  app.post("/api/workspaces/:workspaceId/labels/:labelId/assignments", ...authed, label.assign)
  app.delete("/api/workspaces/:workspaceId/labels/:labelId/assignments", ...authed, label.unassign)

  app.get("/api/workspaces/:workspaceId/scheduled", ...authed, scheduledMessages.list)
  app.post("/api/workspaces/:workspaceId/scheduled", ...authed, scheduledMessages.create)
  app.get("/api/workspaces/:workspaceId/scheduled/:id", ...authed, scheduledMessages.getById)
  app.patch("/api/workspaces/:workspaceId/scheduled/:id", ...authed, scheduledMessages.update)
  app.delete("/api/workspaces/:workspaceId/scheduled/:id", ...authed, scheduledMessages.delete)
  app.post("/api/workspaces/:workspaceId/scheduled/:id/lock", ...authed, scheduledMessages.lockForEdit)
  app.post("/api/workspaces/:workspaceId/scheduled/:id/unlock", ...authed, scheduledMessages.releaseEditLock)
  app.post("/api/workspaces/:workspaceId/scheduled/:id/send-now", ...authed, scheduledMessages.sendNow)

  // Agent follow-ups — a stream member can cancel a follow-up they can see from
  // its timeline card (roadmap 1.3). Scheduling/listing stay agent-only tools.
  app.post("/api/workspaces/:workspaceId/agent-follow-ups/:id/cancel", ...authed, agentFollowUps.cancel)

  app.get("/api/workspaces/:workspaceId/delegations", ...authed, delegations.list)
  app.get("/api/workspaces/:workspaceId/delegations/:id", ...authed, delegations.get)
  app.post("/api/workspaces/:workspaceId/delegations/:id/cancel", ...authed, delegations.cancel)
  app.post("/api/workspaces/:workspaceId/delegations/:id/done", ...authed, delegations.markDone)

  // Bot access requests — a stream member approves or denies a bot's request to
  // access the stream so it can claim a delegation (F3). Approve applies the
  // grant; both are member-gated (stricter than delegation cancel).
  app.post("/api/workspaces/:workspaceId/bot-access-requests/:id/approve", ...authed, botAccessRequests.approve)
  app.post("/api/workspaces/:workspaceId/bot-access-requests/:id/deny", ...authed, botAccessRequests.deny)

  // Drafts — centralized, local-first composer payloads that roam across the
  // author's devices. Private to the author; never timeline-broadcast.
  app.get("/api/workspaces/:workspaceId/drafts", ...authed, drafts.list)
  app.put("/api/workspaces/:workspaceId/drafts/:id", ...authed, drafts.upsert)
  app.post("/api/workspaces/:workspaceId/drafts/:id/resolve", ...authed, drafts.resolve)
  app.delete("/api/workspaces/:workspaceId/drafts/:id", ...authed, drafts.delete)

  const push = createPushHandlers({ pushService })
  app.get("/api/workspaces/:workspaceId/push/vapid-key", ...authed, push.getVapidKey)
  app.post("/api/workspaces/:workspaceId/push/subscribe", ...authed, push.subscribe)
  app.post("/api/workspaces/:workspaceId/push/unsubscribe", ...authed, push.unsubscribe)
  app.post("/api/workspaces/:workspaceId/push/test", ...authed, rateLimits.pushTest, push.sendTest)
  // Non-workspace-scoped: cleans up all push subscriptions for a browser endpoint (used on logout)
  app.post("/api/push/cleanup-endpoint", auth, push.cleanupEndpoint)

  app.get("/api/workspaces/:workspaceId/agent-sessions/:sessionId", ...authed, agentSession.getSession)

  app.post("/api/workspaces/:workspaceId/context-bag/precompute", ...authed, contextBag.precompute)
  app.get("/api/workspaces/:workspaceId/streams/:streamId/context-bag", ...authed, contextBag.getStreamBag)

  app.get("/api/workspaces/:workspaceId/messages/:messageId/link-previews", ...authed, linkPreview.getForMessage)
  app.post(
    "/api/workspaces/:workspaceId/messages/:messageId/link-previews/:linkPreviewId/dismiss",
    ...authed,
    linkPreview.dismiss
  )
  app.get("/api/workspaces/:workspaceId/link-previews/resolve", ...authed, linkPreview.resolveInAppLinkByUrl)
  app.get("/api/workspaces/:workspaceId/link-previews/:linkPreviewId/resolve", ...authed, linkPreview.resolveInAppLink)

  // Giphy picker — backend proxy keeps the API key server-side. `config` reports
  // whether the feature is enabled; the chosen GIF is embedded by its CDN URL
  // (no byte download), so there's no file-proxy endpoint.
  app.get("/api/workspaces/:workspaceId/giphy/config", ...authed, giphy.getConfig)
  app.get("/api/workspaces/:workspaceId/giphy/search", ...authed, rateLimits.search, giphy.search)
  app.get("/api/workspaces/:workspaceId/giphy/trending", ...authed, rateLimits.search, giphy.trending)

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
  app.patch("/api/workspaces/:workspaceId/user-api-keys/:keyId", ...authed, userApiKeys.update)
  app.post("/api/workspaces/:workspaceId/user-api-keys/:keyId/revoke", ...authed, userApiKeys.revoke)

  // Voice dictation: HTTP creates/aborts the session; the dedicated /voice
  // socket namespace owns the live audio relay and authoritative stop.
  const voice = createVoiceTranscriptionHandlers({ voiceTranscriptionService })
  app.post("/api/workspaces/:workspaceId/voice/sessions", ...authed, voice.createSession)
  app.delete("/api/workspaces/:workspaceId/voice/sessions/:sessionId", ...authed, voice.abortSession)

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
  app.patch(
    "/api/workspaces/:workspaceId/bots/:botId/keys/:keyId",
    ...authed,
    requireBotManagement(),
    botHandlers.updateKey
  )
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
  const publicApi = createPublicApiHandlers({
    searchService,
    memoExplorerService,
    attachmentService,
    botChannelService,
    botRuntimeService,
    botRuntimeWriteOps,
    streamService,
    eventService,
    conversationService,
    labelService,
    labelAssignmentService,
    pool,
    io: deps.io,
  })
  const delegationPublicApi = createDelegationPublicApiHandlers({
    pool,
    delegationService,
    eventService,
    streamService,
    botChannelService,
    botAccessRequestService,
  })
  const publicMiddleware = [rateLimits.publicApiWorkspace, rateLimits.publicApiKey, publicAuth] as const

  const publicHandlers: Record<OperationId, RequestHandler | RequestHandler[]> = {
    searchMessages: publicApi.searchMessages,
    searchMemos: publicApi.searchMemos,
    getMemo: publicApi.getMemo,
    uploadAttachment: [rateLimits.upload, upload, publicApi.uploadAttachment],
    searchAttachments: publicApi.searchAttachments,
    getAttachment: publicApi.getAttachment,
    getAttachmentDownloadUrl: publicApi.getAttachmentDownloadUrl,
    upsertBotRuntimePresence: publicApi.upsertBotRuntimePresence,
    createBotRuntimeSession: publicApi.createBotRuntimeSession,
    getBotOwnerE2eKey: publicApi.getBotOwnerE2eKey,
    provisionStreamE2eKeyWraps: publicApi.provisionStreamE2eKeyWraps,
    renameBotRuntimeSession: publicApi.renameBotRuntimeSession,
    rebindBotRuntimeSession: publicApi.rebindBotRuntimeSession,
    claimBotInvocation: publicApi.claimBotInvocation,
    renewBotInvocationClaim: publicApi.renewBotInvocationClaim,
    recordBotInvocationStep: publicApi.recordBotInvocationStep,
    startBotInvocationSealedStep: publicApi.startBotInvocationSealedStep,
    recordBotInvocationSealedStep: publicApi.recordBotInvocationSealedStep,
    sendBotInvocationSealedMessage: publicApi.sendBotInvocationSealedMessage,
    completeBotInvocationSealed: publicApi.completeBotInvocationSealed,
    completeBotInvocation: publicApi.completeBotInvocation,
    failBotInvocation: publicApi.failBotInvocation,
    listDelegations: delegationPublicApi.listDelegations,
    claimDelegation: delegationPublicApi.claimDelegation,
    heartbeatDelegation: delegationPublicApi.heartbeatDelegation,
    reportDelegationStatus: delegationPublicApi.reportDelegationStatus,
    completeDelegation: delegationPublicApi.completeDelegation,
    failDelegation: delegationPublicApi.failDelegation,
    requestDelegationAccess: delegationPublicApi.requestDelegationAccess,
    listStreams: publicApi.listStreams,
    getStream: publicApi.getStream,
    updateStream: publicApi.updateStream,
    listMembers: publicApi.listMembers,
    listMessages: publicApi.listMessages,
    sendMessage: publicApi.sendMessage,
    listConversations: publicApi.listConversations,
    getConversation: publicApi.getConversation,
    listConversationMessages: publicApi.listConversationMessages,
    findMessagesByMetadata: publicApi.findMessagesByMetadata,
    updateMessage: publicApi.updateMessage,
    deleteMessage: publicApi.deleteMessage,
    listUsers: publicApi.listUsers,
    listLabels: publicApi.listLabels,
    createLabel: publicApi.createLabel,
    assignLabel: publicApi.assignLabel,
    unassignLabel: publicApi.unassignLabel,
    updateLabel: publicApi.updateLabel,
    deleteLabel: publicApi.deleteLabel,
    getMe: publicApi.getMe,
    listMyBots: publicApi.listMyBots,
  }

  assertHandlerParity(Object.keys(publicHandlers))

  for (const route of PUBLIC_API_ROUTES) {
    const handler = publicHandlers[route.operationId]
    const scopeGuard = route.scopes.length > 0 ? [requireApiKeyScope(...route.scopes)] : []
    app[route.method](
      toExpressPath(route.path),
      ...publicMiddleware,
      createApiVersionGate(route.operationId),
      ...scopeGuard,
      ...(Array.isArray(handler) ? handler : [handler])
    )
  }

  app.use(errorHandler)
}
