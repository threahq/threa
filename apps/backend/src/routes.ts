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
import {
  createStreamHandlers,
  createStreamBriefHandlers,
  StreamBriefService,
  StreamReadService,
} from "./features/streams"
import { createMessageHandlers, SteeredMessageService } from "./features/messaging"
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
import { createGithubWebhookHandlers } from "./features/github-webhooks"
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
import { createCallHandlers, type CallService } from "./features/calls"
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
  type SessionCookies,
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
import { createSubagentHandlers, type SubagentService } from "./features/subagents"
import { createAgentOutcomeHandlers, createAgentOutcomeService } from "./features/agent-outcomes"
import { createStreamContextHandlers, createStreamContextService } from "./features/stream-context"
import { BotAccessRequestService, createBotAccessRequestHandlers } from "./features/bot-access-requests"
import type { DraftsService } from "./features/drafts"
import type { LabelService, LabelAssignmentService, LabelMessageService } from "./features/labels"
import type { PushService } from "./features/push"
import { createPerfDiagnosticsHandlers, type PerfDiagnosticsService } from "./features/perf-diagnostics"
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
import type { QueueManager } from "./lib/queue"
import type { GiphyService } from "./features/giphy"
import type { WorkspaceIntegrationService } from "./features/workspace-integrations"
import type { WorkosOrgService } from "@threa/backend-common"
import type { BotApiKeyService } from "./features/public-api"
import {
  createAuditMiddleware,
  assertAuditCoverage,
  publicApiOperation,
  type AccessLogService,
} from "./features/access-log"
import type { Pool } from "pg"
import type { PoolMonitor } from "./lib/observability"

interface Dependencies {
  pool: Pool
  io: Server
  poolMonitor: PoolMonitor
  authService: AuthService
  sessionCookies: SessionCookies
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
  subagentService: SubagentService
  draftsService: DraftsService
  labelService: LabelService
  labelAssignmentService: LabelAssignmentService
  labelMessageService: LabelMessageService
  pushService: PushService
  perfDiagnosticsService: PerfDiagnosticsService
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
  jobQueue: QueueManager
  giphyService: GiphyService
  workspaceIntegrationService: WorkspaceIntegrationService
  workspaceAuthzService: WorkspaceAuthzService
  workosOrgService: WorkosOrgService
  userApiKeyService: UserApiKeyService
  voiceTranscriptionService: VoiceTranscriptionService
  callService: CallService
  /** True when the CF Realtime media plane is configured; when false, calls surfaces 503. */
  callsCloudflareEnabled: boolean
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
  accessLogService: AccessLogService
}

export function registerRoutes(app: Express, deps: Dependencies) {
  const {
    pool,
    poolMonitor,
    authService,
    sessionCookies,
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
    subagentService,
    draftsService,
    labelService,
    labelAssignmentService,
    labelMessageService,
    pushService,
    perfDiagnosticsService,
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
    jobQueue,
    giphyService,
    workspaceIntegrationService,
    workspaceAuthzService,
    workosOrgService,
    userApiKeyService,
    voiceTranscriptionService,
    callService,
    callsCloudflareEnabled,
    enclaveRuntimesService,
    enclaveClaimService,
    enclaveClaimNudge,
    botApiKeyService,
    botRuntimeService,
    botRuntimeWriteOps,
    storage,
    ai,
    controlPlaneClient,
    accessLogService,
  } = deps

  const audit = createAuditMiddleware(accessLogService)
  const auth = createAuthMiddleware({ authService, sessionCookies })
  const workspaceUser = createWorkspaceUserMiddleware({ pool, workspaceService, controlPlaneClient })
  const upload = createUploadMiddleware({ s3Config })
  // Express natively chains handlers - spread array at usage sites
  // audit.boundary sits between auth and workspaceUser: workspaceUser denies
  // with res.status().json() without next(), so the route-level audit(...)
  // never runs for cross-workspace probes — the boundary backstop records them.
  const authed: RequestHandler[] = [auth, audit.boundary, workspaceUser]

  const requireWorkspacePermission = createRequireWorkspacePermission()
  const workspaceAuthz = createWorkspaceAuthzHandlers({ workspaceAuthzService })
  const featureFlags = createFeatureFlagHandlers({ featureFlagService })
  const platformAdmin = createPlatformAdminHandlers({ platformAdminService })

  const rateLimits = createRateLimiters(rateLimiterConfig)
  const opsAccess = createOpsAccessMiddleware()

  const authHandlers = createAuthHandlers()
  const avatarUpload = createAvatarUploadMiddleware()
  const commandAvailabilityService = new CommandAvailabilityService({ pool, commandRegistry })
  const steeredMessageService = new SteeredMessageService({ commandAvailabilityService, botRuntimeService })
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
    callService,
    pool,
  })
  const streamBriefService = new StreamBriefService({ pool })
  const streamBrief = createStreamBriefHandlers({ pool, streamBriefService })
  const streamReadService = new StreamReadService({ pool, streamService, activityService })
  const stream = createStreamHandlers({
    pool,
    streamService,
    streamReadService,
    eventService,
    activityService,
    linkPreviewService,
    botRuntimeService,
    commandAvailabilityService,
    workspaceIntegrationService,
    callService,
  })
  const message = createMessageHandlers({
    pool,
    eventService,
    streamService,
    commandRegistry,
    steeredMessageService,
  })
  const attachment = createAttachmentHandlers({ attachmentService, streamService, storage, pool })
  const search = createSearchHandlers({ pool, searchService, featureFlagService })
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
  const subagents = createSubagentHandlers({ pool, subagentService })
  const agentOutcomes = createAgentOutcomeHandlers({
    agentOutcomeService: createAgentOutcomeService({ pool }),
  })
  const streamContext = createStreamContextHandlers({
    streamContextService: createStreamContextService({ pool }),
  })
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
    const githubWebhook = createGithubWebhookHandlers({ jobQueue })

    app.post("/internal/workspaces", internalAuth, internal.createWorkspace)
    app.post("/internal/invitations/:id/accept", internalAuth, internal.acceptInvitation)
    app.post("/internal/invitations/claim-link", internalAuth, invitation.claimLink)
    app.post("/internal/authz/memberships", internalAuth, workspaceAuthz.syncMembership)
    app.post("/internal/feature-flags", internalAuth, featureFlags.sync)
    app.post("/internal/platform-admin", internalAuth, platformAdmin.sync)
    app.post("/internal/github/webhook-events", internalAuth, githubWebhook.ingest)
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
    app.post("/internal/enclave-runtimes/sessions/:id/naming-decision", enclaveAuth, enclaveSession.namingDecision)
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
      sessionCookies,
      workspaceService,
      streamService,
      invitationService,
    })

    const devAudit = audit.none("dev-only stub auth route")
    app.get("/test-auth-login", authStub.getLoginPage)
    app.post("/test-auth-login", authStub.handleLogin)
    app.post("/api/dev/login", devAudit, authStub.handleDevLogin)
    app.post("/api/dev/workspaces/:workspaceId/join", auth, devAudit, authStub.handleWorkspaceJoin)
    app.post(
      "/api/dev/workspaces/:workspaceId/streams/:streamId/join",
      auth,
      workspaceUser,
      devAudit,
      authStub.handleStreamJoin
    )
  }

  app.get("/api/auth/me", auth, audit("auth.me", "read"), authHandlers.me)

  // Workspace list/create are also on the control-plane. The router proxies
  // GET/POST /api/workspaces to the control-plane in production. These stay
  // here for direct backend testing and single-region dev without the router.
  app.get("/api/workspaces", auth, audit("workspace.list", "read"), workspace.list)
  app.post("/api/workspaces", auth, audit("workspace.create", "write"), workspace.create)
  app.get("/api/workspaces/:workspaceId", ...authed, audit("workspace.get", "read"), workspace.get)
  app.get(
    "/api/workspaces/:workspaceId/bootstrap",
    ...authed,
    audit("workspace.bootstrap", "read"),
    workspace.bootstrap
  )
  app.get("/api/workspaces/:workspaceId/users", ...authed, audit("workspace.list_users", "read"), workspace.getUsers)
  app.get("/api/workspaces/:workspaceId/emojis", ...authed, audit("emoji.list", "read"), emoji.list)

  app.get("/api/workspaces/:workspaceId/preferences", ...authed, audit("preferences.get", "read"), preferences.get)
  app.patch(
    "/api/workspaces/:workspaceId/preferences",
    ...authed,
    audit("preferences.update", "write"),
    preferences.update
  )

  // Workspace settings (workspace-wide defaults; writes are admin-only)
  app.get(
    "/api/workspaces/:workspaceId/workspace-settings",
    ...authed,
    audit("workspace_settings.get", "read"),
    workspaceSettings.get
  )
  app.patch(
    "/api/workspaces/:workspaceId/workspace-settings",
    ...authed,
    audit("workspace_settings.update", "write"),
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    workspaceSettings.update
  )

  // Personas (config editing; roadmap 7.1/7.2, user-scoped-personas). The list
  // is member-visible. Every lifecycle route below is plain `authed` and
  // authorized per-persona in the service — workspace-admin for built-in and
  // workspace rows, ownership for personal rows (a non-owner 404s, never sees
  // it). The one exception is the built-in override PUT, which is inherently
  // admin-managed and keeps its route-level admin gate.
  app.get("/api/workspaces/:workspaceId/personas", ...authed, audit("personas.list", "read"), persona.list)
  app.get(
    "/api/workspaces/:workspaceId/personas/archived",
    ...authed,
    audit("personas.list_archived", "read"),
    persona.listArchived
  )
  // Fork a source persona into a new workspace custom (admin) or personal
  // persona (any member); the service enforces the scope rule.
  app.post("/api/workspaces/:workspaceId/personas", ...authed, audit("personas.create", "write"), persona.create)
  app.get(
    "/api/workspaces/:workspaceId/personas/:personaId/config",
    ...authed,
    audit("personas.get_config", "read"),
    persona.getConfig
  )
  // Built-in override write stays admin-only at the route layer (built-ins are
  // inherently admin-managed).
  app.put(
    "/api/workspaces/:workspaceId/personas/:personaId/override",
    ...authed,
    audit("personas.put_override", "write"),
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    persona.putOverride
  )
  // Full-field update of a custom/personal persona (customs only — built-ins 400).
  app.put(
    "/api/workspaces/:workspaceId/personas/:personaId",
    ...authed,
    audit("personas.update", "write"),
    persona.update
  )
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/archive",
    ...authed,
    audit("personas.archive", "write"),
    persona.archive
  )
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/unarchive",
    ...authed,
    audit("personas.unarchive", "write"),
    persona.unarchive
  )
  // Revision history (roadmap 7.1): list a persona's committed revisions and
  // restore one (re-commits an old patch as a new revision).
  app.get(
    "/api/workspaces/:workspaceId/personas/:personaId/revisions",
    ...authed,
    audit("personas.list_revisions", "read"),
    persona.listRevisions
  )
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/revisions/:revisionId/restore",
    ...authed,
    audit("personas.restore_revision", "write"),
    persona.restoreRevision
  )
  // Draft lifecycle (test-drive substrate, per caller): upsert own draft,
  // discard (archives the bound test stream), and idempotently create-or-return
  // the bound test scratchpad.
  app.put(
    "/api/workspaces/:workspaceId/personas/:personaId/draft",
    ...authed,
    audit("personas.put_draft", "write"),
    persona.putDraft
  )
  app.delete(
    "/api/workspaces/:workspaceId/personas/:personaId/draft",
    ...authed,
    audit("personas.delete_draft", "write"),
    persona.deleteDraft
  )
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/draft/test-stream",
    ...authed,
    audit("personas.create_test_stream", "write"),
    persona.createTestStream
  )
  // Custom/personal persona avatar image (customs only — a built-in id 400s in
  // the service). Upload/remove mirror the bot avatar flow; serving is
  // unauthenticated by path (S3 keys carry unguessable ULIDs).
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/avatar",
    ...authed,
    audit("personas.upload_avatar", "write"),
    avatarUpload,
    persona.uploadAvatar
  )
  app.delete(
    "/api/workspaces/:workspaceId/personas/:personaId/avatar",
    ...authed,
    audit("personas.remove_avatar", "write"),
    persona.removeAvatar
  )
  app.get(
    "/api/workspaces/:workspaceId/personas/:personaId/avatar/:file",
    audit.none("unauthenticated avatar serve; S3 keys carry unguessable ULIDs"),
    persona.serveAvatarFile
  )
  // Custom/personal persona context attachments (persona-context-attachments):
  // the bytes reach S3 through the shared composer upload transport (reserve →
  // content); this JSON POST binds an already-uploaded attachment to the persona,
  // so there is one frontend upload path (INV-35/37). The list rides the config
  // GET — no separate GET route.
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/attachments",
    ...authed,
    audit("personas.bind_attachment", "write"),
    persona.bindAttachment
  )
  // Knowledge-by-reference: copy an existing readable workspace file into a fresh
  // persona-owned attachment (copy-on-attach). The service authorizes + copies.
  app.post(
    "/api/workspaces/:workspaceId/personas/:personaId/attachments/from-existing",
    ...authed,
    audit("personas.attach_from_existing", "write"),
    persona.attachFromExisting
  )
  app.delete(
    "/api/workspaces/:workspaceId/personas/:personaId/attachments/:attachmentId",
    ...authed,
    audit("personas.delete_attachment", "write"),
    persona.deleteAttachment
  )

  // Sidebar config (per-user, per-workspace layout)
  app.get(
    "/api/workspaces/:workspaceId/sidebar-config",
    ...authed,
    audit("sidebar_config.get", "read"),
    sidebarConfig.get
  )
  app.patch(
    "/api/workspaces/:workspaceId/sidebar-config",
    ...authed,
    audit("sidebar_config.update", "write"),
    sidebarConfig.update
  )

  // End-to-end encryption keys (Phase 0)
  // Server stores only ciphertext + public key. Body is the encrypted private
  // bundle (passphrase-wrapped) plus KDF metadata so any device the user logs
  // into can derive the KEK and unwrap locally.
  app.get(
    "/api/workspaces/:workspaceId/users/me/e2e-key",
    ...authed,
    audit("user_e2e_keys.get", "read"),
    userE2eKeys.get
  )
  app.post(
    "/api/workspaces/:workspaceId/users/me/e2e-key",
    ...authed,
    audit("user_e2e_keys.set", "write"),
    userE2eKeys.set
  )
  app.delete(
    "/api/workspaces/:workspaceId/users/me/e2e-key",
    ...authed,
    audit("user_e2e_keys.revoke", "write"),
    userE2eKeys.revoke
  )

  // Live enclave instance keys. Workspace-member auth gates the read; the
  // EIK set itself is global. The frontend wraps the per-stream SSK to each
  // live EIK so the dispatcher-picked enclave instance can decrypt.
  app.get(
    "/api/workspaces/:workspaceId/enclave/active-keys",
    ...authed,
    audit("enclave.list_active_keys", "read"),
    enclave.listActiveKeys
  )

  app.get("/api/workspaces/:workspaceId/streams", ...authed, audit("streams.list", "read"), stream.list)
  app.post("/api/workspaces/:workspaceId/streams", ...authed, audit("streams.create", "write"), stream.create)
  app.post(
    "/api/workspaces/:workspaceId/streams/read-all",
    ...authed,
    audit("streams.read_all", "write"),
    workspace.markAllAsRead
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/slug-available",
    ...authed,
    audit("streams.slug_available", "read"),
    stream.checkSlugAvailable
  )
  app.get("/api/workspaces/:workspaceId/streams/:streamId", ...authed, audit("streams.get", "read"), stream.get)
  app.patch(
    "/api/workspaces/:workspaceId/streams/:streamId",
    ...authed,
    audit("streams.update", "write"),
    stream.update
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/regenerate-title",
    ...authed,
    audit("streams.regenerate_title", "write"),
    stream.regenerateTitle
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/context",
    ...authed,
    audit("stream_context.list", "read"),
    streamContext.list
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/context/occurrences",
    ...authed,
    audit("stream_context.occurrences", "read"),
    streamContext.listOccurrences
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/bootstrap",
    ...authed,
    audit("streams.bootstrap", "read"),
    stream.bootstrap
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/brief",
    ...authed,
    audit("streams.get_brief", "read"),
    streamBrief.get
  )
  app.put(
    "/api/workspaces/:workspaceId/streams/:streamId/brief",
    ...authed,
    audit("streams.put_brief", "write"),
    streamBrief.put
  )
  app.patch(
    "/api/workspaces/:workspaceId/streams/:streamId/companion",
    ...authed,
    audit("streams.update_companion", "write"),
    stream.updateCompanionMode
  )
  app.patch(
    "/api/workspaces/:workspaceId/streams/:streamId/tool-policy",
    ...authed,
    audit("streams.update_tool_policy", "write"),
    stream.updateToolPolicy
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/notification-level",
    ...authed,
    audit("streams.set_notification_level", "write"),
    stream.setNotificationLevel
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/join",
    ...authed,
    audit("streams.join", "write"),
    stream.join
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/e2e/actors",
    ...authed,
    audit("streams.invite_actor", "write"),
    stream.inviteActor
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/e2e/key-wraps",
    ...authed,
    audit("streams.get_e2e_key_wraps", "read"),
    stream.getE2eKeyWraps
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/e2e/key-wraps",
    ...authed,
    audit("streams.store_e2e_key_wrap", "write"),
    stream.storeE2eKeyWrap
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/e2e/actor-key-wraps",
    ...authed,
    audit("streams.revive_e2e_actor_key_wraps", "write"),
    stream.reviveE2eActorKeyWraps
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/e2e/key-generations",
    ...authed,
    audit("streams.roll_e2e_key", "write"),
    stream.rollE2eKey
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/read",
    ...authed,
    audit("streams.mark_read", "write"),
    stream.markAsRead
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/unread",
    ...authed,
    audit("streams.mark_unread", "write"),
    stream.markUnread
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/archive",
    ...authed,
    audit("streams.archive", "write"),
    stream.archive
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/unarchive",
    ...authed,
    audit("streams.unarchive", "write"),
    stream.unarchive
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/members",
    ...authed,
    audit("streams.add_member", "write"),
    stream.addMember
  )
  app.delete(
    "/api/workspaces/:workspaceId/streams/:streamId/members/:memberId",
    ...authed,
    audit("streams.remove_member", "write"),
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE),
    stream.removeMember
  )

  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/events",
    ...authed,
    audit("streams.history", "read"),
    stream.listEvents
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/events/around",
    ...authed,
    audit("streams.around", "read"),
    stream.listEventsAround
  )

  app.post(
    "/api/workspaces/:workspaceId/search",
    ...authed,
    audit("search.messages", "read"),
    rateLimits.search,
    search.search
  )
  app.post(
    "/api/workspaces/:workspaceId/memos/search",
    ...authed,
    audit("search.memos", "read"),
    rateLimits.search,
    memo.search
  )
  app.get("/api/workspaces/:workspaceId/memos/:memoId", ...authed, audit("memos.read", "read"), memo.getById)
  app.patch("/api/workspaces/:workspaceId/memos/:memoId", ...authed, audit("memos.update", "write"), memo.update)
  app.post(
    "/api/workspaces/:workspaceId/memos/:memoId/archive",
    ...authed,
    audit("memos.archive", "write"),
    memo.archive
  )
  app.post(
    "/api/workspaces/:workspaceId/memos/:memoId/unarchive",
    ...authed,
    audit("memos.unarchive", "write"),
    memo.unarchive
  )
  app.delete("/api/workspaces/:workspaceId/memos/:memoId", ...authed, audit("memos.delete", "write"), memo.delete)

  app.post(
    "/api/workspaces/:workspaceId/messages",
    ...authed,
    audit("messages.create", "write"),
    rateLimits.messageCreate,
    message.create
  )
  app.post(
    "/api/workspaces/:workspaceId/messages/move-to-thread/validate",
    ...authed,
    audit("messages.validate_move_to_thread", "write"),
    rateLimits.messageCreate,
    message.validateMoveToThread
  )
  app.post(
    "/api/workspaces/:workspaceId/messages/move-to-thread",
    ...authed,
    audit("messages.move_to_thread", "write"),
    rateLimits.messageCreate,
    message.moveToThread
  )
  app.patch(
    "/api/workspaces/:workspaceId/messages/:messageId",
    ...authed,
    audit("messages.update", "write"),
    message.update
  )
  app.delete(
    "/api/workspaces/:workspaceId/messages/:messageId",
    ...authed,
    audit("messages.delete", "write"),
    message.delete
  )
  app.get(
    "/api/workspaces/:workspaceId/messages/:messageId/versions",
    ...authed,
    audit("messages.get_history", "read"),
    message.getHistory
  )
  app.post(
    "/api/workspaces/:workspaceId/messages/:messageId/reactions",
    ...authed,
    audit("messages.add_reaction", "write"),
    message.addReaction
  )
  app.delete(
    "/api/workspaces/:workspaceId/messages/:messageId/reactions/:emoji",
    ...authed,
    audit("messages.remove_reaction", "write"),
    message.removeReaction
  )

  // Attachments (workspace-scoped upload, stream assigned on message creation)
  app.post(
    "/api/workspaces/:workspaceId/attachments",
    ...authed,
    audit("attachments.upload", "write"),
    rateLimits.upload,
    upload,
    attachment.upload
  )
  // Reserved background uploads: id first, bytes later (send-while-uploading).
  app.post(
    "/api/workspaces/:workspaceId/attachments/reservations",
    ...authed,
    audit("attachments.reserve", "write"),
    rateLimits.upload,
    attachment.reserve
  )
  app.post(
    "/api/workspaces/:workspaceId/attachments/:attachmentId/content",
    ...authed,
    audit("attachments.complete_content", "write"),
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
    audit("attachments.report_upload_failure", "write"),
    attachment.reportUploadFailure
  )
  app.post(
    "/api/workspaces/:workspaceId/attachments/search",
    ...authed,
    audit("attachments.search", "read"),
    rateLimits.search,
    attachment.search
  )
  app.get(
    "/api/workspaces/:workspaceId/attachments/:attachmentId/url",
    ...authed,
    audit("attachments.presign", "read"),
    attachment.getDownloadUrl
  )
  app.get(
    "/api/workspaces/:workspaceId/attachments/:attachmentId/content",
    ...authed,
    audit("attachments.content", "read"),
    attachment.getContent
  )
  app.get(
    "/api/workspaces/:workspaceId/attachments/:attachmentId/extraction",
    ...authed,
    audit("attachments.extraction", "read"),
    attachment.getExtraction
  )
  app.delete(
    "/api/workspaces/:workspaceId/attachments/:attachmentId",
    ...authed,
    audit("attachments.delete", "write"),
    attachment.delete
  )

  app.get(
    "/api/workspaces/:workspaceId/conversations",
    ...authed,
    audit("conversations.list", "read"),
    conversation.listByWorkspace
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/conversations",
    ...authed,
    audit("conversations.list_by_stream", "read"),
    conversation.listByStream
  )
  app.get(
    "/api/workspaces/:workspaceId/conversations/:conversationId",
    ...authed,
    audit("conversations.get", "read"),
    conversation.getById
  )
  app.get(
    "/api/workspaces/:workspaceId/conversations/:conversationId/messages",
    ...authed,
    audit("conversations.get_messages", "read"),
    conversation.getMessages
  )
  app.get(
    "/api/workspaces/:workspaceId/conversations/:conversationId/board-messages",
    ...authed,
    audit("conversations.get_board_messages", "read"),
    conversation.getBoardMessages
  )
  app.get(
    "/api/workspaces/:workspaceId/conversations/:conversationId/board-post",
    ...authed,
    audit("conversations.get_board_post", "read"),
    conversation.getBoardPost
  )
  app.patch(
    "/api/workspaces/:workspaceId/conversations/:conversationId",
    ...authed,
    audit("conversations.update", "write"),
    conversation.updateConversation
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/regenerate-title",
    ...authed,
    audit("conversations.regenerate_title", "write"),
    conversation.regenerateTitle
  )
  app.get(
    "/api/workspaces/:workspaceId/board/exclusions",
    ...authed,
    audit("board.get_exclusions", "read"),
    conversation.getBoardExclusions
  )
  app.get("/api/workspaces/:workspaceId/board/views", ...authed, audit("board.list_views", "read"), boardView.list)
  app.post("/api/workspaces/:workspaceId/board/views", ...authed, audit("board.create_view", "write"), boardView.create)
  app.patch(
    "/api/workspaces/:workspaceId/board/views/:boardViewId",
    ...authed,
    audit("board.update_view", "write"),
    boardView.update
  )
  app.delete(
    "/api/workspaces/:workspaceId/board/views/:boardViewId",
    ...authed,
    audit("board.delete_view", "write"),
    boardView.remove
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/hide",
    ...authed,
    audit("conversations.hide", "write"),
    conversation.hideConversation
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/unhide",
    ...authed,
    audit("conversations.unhide", "write"),
    conversation.unhideConversation
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/board-mute",
    ...authed,
    audit("conversations.mute_stream", "write"),
    conversation.muteStream
  )
  app.post(
    "/api/workspaces/:workspaceId/streams/:streamId/board-unmute",
    ...authed,
    audit("conversations.unmute_stream", "write"),
    conversation.unmuteStream
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/reassign",
    ...authed,
    audit("conversations.reassign_message", "write"),
    conversation.reassignMessage
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/settle",
    ...authed,
    audit("conversations.settle_message", "write"),
    conversation.settleMessage
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/split-thread",
    ...authed,
    audit("conversations.split_thread", "write"),
    conversation.splitThread
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/reassign-messages",
    ...authed,
    audit("conversations.reassign_messages", "write"),
    conversation.reassignMessages
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/split-proposal",
    ...authed,
    audit("conversations.propose_split", "write"),
    conversation.proposeSplit
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/split",
    ...authed,
    audit("conversations.apply_split", "write"),
    conversation.applySplit
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/read",
    ...authed,
    audit("conversations.mark_read", "write"),
    conversation.markRead
  )
  app.post(
    "/api/workspaces/:workspaceId/conversations/:conversationId/unread",
    ...authed,
    audit("conversations.mark_unread", "write"),
    conversation.markUnread
  )

  app.post(
    "/api/workspaces/:workspaceId/commands/dispatch",
    ...authed,
    audit("commands.dispatch", "write"),
    rateLimits.commandDispatch,
    command.dispatch
  )
  app.get("/api/workspaces/:workspaceId/commands", ...authed, audit("commands.list", "read"), command.list)
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/commands",
    ...authed,
    audit.none("static command definitions — config, no personal data (2026-07-19 volume reckoning)"),
    command.listForStream
  )

  // Invitations and member management — gated on members:write
  const requireMembersWrite = requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)

  const memberManagement = createWorkspaceMemberManagementHandlers({ pool, controlPlaneClient })
  app.post(
    "/api/workspaces/:workspaceId/users/:userId/role",
    ...authed,
    audit("members.change_role", "write"),
    requireMembersWrite,
    memberManagement.changeRole
  )
  app.delete(
    "/api/workspaces/:workspaceId/users/:userId",
    ...authed,
    audit("members.remove", "write"),
    requireMembersWrite,
    memberManagement.removeMember
  )

  app.get(
    "/api/workspaces/:workspaceId/invitations",
    ...authed,
    audit("invitations.list", "read"),
    requireMembersWrite,
    invitation.list
  )
  app.post(
    "/api/workspaces/:workspaceId/invitations",
    ...authed,
    audit("invitations.send", "write"),
    requireMembersWrite,
    invitation.send
  )
  app.post(
    "/api/workspaces/:workspaceId/invitations/links",
    ...authed,
    audit("invitations.create_link", "write"),
    requireMembersWrite,
    invitation.createLink
  )
  app.post(
    "/api/workspaces/:workspaceId/invitations/:invitationId/revoke",
    ...authed,
    audit("invitations.revoke", "write"),
    requireMembersWrite,
    invitation.revoke
  )
  app.post(
    "/api/workspaces/:workspaceId/invitations/:invitationId/resend",
    ...authed,
    audit("invitations.resend", "write"),
    requireMembersWrite,
    invitation.resend
  )

  // User setup (any authenticated workspace user)
  app.get(
    "/api/workspaces/:workspaceId/slug-available",
    ...authed,
    audit("workspace.slug_available", "read"),
    workspace.checkSlugAvailability
  )
  app.post(
    "/api/workspaces/:workspaceId/setup",
    ...authed,
    audit("workspace.complete_setup", "write"),
    workspace.completeUserSetup
  )

  app.patch(
    "/api/workspaces/:workspaceId/profile",
    ...authed,
    audit("workspace.update_profile", "write"),
    workspace.updateProfile
  )
  app.put("/api/workspaces/:workspaceId/status", ...authed, audit("workspace.set_status", "write"), workspace.setStatus)
  app.delete(
    "/api/workspaces/:workspaceId/status",
    ...authed,
    audit("workspace.clear_status", "write"),
    workspace.clearStatus
  )
  app.put(
    "/api/workspaces/:workspaceId/notifications/pause",
    ...authed,
    audit("workspace.pause_notifications", "write"),
    workspace.pauseNotifications
  )
  app.delete(
    "/api/workspaces/:workspaceId/notifications/pause",
    ...authed,
    audit("workspace.resume_notifications", "write"),
    workspace.resumeNotifications
  )
  app.post(
    "/api/workspaces/:workspaceId/profile/avatar",
    ...authed,
    audit("workspace.upload_avatar", "write"),
    avatarUpload,
    workspace.uploadAvatar
  )
  app.delete(
    "/api/workspaces/:workspaceId/profile/avatar",
    ...authed,
    audit("workspace.remove_avatar", "write"),
    workspace.removeAvatar
  )

  // Avatar file serving (unauthenticated — S3 keys contain unguessable ULIDs)
  app.get(
    "/api/workspaces/:workspaceId/users/:userId/avatar/:file",
    audit.none("unauthenticated avatar serve; S3 keys carry unguessable ULIDs"),
    workspace.serveAvatarFile
  )

  app.get("/api/workspaces/:workspaceId/ai-usage", ...authed, audit("ai_usage.get", "read"), aiUsage.getUsage)
  app.get(
    "/api/workspaces/:workspaceId/ai-usage/recent",
    ...authed,
    audit("ai_usage.get_recent", "read"),
    aiUsage.getRecentUsage
  )
  app.get("/api/workspaces/:workspaceId/ai-budget", ...authed, audit("ai_usage.get_budget", "read"), aiUsage.getBudget)
  app.put(
    "/api/workspaces/:workspaceId/ai-budget",
    ...authed,
    audit("ai_usage.update_budget", "write"),
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
    aiUsage.updateBudget
  )

  // Sync-log catch-up (sync engine v2 step 1): ordered entries after a cursor,
  // ACL-filtered to the requester's delivery groups.
  app.get("/api/workspaces/:workspaceId/sync", ...authed, audit("streams.catchup", "read"), sync.catchUp)

  app.get("/api/workspaces/:workspaceId/activity", ...authed, audit("activity.list", "read"), activity.list)
  app.post(
    "/api/workspaces/:workspaceId/activity/read",
    ...authed,
    audit("activity.mark_all_read", "write"),
    activity.markAllAsRead
  )
  app.post(
    "/api/workspaces/:workspaceId/activity/:id/read",
    ...authed,
    audit("activity.mark_one_read", "write"),
    activity.markOneAsRead
  )

  app.get("/api/workspaces/:workspaceId/saved", ...authed, audit("saved_messages.list", "read"), savedMessages.list)
  app.post(
    "/api/workspaces/:workspaceId/saved",
    ...authed,
    audit("saved_messages.create", "write"),
    savedMessages.create
  )
  app.patch(
    "/api/workspaces/:workspaceId/saved/:savedId",
    ...authed,
    audit("saved_messages.update", "write"),
    savedMessages.update
  )
  app.delete(
    "/api/workspaces/:workspaceId/saved/:savedId",
    ...authed,
    audit("saved_messages.delete", "write"),
    savedMessages.delete
  )

  // Saved suggestions (passively collected to-do candidates)
  app.get(
    "/api/workspaces/:workspaceId/saved/suggestions",
    ...authed,
    audit("saved_suggestions.list", "read"),
    savedSuggestions.list
  )
  app.post(
    "/api/workspaces/:workspaceId/saved/suggestions/:suggestionId/accept",
    ...authed,
    audit("saved_suggestions.accept", "write"),
    savedSuggestions.accept
  )
  app.post(
    "/api/workspaces/:workspaceId/saved/suggestions/:suggestionId/dismiss",
    ...authed,
    audit("saved_suggestions.dismiss", "write"),
    savedSuggestions.dismiss
  )

  app.get("/api/workspaces/:workspaceId/labels", ...authed, audit("labels.list", "read"), label.list)
  app.get(
    "/api/workspaces/:workspaceId/labels/:labelId/messages",
    ...authed,
    audit("labels.list_messages", "read"),
    label.listMessages
  )
  app.post("/api/workspaces/:workspaceId/labels", ...authed, audit("labels.create", "write"), label.create)
  app.patch("/api/workspaces/:workspaceId/labels/:labelId", ...authed, audit("labels.update", "write"), label.update)
  app.delete("/api/workspaces/:workspaceId/labels/:labelId", ...authed, audit("labels.delete", "write"), label.delete)
  app.post(
    "/api/workspaces/:workspaceId/labels/:labelId/assignments",
    ...authed,
    audit("labels.assign", "write"),
    label.assign
  )
  app.delete(
    "/api/workspaces/:workspaceId/labels/:labelId/assignments",
    ...authed,
    audit("labels.unassign", "write"),
    label.unassign
  )

  app.get(
    "/api/workspaces/:workspaceId/scheduled",
    ...authed,
    audit("scheduled_messages.list", "read"),
    scheduledMessages.list
  )
  app.post(
    "/api/workspaces/:workspaceId/scheduled",
    ...authed,
    audit("scheduled_messages.create", "write"),
    scheduledMessages.create
  )
  app.get(
    "/api/workspaces/:workspaceId/scheduled/:id",
    ...authed,
    audit("scheduled_messages.get", "read"),
    scheduledMessages.getById
  )
  app.patch(
    "/api/workspaces/:workspaceId/scheduled/:id",
    ...authed,
    audit("scheduled_messages.update", "write"),
    scheduledMessages.update
  )
  app.delete(
    "/api/workspaces/:workspaceId/scheduled/:id",
    ...authed,
    audit("scheduled_messages.delete", "write"),
    scheduledMessages.delete
  )
  app.post(
    "/api/workspaces/:workspaceId/scheduled/:id/lock",
    ...authed,
    audit("scheduled_messages.lock", "write"),
    scheduledMessages.lockForEdit
  )
  app.post(
    "/api/workspaces/:workspaceId/scheduled/:id/unlock",
    ...authed,
    audit("scheduled_messages.unlock", "write"),
    scheduledMessages.releaseEditLock
  )
  app.post(
    "/api/workspaces/:workspaceId/scheduled/:id/send-now",
    ...authed,
    audit("scheduled_messages.send_now", "write"),
    scheduledMessages.sendNow
  )

  // Agent follow-ups — a stream member can cancel a follow-up they can see from
  // its timeline card (roadmap 1.3). Scheduling/listing stay agent-only tools.
  app.post(
    "/api/workspaces/:workspaceId/agent-follow-ups/:id/cancel",
    ...authed,
    audit("agent_follow_ups.cancel", "write"),
    agentFollowUps.cancel
  )

  app.get("/api/workspaces/:workspaceId/delegations", ...authed, audit("delegations.list", "read"), delegations.list)
  app.get("/api/workspaces/:workspaceId/delegations/:id", ...authed, audit("delegations.get", "read"), delegations.get)
  app.post(
    "/api/workspaces/:workspaceId/delegations/:id/requeue",
    ...authed,
    audit("delegations.requeue", "write"),
    delegations.requeue
  )
  app.post(
    "/api/workspaces/:workspaceId/delegations/:id/cancel",
    ...authed,
    audit("delegations.cancel", "write"),
    delegations.cancel
  )
  // Subagent runs — the card's Cancel and Try again, plus the authoritative
  // read a surface falls back to when the run's status patches are outside its
  // window. Same access model as delegation cancel: stream access, 404-hiding,
  // race-honest response.
  app.get("/api/workspaces/:workspaceId/subagents/:id", ...authed, audit("subagents.get", "read"), subagents.get)
  app.post(
    "/api/workspaces/:workspaceId/subagents/:id/cancel",
    ...authed,
    audit("subagents.cancel", "write"),
    subagents.cancel
  )
  app.post(
    "/api/workspaces/:workspaceId/subagents/:id/requeue",
    ...authed,
    audit("subagents.requeue", "write"),
    subagents.requeue
  )

  app.get(
    "/api/workspaces/:workspaceId/agent-outcomes",
    ...authed,
    audit("agent_outcomes.list", "read"),
    agentOutcomes.list
  )

  app.post(
    "/api/workspaces/:workspaceId/delegations/:id/done",
    ...authed,
    audit("delegations.mark_done", "write"),
    delegations.markDone
  )

  // Bot access requests — a stream member approves or denies a bot's request to
  // access the stream so it can claim a delegation (F3). Approve applies the
  // grant; both are member-gated (stricter than delegation cancel).
  app.post(
    "/api/workspaces/:workspaceId/bot-access-requests/:id/approve",
    ...authed,
    audit("bot_access_requests.approve", "write"),
    botAccessRequests.approve
  )
  app.post(
    "/api/workspaces/:workspaceId/bot-access-requests/:id/deny",
    ...authed,
    audit("bot_access_requests.deny", "write"),
    botAccessRequests.deny
  )

  // Drafts — centralized, local-first composer payloads that roam across the
  // author's devices. Private to the author; never timeline-broadcast.
  app.get("/api/workspaces/:workspaceId/drafts", ...authed, audit("drafts.list", "read"), drafts.list)
  app.put("/api/workspaces/:workspaceId/drafts/:id", ...authed, audit("drafts.upsert", "write"), drafts.upsert)
  app.post(
    "/api/workspaces/:workspaceId/drafts/:id/resolve",
    ...authed,
    audit("drafts.resolve", "write"),
    drafts.resolve
  )
  app.delete("/api/workspaces/:workspaceId/drafts/:id", ...authed, audit("drafts.delete", "write"), drafts.delete)

  const push = createPushHandlers({ pushService })
  const perfDiagnostics = createPerfDiagnosticsHandlers({ perfDiagnosticsService })
  app.get(
    "/api/workspaces/:workspaceId/push/vapid-key",
    ...authed,
    audit("push.get_vapid_key", "read"),
    push.getVapidKey
  )
  app.post(
    "/api/workspaces/:workspaceId/perf-captures",
    ...authed,
    audit("perf_capture.create", "write"),
    rateLimits.perfCapture,
    perfDiagnostics.create
  )
  app.post("/api/workspaces/:workspaceId/push/subscribe", ...authed, audit("push.subscribe", "write"), push.subscribe)
  app.post(
    "/api/workspaces/:workspaceId/push/unsubscribe",
    ...authed,
    audit("push.unsubscribe", "write"),
    push.unsubscribe
  )
  app.post(
    "/api/workspaces/:workspaceId/push/test",
    ...authed,
    audit("push.test", "write"),
    rateLimits.pushTest,
    push.sendTest
  )
  // Non-workspace-scoped: cleans up all push subscriptions for a browser endpoint (used on logout)
  app.post("/api/push/cleanup-endpoint", auth, audit("push.cleanup_endpoint", "write"), push.cleanupEndpoint)

  app.get(
    "/api/workspaces/:workspaceId/agent-sessions/:sessionId",
    ...authed,
    audit("agent_sessions.get", "read"),
    agentSession.getSession
  )

  app.post(
    "/api/workspaces/:workspaceId/context-bag/precompute",
    ...authed,
    audit("context_bag.precompute", "write"),
    contextBag.precompute
  )
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/context-bag",
    ...authed,
    audit("context_bag.get_stream_bag", "read"),
    contextBag.getStreamBag
  )

  app.get(
    "/api/workspaces/:workspaceId/messages/:messageId/link-previews",
    ...authed,
    audit("link_previews.get_for_message", "read"),
    linkPreview.getForMessage
  )
  app.post(
    "/api/workspaces/:workspaceId/messages/:messageId/link-previews/:linkPreviewId/dismiss",
    ...authed,
    audit("link_previews.dismiss", "write"),
    linkPreview.dismiss
  )
  app.get(
    "/api/workspaces/:workspaceId/link-previews/resolve",
    ...authed,
    audit("link_previews.resolve_in_app", "read"),
    linkPreview.resolveInAppLinkByUrl
  )
  app.get(
    "/api/workspaces/:workspaceId/link-previews/:linkPreviewId/resolve",
    ...authed,
    audit("link_previews.resolve_in_app_by_id", "read"),
    linkPreview.resolveInAppLink
  )

  // Giphy picker — backend proxy keeps the API key server-side. `config` reports
  // whether the feature is enabled; the chosen GIF is embedded by its CDN URL
  // (no byte download), so there's no file-proxy endpoint.
  app.get("/api/workspaces/:workspaceId/giphy/config", ...authed, audit("giphy.get_config", "read"), giphy.getConfig)
  app.get(
    "/api/workspaces/:workspaceId/giphy/search",
    ...authed,
    audit("giphy.search", "read"),
    rateLimits.search,
    giphy.search
  )
  app.get(
    "/api/workspaces/:workspaceId/giphy/trending",
    ...authed,
    audit("giphy.trending", "read"),
    rateLimits.search,
    giphy.trending
  )

  // Workspace integrations — gated on workspace:admin
  const requireWorkspaceAdmin = requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  app.get(
    "/api/workspaces/:workspaceId/integrations/github",
    ...authed,
    audit("integrations.get_github", "read"),
    requireWorkspaceAdmin,
    workspaceIntegration.getGithub
  )
  app.get(
    "/api/workspaces/:workspaceId/integrations/github/connect",
    ...authed,
    audit("integrations.connect_github", "read"),
    requireWorkspaceAdmin,
    workspaceIntegration.connectGithub
  )
  app.delete(
    "/api/workspaces/:workspaceId/integrations/github/:integrationId",
    ...authed,
    audit("integrations.disconnect_github", "write"),
    requireWorkspaceAdmin,
    workspaceIntegration.disconnectGithub
  )
  app.post(
    "/api/workspaces/:workspaceId/integrations/github/:integrationId/sync",
    ...authed,
    audit("integrations.sync_github", "write"),
    requireWorkspaceAdmin,
    workspaceIntegration.syncGithub
  )

  app.get(
    "/api/workspaces/:workspaceId/integrations/linear",
    ...authed,
    audit("integrations.get_linear", "read"),
    requireWorkspaceAdmin,
    workspaceIntegration.getLinear
  )
  app.get(
    "/api/workspaces/:workspaceId/integrations/linear/connect",
    ...authed,
    audit("integrations.connect_linear", "read"),
    requireWorkspaceAdmin,
    workspaceIntegration.connectLinear
  )
  app.delete(
    "/api/workspaces/:workspaceId/integrations/linear",
    ...authed,
    audit("integrations.disconnect_linear", "write"),
    requireWorkspaceAdmin,
    workspaceIntegration.disconnectLinear
  )

  // Fixed callback targets for provider installation flows (workspace resolved from signed state)
  app.get(
    "/api/integrations/github/callback",
    auth,
    audit("integrations.github_callback", "read"),
    workspaceIntegration.githubCallback
  )
  app.get(
    "/api/integrations/linear/callback",
    auth,
    audit("integrations.linear_callback", "read"),
    workspaceIntegration.linearCallback
  )

  // User API key management (any authenticated user)
  const userApiKeys = createUserApiKeyHandlers({ userApiKeyService })
  app.get(
    "/api/workspaces/:workspaceId/user-api-keys",
    ...authed,
    audit("user_api_keys.list", "read"),
    userApiKeys.list
  )
  app.post(
    "/api/workspaces/:workspaceId/user-api-keys",
    ...authed,
    audit("user_api_keys.create", "write"),
    userApiKeys.create
  )
  app.patch(
    "/api/workspaces/:workspaceId/user-api-keys/:keyId",
    ...authed,
    audit("user_api_keys.update", "write"),
    userApiKeys.update
  )
  app.post(
    "/api/workspaces/:workspaceId/user-api-keys/:keyId/revoke",
    ...authed,
    audit("user_api_keys.revoke", "write"),
    userApiKeys.revoke
  )

  // Voice dictation: HTTP creates/aborts the session; the dedicated /voice
  // socket namespace owns the live audio relay and authoritative stop.
  const voice = createVoiceTranscriptionHandlers({ voiceTranscriptionService })
  app.post(
    "/api/workspaces/:workspaceId/voice/sessions",
    ...authed,
    audit("voice.create_session", "write"),
    voice.createSession
  )
  app.delete(
    "/api/workspaces/:workspaceId/voice/sessions/:sessionId",
    ...authed,
    audit("voice.abort_session", "write"),
    voice.abortSession
  )

  // Calls (voice/video, flag-gated). HTTP starts/bootstraps a call and proxies
  // the CF Realtime session/track operations (the app secret never reaches the
  // client); the dedicated /calls socket namespace owns the control plane.
  const calls = createCallHandlers({
    pool,
    io: deps.io,
    callService,
    featureFlagService,
    cloudflareEnabled: callsCloudflareEnabled,
  })
  app.post(
    "/api/workspaces/:workspaceId/calls",
    ...authed,
    audit("calls.start", "write"),
    rateLimits.callsStart,
    calls.start
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/invitations/:invitationId/decline",
    ...authed,
    audit("calls.decline_invitation", "write"),
    rateLimits.calls,
    calls.declineInvitation
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/invitations/:invitationId/cancel",
    ...authed,
    audit("calls.cancel_invitation", "write"),
    rateLimits.calls,
    calls.cancelInvitation
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/:callId/leave",
    ...authed,
    audit("calls.leave", "write"),
    rateLimits.calls,
    calls.leave
  )
  app.get(
    "/api/workspaces/:workspaceId/calls/:callId",
    ...authed,
    audit("calls.bootstrap", "read"),
    rateLimits.calls,
    calls.bootstrap
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/:callId/endpoints/:endpointId/cf/session",
    ...authed,
    audit("calls.cf_session", "write"),
    rateLimits.calls,
    calls.createCfSession
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/:callId/endpoints/:endpointId/cf/renegotiate",
    ...authed,
    audit("calls.cf_renegotiate", "write"),
    rateLimits.calls,
    calls.renegotiate
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/:callId/endpoints/:endpointId/cf/tracks/publish",
    ...authed,
    audit("calls.cf_publish_tracks", "write"),
    rateLimits.calls,
    calls.publishTracks
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/:callId/endpoints/:endpointId/cf/tracks/pull",
    ...authed,
    audit("calls.cf_pull_tracks", "write"),
    rateLimits.calls,
    calls.pullTracks
  )
  app.post(
    "/api/workspaces/:workspaceId/calls/:callId/endpoints/:endpointId/cf/tracks/close",
    ...authed,
    audit("calls.cf_close_tracks", "write"),
    rateLimits.calls,
    calls.closeTracks
  )

  // Bot management. Management routes (update, archive, keys, avatar, grants)
  // are gated by `requireBotManagement()` middleware that resolves the bot,
  // authorizes the actor (ownership for personal bots, BOTS_MANAGE for shared),
  // and attaches the bot to req.bot so handlers don't re-fetch it.
  const botHandlers = createBotHandlers({ botApiKeyService, avatarService, streamService, pool })
  const requireBotManagement = createRequireBotManagement(pool)
  app.get("/api/workspaces/:workspaceId/bots", ...authed, audit("bots.list", "read"), botHandlers.list)
  app.post("/api/workspaces/:workspaceId/bots", ...authed, audit("bots.create", "write"), botHandlers.create)
  app.get("/api/workspaces/:workspaceId/bots/:botId", ...authed, audit("bots.get", "read"), botHandlers.get)
  app.patch(
    "/api/workspaces/:workspaceId/bots/:botId",
    ...authed,
    audit("bots.update", "write"),
    requireBotManagement(),
    botHandlers.update
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/archive",
    ...authed,
    audit("bots.archive", "write"),
    requireBotManagement(),
    botHandlers.archive
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/restore",
    ...authed,
    audit("bots.restore", "write"),
    requireBotManagement(),
    botHandlers.restore
  )
  app.get(
    "/api/workspaces/:workspaceId/bots/:botId/keys",
    ...authed,
    audit("bots.list_keys", "read"),
    requireBotManagement(),
    botHandlers.listKeys
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/keys",
    ...authed,
    audit("bots.create_key", "write"),
    requireBotManagement(),
    botHandlers.createKey
  )
  app.patch(
    "/api/workspaces/:workspaceId/bots/:botId/keys/:keyId",
    ...authed,
    audit("bots.update_key", "write"),
    requireBotManagement(),
    botHandlers.updateKey
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/keys/:keyId/revoke",
    ...authed,
    audit("bots.revoke_key", "write"),
    requireBotManagement(),
    botHandlers.revokeKey
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/avatar",
    ...authed,
    audit("bots.upload_avatar", "write"),
    requireBotManagement(),
    avatarUpload,
    botHandlers.uploadAvatar
  )
  app.delete(
    "/api/workspaces/:workspaceId/bots/:botId/avatar",
    ...authed,
    audit("bots.remove_avatar", "write"),
    requireBotManagement(),
    botHandlers.removeAvatar
  )
  // Bot avatar serving (unauthenticated — S3 keys contain unguessable ULIDs)
  app.get(
    "/api/workspaces/:workspaceId/bots/:botId/avatar/:file",
    audit.none("unauthenticated avatar serve; S3 keys carry unguessable ULIDs"),
    botHandlers.serveAvatarFile
  )
  // Bot channel access grants
  app.get(
    "/api/workspaces/:workspaceId/bots/:botId/streams",
    ...authed,
    audit("bots.list_stream_grants", "read"),
    requireBotManagement(),
    botHandlers.listStreamGrants
  )
  app.post(
    "/api/workspaces/:workspaceId/bots/:botId/streams/:streamId/grant",
    ...authed,
    audit("bots.grant_stream_access", "write"),
    requireBotManagement(),
    botHandlers.grantStreamAccess
  )
  app.delete(
    "/api/workspaces/:workspaceId/bots/:botId/streams/:streamId/grant",
    ...authed,
    audit("bots.revoke_stream_access", "write"),
    requireBotManagement(),
    botHandlers.revokeStreamAccess
  )
  // Stream → bots reverse lookup (admin-only — only admins manage stream bot inventories)
  app.get(
    "/api/workspaces/:workspaceId/streams/:streamId/bots",
    ...authed,
    audit("bots.list_stream_bots", "read"),
    requireWorkspacePermission(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE),
    botHandlers.listStreamBots
  )

  // Public API v1 — API key auth (workspace-scoped or user-scoped)
  const publicAuth = createPublicApiAuthMiddleware({ userApiKeyService, botApiKeyService, workspaceAuthzService, pool })
  const publicApi = createPublicApiHandlers({
    searchService,
    featureFlagService,
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
  // Boundary ahead of key auth: a bad/revoked API key 401s inside publicAuth
  // without reaching the route's audit(...) — key-probing attempts must leave
  // a trace (actor unknown, ip recorded).
  const publicMiddleware = [rateLimits.publicApiWorkspace, rateLimits.publicApiKey, audit.boundary, publicAuth] as const

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
    sendBotInvocationMessage: publicApi.sendBotInvocationMessage,
    sendBotInvocationSealedMessage: publicApi.sendBotInvocationSealedMessage,
    completeBotInvocationSealed: publicApi.completeBotInvocationSealed,
    completeBotInvocation: publicApi.completeBotInvocation,
    failBotInvocation: publicApi.failBotInvocation,
    listDelegations: delegationPublicApi.listDelegations,
    getDelegation: delegationPublicApi.getDelegation,
    claimDelegation: delegationPublicApi.claimDelegation,
    releaseDelegation: delegationPublicApi.releaseDelegation,
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

  // POST-shaped reads: same §11 decision as the session search routes — a
  // breach query filtered by access_kind='read' must not miss external-caller
  // searches, nor should 'write' queries be polluted with them.
  const publicApiReadPosts = new Set(["searchMessages", "searchMemos", "searchAttachments", "findMessagesByMetadata"])

  for (const route of PUBLIC_API_ROUTES) {
    const handler = publicHandlers[route.operationId]
    const scopeGuard = route.scopes.length > 0 ? [requireApiKeyScope(...route.scopes)] : []
    const kind = route.method === "get" || publicApiReadPosts.has(route.operationId) ? "read" : "write"
    app[route.method](
      toExpressPath(route.path),
      ...publicMiddleware,
      audit(publicApiOperation(route.operationId), kind),
      createApiVersionGate(route.operationId),
      ...scopeGuard,
      ...(Array.isArray(handler) ? handler : [handler])
    )
  }

  // Boot-time invariant: every /api route declares an audit annotation (design
  // §7.1). A new endpoint without one fails the server's start, not silently
  // ships un-logged access.
  assertAuditCoverage(app)

  app.use(errorHandler)
}
