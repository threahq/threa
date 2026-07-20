import { createServer, Server } from "http"
import { Server as SocketIOServer } from "socket.io"
import { createAdapter } from "@socket.io/postgres-adapter"
import { Pool } from "pg"
import { createApp } from "./app"
import { DelegationService, createDelegationExpirySweep, validateDelegationContextRefs } from "./features/delegations"
import { registerRoutes } from "./routes"
import { errorHandler } from "./middleware/error-handler"
import { registerSocketHandlers } from "./socket"
import { createDatabasePools, warmPool, type DatabasePools } from "./db"
import { runMigrations } from "./db/migrations"
import { WorkosAuthService, StubAuthService, WorkosApiKeyService, StubApiKeyService } from "@threa/backend-common"
import { BotChannelService } from "./features/api-keys"
import { UserApiKeyService as UserApiKeyServiceImpl } from "./features/user-api-keys"
import {
  VoiceTranscriptionService,
  createTranscription,
  createVoiceSessionSweeper,
  registerVoiceGateway,
  createPolishTranscript,
} from "./features/voice-transcription"
import {
  CallService,
  CloudflareRealtimeApi,
  createCallSweeper,
  registerCallGateway,
  type RealtimeMediaApi,
} from "./features/calls"
import { BotApiKeyService, createBotRuntimeWriteOps } from "./features/public-api"
import {
  EnclaveRuntimesService,
  EnclaveClaimService,
  EnclaveClaimNudge,
  EnclaveDispatchHandler,
} from "./features/enclave-runtimes"
import {
  LinkPreviewService,
  LinkPreviewOutboxHandler,
  createLinkPreviewWorker,
  createLinkPreviewVisibleRefreshWorker,
} from "./features/link-previews"
import { createGithubWebhookWorker, createGithubPreviewRefreshWorker } from "./features/github-webhooks"
import { GiphyService } from "./features/giphy"
import {
  WorkspaceIntegrationService,
  GithubRouteSyncHandler,
  registerGithubInstallationBackfill,
} from "./features/workspace-integrations"
import { WorkspaceAuthzService } from "./features/workspace-authz"
import {
  WorkspaceService,
  AvatarService,
  AvatarProcessingService,
  createAvatarProcessWorker,
  createAvatarProcessOnDLQ,
  UserRepository,
} from "./features/workspaces"
import { InvitationService, InvitationShadowSyncHandler } from "./features/invitations"
import { WorkosOrgServiceImpl, StubWorkosOrgService } from "@threa/backend-common"
import { PartitionMaintenanceWorker } from "@threa/backend-common"
import { AccessLogService, createAiAccessLogSink } from "./features/access-log"
import {
  StreamService,
  StreamNamingService,
  StubStreamNamingService,
  StreamBriefService,
  NamingHandler,
  createNamingWorker,
} from "./features/streams"
import { EventService } from "./features/messaging"
import { AttachmentService, createAttachmentUploadSweepWorker } from "./features/attachments"
import { MessageFormatter } from "./lib/ai/message-formatter"
import { SearchService } from "./features/search"
import {
  MemoService,
  MemoExplorerService,
  MemoReranker,
  StubReranker,
  StubMemoService,
  MemoClassifier,
  Memorizer,
  EmbeddingService,
  StubEmbeddingService,
  EmbeddingHandler,
  MemoAccumulatorHandler,
  createEmbeddingWorker,
  createMemoBatchCheckWorker,
  createMemoBatchProcessWorker,
} from "./features/memos"
import {
  ConversationService,
  conversationAssigner,
  BoundaryExtractionService,
  BoundaryExtractionHandler,
  createBoundaryExtractionWorker,
  createStalenessSweepWorker,
  LLMBoundaryExtractor,
  StubBoundaryExtractor,
} from "./features/conversations"
import { UserPreferencesService } from "./features/user-preferences"
import { WorkspaceSettingsService } from "./features/workspace-settings"
import { FeatureFlagService } from "./features/feature-flags"
import { PlatformAdminService } from "./features/platform-admin"
import { SidebarConfigService } from "./features/sidebar-config"
import { UserE2eKeysService } from "./features/user-e2e-keys"
import { createS3Storage } from "./lib/storage/s3-client"
import {
  OutboxDispatcher,
  BroadcastHandler,
  OutboxRetentionWorker,
  OutboxRepository,
  type OutboxHandler,
} from "./lib/outbox"
import {
  CompanionHandler,
  MentionInvokeHandler,
  AgentMessageMutationHandler,
  ContextBagPrecomputeHandler,
  createContextBagPrecomputeWorker,
  createOrphanSessionCleanup,
  createPersonaAgentWorker,
  AgentFollowUpService,
  AgentFollowUpRepository,
  PersonaConfigService,
  createAgentFollowUpFireWorker,
  EpisodeSummaryService,
  createEpisodeSummarizeWorker,
  ReflectiveCaptureService,
  createReflectiveCaptureWorker,
  WorkspaceAgent,
  GeneralResearcher,
  PersonaAgent,
  TraceEmitter,
  SessionAbortRegistry,
  AgentSessionMetricsCollector,
  ConversationSummaryService,
  COMPANION_SUMMARY_MODEL_ID,
  COMPANION_SUMMARY_TEMPERATURE,
  EPISODE_SUMMARY_MODEL_ID,
  EPISODE_SUMMARY_TEMPERATURE,
  EPISODE_SUMMARY_MAX_TOKENS,
  stripInaccessibleAgentRefs,
} from "./features/agents"
import { EmojiUsageHandler } from "./features/emoji"
import { SystemMessageService, SystemMessageOutboxHandler } from "./features/system-messages"
import { ActivityService, ActivityFeedHandler } from "./features/activity"
import { SyncService, SyncLogReconciliationWorker, SyncHeartbeatWorker, SyncLogRetentionWorker } from "./features/sync"
import { BotInvocationOutboxHandler } from "./features/bot-runtimes/invocation-outbox-handler"
import {
  BotRuntimeInstanceRepository,
  BotRuntimeService,
  BotSocketRegistry,
  attachBotNamespace,
} from "./features/bot-runtimes"
import { SavedMessagesService, createSavedReminderWorker } from "./features/saved-messages"
import { SavedSuggestionsService, SuggestionExtractor } from "./features/saved-suggestions"
import { ScheduledMessagesService, createScheduledMessageSendWorker } from "./features/scheduled-messages"
import { DraftsService } from "./features/drafts"
import { LabelService, LabelAssignmentService, LabelMessageService } from "./features/labels"
import { PushService, PushNotificationHandler, createPushSessionCleanup } from "./features/push"
import { AttachmentUploadedHandler, AttachmentEmbeddingHandler } from "./features/attachments"
import { AICostService, AIBudgetService } from "./features/ai-usage"
import { CommandRegistry, InviteCommand, createCommandWorker, CommandHandler } from "./features/commands"
import {
  createImageCaptionWorker,
  createImageThumbnailWorker,
  createPdfPrepareWorker,
  createPdfPageWorker,
  createPdfAssembleWorker,
  createTextProcessingWorker,
  createWordProcessingWorker,
  createExcelProcessingWorker,
  createVideoTranscodeSubmitWorker,
  createVideoTranscodeCheckWorker,
  createAttachmentEmbeddingWorker,
  ImageCaptionService,
  StubImageCaptionService,
  ImageThumbnailService,
  PdfProcessingService,
  StubPdfProcessingService,
  TextProcessingService,
  StubTextProcessingService,
  WordProcessingService,
  StubWordProcessingService,
  ExcelProcessingService,
  StubExcelProcessingService,
  VideoTranscodingService,
  StubVideoTranscodingService,
  ThreaMediaConvertClient,
  VideoTranscodeJobRepository,
  createMalwareScanner,
} from "./features/attachments"
import {
  JobQueues,
  type OnDLQHook,
  type ImageCaptionJobData,
  type PdfPrepareJobData,
  type PdfProcessPageJobData,
  type PdfAssembleJobData,
  type TextProcessJobData,
  type WordProcessJobData,
  type ExcelProcessJobData,
  type VideoTranscodeSubmitJobData,
  type VideoTranscodeCheckJobData,
  type AgentFollowUpFireJobData,
} from "./lib/queue"
import { AuthorTypes, ProcessingStatuses, resolveNotificationPause } from "@threa/types"
import { AttachmentRepository } from "./features/attachments"
import { ulid } from "ulid"
import { loadConfig } from "./lib/env"
import { createCorsOriginChecker } from "./lib/cors"
import type { AuthorType, ConversationDirective } from "@threa/types"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threa/prosemirror"
import { normalizeMessage, toEmoji } from "./features/emoji"
import { logger } from "./lib/logger"
import { createAI } from "@threa/agent-runtime"
import { createModelRegistry } from "@threa/agent-runtime"
import { createStaticConfigResolver } from "./lib/ai/static-config-resolver"
import {
  QueueManager,
  QueueTiers,
  QueueFairness,
  ScheduleManager,
  CleanupWorker,
  QueueRetentionWorker,
  QueueRepository,
  TokenPoolRepository,
} from "./lib/queue"
import { UserSocketRegistry } from "./lib/user-socket-registry"
import { PoolMonitor } from "./lib/observability"
import { ControlPlaneClient } from "./lib/control-plane-client"
import { createBackfillPlanWorker, createBackfillChunkWorker } from "./lib/backfill"
import { registerMentionBackfill } from "./features/mentions"

export interface ServerInstance {
  server: Server
  io: SocketIOServer
  pools: DatabasePools
  jobQueue: QueueManager
  poolMonitor: PoolMonitor
  port: number
  fastShutdown: boolean
  stop: () => Promise<void>
}

export async function startServer(): Promise<ServerInstance> {
  const config = loadConfig()

  const { collectDefaultMetrics } = await import("./lib/observability")
  collectDefaultMetrics()
  logger.info("Prometheus metrics collection initialized")

  // Separated pools: main (services/workers/HTTP), listen (LISTEN connections),
  // realtime (broadcast + push, reserved capacity).
  const pools = createDatabasePools(config.databaseUrl)
  const pool = pools.main

  const poolMonitor = new PoolMonitor(
    { main: pools.main, listen: pools.listen, realtime: pools.realtime },
    {
      logIntervalMs: 30000,
      warnThreshold: 80,
      disableLogging: true, // use Grafana for monitoring instead of periodic logs
    }
  )
  poolMonitor.start()

  await runMigrations(pool)

  // Pre-warm before workers start: 15+ workers connecting at once can overwhelm
  // an empty pool and cause phantom connections. Env-configurable (clamped to
  // the pool max so a misconfig can't wedge boot) so shared-DB PR deploys, which
  // see no real startup herd, warm just a couple instead of grabbing 15 at once
  // and colliding on the shared server's connection cap.
  // Test presence, not truthiness: `Number(x) || 15` would turn an explicit
  // "0" (operator disabling warm-up) into 15. A non-empty string is truthy, so
  // "0" → 0 while unset/"" → 15.
  const configuredWarm = process.env.DATABASE_WARM_POOL_COUNT
  const warmCount = Math.min(configuredWarm ? Number(configuredWarm) : 15, Number(process.env.DATABASE_POOL_MAX) || 30)
  logger.info({ warmCount }, "Pre-warming connection pool...")
  // Best-effort: pre-warming is a cold-start optimization, never a boot gate. On
  // a shared-DB PR deploy the server can be at its connection cap, and warmPool
  // holds `warmCount` connections at once — the first demand for multiple slots,
  // so it's where a saturated server first bites. Letting it throw here escapes
  // the top-level `await startServer()` as an unhandledRejection and the process
  // exits before it ever binds a port; the supervisor restarts it and every
  // restart re-storms connect(), so the pool never drains and the backend
  // crash-loops without serving. Boot regardless; the pool fills lazily and a
  // healthy, listening instance lets the storm subside.
  try {
    await warmPool(pools.main, warmCount)
    logger.info("Connection pool pre-warmed")
  } catch (err) {
    logger.warn({ err, warmCount }, "Connection pool pre-warm failed — continuing; pool will fill on demand")
  }

  const workosOrgService = config.useStubAuth ? new StubWorkosOrgService() : new WorkosOrgServiceImpl(config.workos)
  const storage = createS3Storage(config.s3)
  const avatarService = new AvatarService(storage)
  const streamService = new StreamService(pool)
  const eventService = new EventService(pool, conversationAssigner)
  const authService = config.useStubAuth ? new StubAuthService() : new WorkosAuthService(config.workos)

  const malwareScanner = createMalwareScanner(storage, config.attachments)
  const attachmentService = new AttachmentService(pool, storage, malwareScanner)
  await attachmentService.recoverStalePendingScans()

  const costService = new AICostService({ pool })
  const budgetService = new AIBudgetService({ pool })
  const accessLogService = new AccessLogService({ pool })

  const ai = createAI({
    openrouter: { apiKey: config.ai.openRouterApiKey },
    costRecorder: costService,
    budgetEnforcer: budgetService,
    accessLogSink: createAiAccessLogSink(accessLogService),
  })
  const modelRegistry = createModelRegistry()
  const configResolver = createStaticConfigResolver()
  const messageFormatter = new MessageFormatter()
  const streamNamingService = config.useStubAI
    ? new StubStreamNamingService()
    : new StreamNamingService(pool, ai, configResolver, messageFormatter)
  const conversationService = new ConversationService(pool)
  const userPreferencesService = new UserPreferencesService(pool)
  const workspaceSettingsService = new WorkspaceSettingsService(pool)
  const featureFlagService = new FeatureFlagService(pool)
  const platformAdminService = new PlatformAdminService(pool)
  const sidebarConfigService = new SidebarConfigService(pool)
  const userE2eKeysService = new UserE2eKeysService(pool)

  const embeddingService = config.useStubAI ? new StubEmbeddingService() : new EmbeddingService({ ai })
  const memoReranker = config.useStubAI ? new StubReranker() : new MemoReranker({ ai })
  const searchService = new SearchService({ pool, embeddingService })
  const memoExplorerService = new MemoExplorerService({ pool, embeddingService, reranker: memoReranker })

  // Tiered concurrency budgets: each tier has its own in-flight cap so slow
  // heavy work (PDF/image/memo) cannot monopolize the pool and starve
  // interactive work (persona agent responses, commands). Worst case ~45
  // concurrent handlers (15 tokens × 3 msgs/token), bounded per tier; main pool
  // is 30, so realtime handlers on `pools.realtime` stay isolated. Fairness
  // defaults to `none` because region sharding already isolates tenants, so a
  // single workspace may use a tier's full budget.
  const jobQueue = new QueueManager({
    pool,
    queueRepository: QueueRepository,
    tokenPoolRepository: TokenPoolRepository,
    pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS) || 500,
    refillDebounceMs: 100,
    processingConcurrency: 3,
    tiers: {
      [QueueTiers.INTERACTIVE]: {
        maxActiveTokens: Number(process.env.QUEUE_INTERACTIVE_TOKENS) || 6,
      },
      [QueueTiers.LIGHT]: {
        maxActiveTokens: Number(process.env.QUEUE_LIGHT_TOKENS) || 6,
      },
      [QueueTiers.HEAVY]: {
        maxActiveTokens: Number(process.env.QUEUE_HEAVY_TOKENS) || 3,
      },
    },
  })

  const workspaceService = new WorkspaceService(pool, avatarService, jobQueue, workosOrgService, {
    requireWorkspaceCreationInvite: config.workspaceCreationRequiresInvite,
  })
  const controlPlaneClient =
    config.controlPlaneUrl && config.internalApiKey
      ? new ControlPlaneClient(config.controlPlaneUrl, config.internalApiKey)
      : null
  const invitationService = new InvitationService(pool, workspaceService)

  const scheduleManager = new ScheduleManager(pool, {
    lookaheadSeconds: 60,
    intervalMs: 10000,
    batchSize: 100,
  })

  const cleanupWorker = new CleanupWorker(pool, {
    intervalMs: 300000,
    expiredThresholdMs: 300000,
  })

  const agentSessionMetrics = new AgentSessionMetricsCollector(pool)

  const createMessage = async (params: {
    workspaceId: string
    streamId: string
    authorId: string
    authorType: AuthorType
    content: string
    sources?: { title: string; url: string }[]
    sessionId?: string
    /** Idempotency key forwarded to `event-service.createMessage` so retried writes dedup via ON CONFLICT. */
    clientMessageId?: string
    /**
     * Pre-computed `AgentAccessSpec` reach for persona-authored messages.
     * Authorizes inline-attachment / share-pointer gates via set membership
     * — personas have no `stream_members` rows, so the user-path membership
     * check always denies. The scope is invocation-bounded by design (a
     * public channel only sees public streams, etc.); passing the invoking
     * user's full access here would be a privilege escalation.
     */
    accessibleStreamIds?: string[]
    /** Declared conversation for an agent reply (roadmap 3.3); forwarded to event-service's synchronous assigner. */
    conversation?: ConversationDirective
  }) => {
    const initialMarkdown = normalizeMessage(params.content)
    const initialJson = parseMarkdown(initialMarkdown, undefined, toEmoji)
    // For agent-authored messages, pre-validate the structural pointers
    // (`shared-message:`, `quote:`, `attachment:`, `memo:`) and drop nodes
    // that wouldn't pass event-service's strict gate or point at a memo the
    // model invented. Without this, a single bad ref (out-of-scope stream,
    // deleted message, cross-workspace id) causes the entire message to fail
    // rather than just losing the pointer. The helper re-serializes the
    // cleaned tree to keep the wire markdown in sync with `contentJson`.
    let contentJson = initialJson
    let contentMarkdown = initialMarkdown
    if (params.accessibleStreamIds) {
      const stripped = await stripInaccessibleAgentRefs({
        pool,
        workspaceId: params.workspaceId,
        targetStreamId: params.streamId,
        accessibleStreamIds: params.accessibleStreamIds,
        contentJson: initialJson,
      })
      contentJson = stripped.contentJson
      contentMarkdown = stripped.contentMarkdown
    }
    // Surface inline `[name](attachment:id)` pointers so step 1 access checks
    // and step 6b `attachment_references` projection run. Without this, copy-
    // paste resends and recipients without source-stream access can't resolve
    // the download URL for an Ariadne resurfacing.
    const attachmentIds = collectAttachmentReferenceIds(contentJson)
    return eventService.createMessage({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson,
      contentMarkdown,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      sources: params.sources,
      sessionId: params.sessionId,
      clientMessageId: params.clientMessageId,
      accessibleStreamIds: params.accessibleStreamIds,
      conversation: params.conversation,
    })
  }
  const editMessage = async (params: {
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
    content: string
    /** Same semantics as `createMessage.accessibleStreamIds`. */
    accessibleStreamIds?: string[]
  }) => {
    const initialMarkdown = normalizeMessage(params.content)
    const initialJson = parseMarkdown(initialMarkdown, undefined, toEmoji)
    let contentJson = initialJson
    let contentMarkdown = initialMarkdown
    if (params.accessibleStreamIds) {
      const stripped = await stripInaccessibleAgentRefs({
        pool,
        workspaceId: params.workspaceId,
        targetStreamId: params.streamId,
        accessibleStreamIds: params.accessibleStreamIds,
        contentJson: initialJson,
      })
      contentJson = stripped.contentJson
      contentMarkdown = stripped.contentMarkdown
    }
    // Same as createMessage: derive attachmentIds from the cleaned JSON so
    // event-service can refresh the `attachment_references` projection in
    // sync with the new content (INV-7). Without this, an agent edit that
    // adds or removes an `attachment:` link leaves stale rows behind.
    const attachmentIds = collectAttachmentReferenceIds(contentJson)
    return eventService.editMessage({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      messageId: params.messageId,
      contentJson,
      contentMarkdown,
      actorId: params.actorId,
      actorType: "persona",
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      accessibleStreamIds: params.accessibleStreamIds,
    })
  }
  const deleteMessage = (params: { workspaceId: string; streamId: string; messageId: string; actorId: string }) =>
    eventService.deleteMessage({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      messageId: params.messageId,
      actorId: params.actorId,
      actorType: "persona",
    })
  const addReaction = (params: {
    workspaceId: string
    streamId: string
    messageId: string
    emoji: string
    actorId: string
  }) =>
    eventService.addReaction({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      messageId: params.messageId,
      emoji: params.emoji,
      userId: params.actorId,
      actorType: "persona",
    })
  const removeReaction = (params: {
    workspaceId: string
    streamId: string
    messageId: string
    emoji: string
    actorId: string
  }) =>
    eventService.removeReaction({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      messageId: params.messageId,
      emoji: params.emoji,
      userId: params.actorId,
      actorType: "persona",
    })
  const createThread = (params: Parameters<typeof streamService.createThread>[0]) => streamService.createThread(params)

  const activityService = new ActivityService({ pool })
  const syncService = new SyncService({ pool })
  const savedMessagesService = new SavedMessagesService({ pool })
  // Always constructed (accept/dismiss/list endpoints are AI-free); the
  // extractor only fires via the collector hook the memo pipeline calls, which
  // the stub memo service never invokes.
  const savedSuggestionsService = new SavedSuggestionsService({
    pool,
    extractor: new SuggestionExtractor(ai, configResolver),
    savedItemCreator: savedMessagesService,
  })
  const scheduledMessagesService = new ScheduledMessagesService({ pool, eventService })
  const agentFollowUpService = new AgentFollowUpService({ pool, workspaceSettingsService })
  const personaConfigService = new PersonaConfigService({
    pool,
    streamService,
    modelRegistry,
    attachmentService,
  })
  const streamBriefService = new StreamBriefService({ pool })
  const delegationService = new DelegationService({ pool })
  const draftsService = new DraftsService({ pool })
  const labelService = new LabelService({ pool })
  // PushService runs on pools.realtime so push delivery (outbox hot path) has
  // reserved DB capacity isolated from background workers. Subscription CRUD
  // endpoints also use this pool — low volume, plenty of headroom.
  const pushService = new PushService({
    pool: pools.realtime,
    vapidConfig: config.push.enabled
      ? {
          publicKey: config.push.vapidPublicKey,
          privateKey: config.push.vapidPrivateKey,
          subject: config.push.vapidSubject,
        }
      : null,
    lookups: {
      getUserNotificationLevel: async (workspaceId, userId) => {
        const prefs = await userPreferencesService.getPreferences(workspaceId, userId)
        return prefs.notificationLevel
      },
      isNotificationPaused: async (workspaceId, userId) => {
        // Single query (INV-30): the mapped user already masks an expired status
        // and an elapsed pause, so the shared resolver decides with delivery-time
        // `now` — one definition shared with the frontend badge (INV-35).
        const user = await UserRepository.findById(pool, workspaceId, userId)
        if (!user) return false
        return (
          resolveNotificationPause({
            statusEmoji: user.statusEmoji,
            statusText: user.statusText,
            statusExpiresAt: user.statusExpiresAt ? user.statusExpiresAt.toISOString() : null,
            statusPausesNotifications: user.statusPausesNotifications,
            notificationsPausedUntil: user.notificationsPausedUntil
              ? user.notificationsPausedUntil.toISOString()
              : null,
            notificationsPausedIndefinitely: user.notificationsPausedIndefinitely,
          }) !== null
        )
      },
      getStreamType: async (workspaceId, streamId) => {
        // StreamRepository.findById queries by ULID only; we verify workspace ownership
        // at the application layer (INV-8) — consistent with checkAccess in StreamService.
        const stream = await streamService.getStreamById(streamId)
        if (!stream || stream.workspaceId !== workspaceId) return null
        return stream.type
      },
      getWorkosUserId: async (workspaceId, userId) => {
        // Single query (INV-30): pass the pool directly, no withClient.
        const user = await UserRepository.findById(pool, workspaceId, userId)
        return user?.workosUserId ?? null
      },
    },
  })
  const systemMessageService = new SystemMessageService({ pool, createMessage })

  const commandRegistry = new CommandRegistry()
  commandRegistry.register(new InviteCommand({ pool, streamService }))

  // WorkOS validates API keys in production, stub in dev.
  const apiKeyService = config.useStubAuth ? new StubApiKeyService() : new WorkosApiKeyService(config.workos)
  const botChannelService = new BotChannelService({ pool })
  // Constructed after botChannelService: applying a label to a stream reuses the
  // actor's own access model, so the assignment service resolves bot reachability
  // through channel grants (users resolve through stream membership).
  const labelAssignmentService = new LabelAssignmentService({ pool, labelService, botChannelService })
  const labelMessageService = new LabelMessageService({ pool, botChannelService })

  // User-scoped API keys are managed by Threa, not WorkOS.
  const userApiKeyService = new UserApiKeyServiceImpl(pool)

  // Voice dictation — session lifecycle service + the realtime STT factory.
  // The factory only registers a provider strategy when its key is present
  // (empty string disables that provider); fail loudly later if a session is
  // opened with a model whose provider isn't configured (INV-11).
  const voiceTranscriptionService = new VoiceTranscriptionService(pool, userPreferencesService)
  const transcription = createTranscription({
    elevenlabs: config.ai.elevenLabsApiKey ? { apiKey: config.ai.elevenLabsApiKey } : undefined,
    deepgram: config.ai.deepgramApiKey ? { apiKey: config.ai.deepgramApiKey } : undefined,
    modelRegistry,
  })

  // Calls media plane — the CF Realtime SFU adapter (constructed only when the
  // app id + secret pair is configured; absent ⇒ calls surfaces answer 503
  // CALLS_UNAVAILABLE) and the transaction-owning CallService that proxies to it
  // CF-call-first, DB-write-second (INV-41). One instance shared by the HTTP
  // proxy routes, the /calls gateway, and the lease sweeper (INV-13).
  const cloudflareRealtime: RealtimeMediaApi | null = config.cloudflareRealtime.enabled
    ? new CloudflareRealtimeApi(config.cloudflareRealtime)
    : null
  const callService = new CallService({ pool, cloudflare: cloudflareRealtime })
  const callSweeper = createCallSweeper(callService)

  const botApiKeyService = new BotApiKeyService(pool)

  // Enclave runtime registry — register/heartbeat/revoke of enclave instance
  // keys (EIKs) plus the live-key read for SSK wrapping. Global (no
  // workspace_id) per INV-8's infra exception.
  const enclaveRuntimesService = new EnclaveRuntimesService(pool)

  // Serves the enclave's claim polls (§2.7 pull transport): hands a live EIK
  // the oldest claimable E2E turn it can decrypt, building the sealed
  // assignment at claim time. Routes mount only when the enclave credential
  // is configured.
  const enclaveClaimService = new EnclaveClaimService({ pool, storage, userPreferencesService })

  // Wake-up nudge for the claim long-poll (§2.7): holds one LISTEN connection
  // on `pools.listen` and fans each "invocation available" NOTIFY out to the
  // parked claim polls, so turn-start latency collapses from the idle poll
  // interval to ~immediate. Gated on the enclave credential, matching the claim
  // routes; null when the feature is off (claim then answers immediately).
  const enclaveClaimNudge = config.enclaveInternalApiKey ? new EnclaveClaimNudge({ listenPool: pools.listen }) : null

  // Bot runtime service — owns the outbox-emitting writes that drive the `/bot`
  // namespace. One instance shared between HTTP routes (claim/complete/fail)
  // and the WebSocket namespace handler (presence + bootstrap).
  const botRuntimeService = new BotRuntimeService({ pool, streamService, labelAssignmentService })

  // Workspace authz mirror service — shared by routes (middleware + handlers,
  // public API auth) and feature services that need to gate on workspace
  // permissions outside the request middleware chain.
  const workspaceAuthzService = new WorkspaceAuthzService({ pool })

  const workspaceIntegrationService = new WorkspaceIntegrationService({
    pool,
    github: config.github,
    linear: config.linear,
    region: config.region,
  })
  const linkPreviewService = new LinkPreviewService({ pool, streamService, memoExplorerService, delegationService })
  const giphyService = new GiphyService({ config: config.giphy })

  const isProduction = process.env.NODE_ENV === "production"
  const app = createApp({ corsAllowedOrigins: config.corsAllowedOrigins, isProduction })
  const server = createServer(app)
  const io = new SocketIOServer(server, {
    path: "/socket.io/",
    cors: {
      origin: createCorsOriginChecker(config.corsAllowedOrigins),
      credentials: true,
    },
  })
  io.adapter(createAdapter(pools.realtime))

  // Transport-agnostic bot-runtime background writes (presence/renew/steps).
  // One instance shared by the HTTP routes and the `/bot` WebSocket namespace
  // so both transports persist through the identical path (INV-13).
  const botRuntimeWriteOps = createBotRuntimeWriteOps({ pool, io, botRuntimeService, botChannelService })

  // Constructed here (not at the worker registration below) so the HTTP routes can
  // reach it for the on-demand conversation-split endpoints; the boundary-extract
  // worker reuses the same instance (INV-13).
  const boundaryExtractor = config.useStubBoundaryExtraction
    ? new StubBoundaryExtractor()
    : new LLMBoundaryExtractor(ai, configResolver)
  const boundaryExtractionService = new BoundaryExtractionService(pool, boundaryExtractor)

  registerRoutes(app, {
    pool,
    io,
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
    s3Config: config.s3,
    commandRegistry,
    avatarService,
    rateLimiterConfig: config.rateLimits,
    corsAllowedOrigins: config.corsAllowedOrigins,
    allowDevAuthRoutes: config.useStubAuth && !isProduction,
    internalApiKey: config.internalApiKey,
    enclaveInternalApiKey: config.enclaveInternalApiKey,
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
    callsCloudflareEnabled: config.cloudflareRealtime.enabled,
    enclaveRuntimesService,
    enclaveClaimService,
    enclaveClaimNudge,
    botApiKeyService,
    botRuntimeService,
    botRuntimeWriteOps,
    storage,
    ai,
    controlPlaneClient,
    costService,
    accessLogService,
  })

  app.use(errorHandler)

  const userSocketRegistry = new UserSocketRegistry()
  const sessionAbortRegistry = new SessionAbortRegistry()
  const botSocketRegistry = new BotSocketRegistry({
    // When the last socket for an instance disconnects, wait 30 s for a
    // reconnect (Wi-Fi blip, laptop lid). If nothing comes back, mark the
    // row offline so `target_instance_id`-pinned invocations stop being
    // routed to a dead runtime.
    graceMs: 30_000,
    onInstanceOffline: async (key, disconnectedAt) => {
      try {
        await BotRuntimeInstanceRepository.markOffline(pools.main, { ...key, disconnectedAt })
      } catch (err) {
        logger.error({ err, ...key }, "markOffline failed after grace window")
      }
    },
  })

  // Bot runtime namespace — runtimes authenticate with a `threa_bk_*` key and
  // get invocation pushes over WebSocket so they no longer poll the HTTP
  // claim endpoint every second.
  attachBotNamespace({
    io,
    botRuntimeService,
    botRuntimeWriteOps,
    botApiKeyService,
    botSocketRegistry,
    accessLogService,
  })

  registerSocketHandlers(io, {
    pool,
    authService,
    streamService,
    pushService,
    workspaceService,
    userSocketRegistry,
    sessionAbortRegistry,
    jobQueue,
    accessLogService,
  })

  // Dedicated voice relay on its own namespace so audio frames don't share the
  // main namespace's room fan-out.
  const polishTranscript = createPolishTranscript({ ai })
  registerVoiceGateway(io, {
    authService,
    voiceTranscriptionService,
    transcription,
    userPreferencesService,
    workspaceSettingsService,
    polishTranscript,
  })

  // Dedicated /calls control namespace (mirrors the /voice gateway shape). Media
  // negotiation rides the HTTPS CF proxy, not this socket; this carries only
  // small control events (join/leave/state/lease renew) and the roster fan-out.
  registerCallGateway(io, {
    authService,
    callService,
    workspaceSettingsService,
    pool,
    cloudflareEnabled: config.cloudflareRealtime.enabled,
  })

  const serverId = `server_${ulid()}`

  // Memo (GAM) processing — batched extraction, heavy LLM work. Constructed
  // before PersonaAgent so the companion's save_memo callback can bind to it.
  const memoService = config.useStubAI
    ? new StubMemoService()
    : new MemoService({
        pool,
        classifier: new MemoClassifier(ai, configResolver, messageFormatter),
        memorizer: new Memorizer(ai, configResolver, messageFormatter),
        embeddingService,
        messageFormatter,
        // Passive to-do collection rides the classifier flag on each settled
        // conversation (INV-52 — the capability, not the concrete service).
        suggestionCollector: savedSuggestionsService,
      })

  const workspaceAgent = new WorkspaceAgent({ pool, ai, configResolver, embeddingService })

  // General researcher: bounded multi-surface research (workspace + web +
  // integrations) driving the persona's primitive tools. Stateless beyond ai +
  // config; per-request tools/context arrive via PersonaAgent.
  const generalResearcher = new GeneralResearcher({ ai, configResolver })

  const traceEmitter = new TraceEmitter({ io, pool })
  const conversationSummaryService = new ConversationSummaryService({
    ai,
    modelId: COMPANION_SUMMARY_MODEL_ID,
    temperature: COMPANION_SUMMARY_TEMPERATURE,
  })
  const episodeSummaryService = new EpisodeSummaryService({
    pool,
    ai,
    modelId: EPISODE_SUMMARY_MODEL_ID,
    temperature: EPISODE_SUMMARY_TEMPERATURE,
    maxTokens: EPISODE_SUMMARY_MAX_TOKENS,
  })
  // Reflective session capture reuses the memo pipeline (classify + memorize +
  // write) via memoService — a second caller, not a second pipeline (roadmap 6.3).
  const reflectiveCaptureService = new ReflectiveCaptureService({ pool, memoService })

  const personaAgent = new PersonaAgent({
    pool,
    ai,
    traceEmitter,
    sessionAbortRegistry,
    userPreferencesService,
    workspaceAgent,
    generalResearcher,
    searchService,
    conversationSummaryService,
    attachmentService,
    memoExplorerService,
    storage,
    modelRegistry,
    workspaceIntegrationService,
    tavilyApiKey: config.ai.tavilyApiKey || undefined,
    stubResponse: config.useStubCompanion
      ? "This is a stub response from the companion. The real AI integration is disabled."
      : undefined,
    createMessage,
    editMessage,
    deleteMessage,
    addReaction,
    removeReaction,
    createThread,
    scheduleFollowUp: async ({
      workspaceId,
      streamId,
      personaId,
      sessionId,
      sourceConversationId,
      note,
      scheduledFor,
    }) => {
      const result = await agentFollowUpService.schedule({
        workspaceId,
        streamId,
        personaId,
        sessionId,
        sourceConversationId,
        note,
        scheduledFor,
      })
      return result.ok
        ? {
            ok: true,
            followUpId: result.followUp.id,
            scheduledFor: result.followUp.scheduledFor,
            pendingCount: result.pendingCount,
            limit: result.limit,
          }
        : { ok: false, reason: "cap_reached", pendingCount: result.pendingCount, limit: result.limit }
    },
    listFollowUps: async ({ workspaceId, streamId }) => {
      const rows = await agentFollowUpService.listPending({ workspaceId, streamId })
      return rows.map((r) => ({ followUpId: r.id, note: r.note, scheduledFor: r.scheduledFor }))
    },
    cancelFollowUp: async ({ workspaceId, streamId, followUpId }) => {
      const cancelled = await agentFollowUpService.cancel({ workspaceId, streamId, id: followUpId })
      return cancelled ? { ok: true, followUpId: cancelled.id } : { ok: false }
    },
    updateFollowUp: async ({ workspaceId, streamId, followUpId, note, scheduledFor }) => {
      const result = await agentFollowUpService.update({ workspaceId, streamId, id: followUpId, note, scheduledFor })
      return result.ok
        ? {
            ok: true,
            followUpId: result.followUp.id,
            note: result.followUp.note,
            scheduledFor: result.followUp.scheduledFor,
          }
        : { ok: false, reason: result.reason }
    },
    loadFollowUp: ({ workspaceId, followUpId }) => agentFollowUpService.getById({ workspaceId, followUpId }),
    updateBrief: async ({ workspaceId, streamId, personaId, content, reason, expectedVersion }) => {
      const result = await streamBriefService.update({
        workspaceId,
        streamId,
        content,
        expectedVersion,
        updatedByKind: AuthorTypes.PERSONA,
        updatedById: personaId,
        reason,
      })
      return result.outcome === "updated"
        ? { ok: true, version: result.brief.version }
        : {
            ok: false,
            reason: "version_conflict",
            currentContent: result.current?.content ?? null,
            currentVersion: result.current?.version ?? 0,
          }
    },
    delegateTask: async ({
      workspaceId,
      streamId,
      personaId,
      sessionId,
      sourceConversationId,
      accessibleStreamIds,
      title,
      brief,
      contextRefs,
    }) => {
      // Refs the invoking user can't read never reach the row (the #1118
      // access ruling); the drops ride back so the model can correct them.
      const { accepted, dropped } = await validateDelegationContextRefs({
        pool,
        workspaceId,
        accessibleStreamIds,
        refs: contextRefs,
      })
      const delegation = await delegationService.create({
        workspaceId,
        streamId,
        sessionId,
        sourceConversationId,
        createdByKind: AuthorTypes.PERSONA,
        createdById: personaId,
        title,
        brief,
        contextRefs: accepted,
      })
      return { ok: true, delegationId: delegation.id, droppedRefs: dropped }
    },
    saveMemo: async ({
      workspaceId,
      streamId,
      sessionId,
      sourceStreamIds,
      title,
      abstract,
      keyPoints,
      tags,
      knowledgeType,
      sourceMessageIds,
      invokingUserId,
      scope,
    }) => {
      const result = await memoService.saveMemo({
        workspaceId,
        streamId,
        sessionId,
        sourceStreamIds,
        title,
        abstract,
        keyPoints,
        tags,
        knowledgeType,
        sourceMessageIds,
        invokingUserId,
        scope,
      })
      return result.ok
        ? { ok: true, memoId: result.memoId, title: result.title, deduped: result.deduped }
        : { ok: false }
    },
  })
  // Tier assignments (see QueueManager `tiers` config above):
  //  - INTERACTIVE: user-facing work that must drain quickly (agent responses,
  //    slash commands). Highest priority, biggest per-queue share.
  //  - LIGHT: fast background jobs without blocking LLM/IO (naming, embeddings,
  //    link previews, avatar processing).
  //  - HEAVY: slow IO- or CPU-bound jobs (document / image / memo processing).
  //    Capped low so they can't monopolize pool connections.
  //
  // Fairness defaults to `none` — region sharding already isolates tenants,
  // so a single workspace burst can use the full tier budget.
  const personaAgentWorker = createPersonaAgentWorker({ agent: personaAgent, serverId, pool, jobQueue })
  jobQueue.registerHandler(JobQueues.PERSONA_AGENT, personaAgentWorker, {
    tier: QueueTiers.INTERACTIVE,
    fairness: QueueFairness.NONE,
  })

  // Context-bag pre-compute worker — warms the shared summary cache and
  // persists the initial render snapshot for newly-created bag-attached
  // scratchpads so the first real user turn hits the cache. Posts no
  // messages and runs without a persona or session.
  const contextBagPrecomputeWorker = createContextBagPrecomputeWorker({ pool, ai })
  jobQueue.registerHandler(JobQueues.CONTEXT_BAG_PRECOMPUTE, contextBagPrecomputeWorker, {
    tier: QueueTiers.INTERACTIVE,
    fairness: QueueFairness.NONE,
  })

  const namingWorker = createNamingWorker({ streamNamingService })
  jobQueue.registerHandler(JobQueues.NAMING_GENERATE, namingWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  const embeddingWorker = createEmbeddingWorker({ pool, embeddingService })
  jobQueue.registerHandler(JobQueues.EMBEDDING_GENERATE, embeddingWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Attachment summary embeddings — same tier as message embeddings (LIGHT,
  // single network call to the embedding provider, no heavy local work).
  const attachmentEmbeddingWorker = createAttachmentEmbeddingWorker({ pool, embeddingService })
  jobQueue.registerHandler(JobQueues.ATTACHMENT_EMBED, attachmentEmbeddingWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  const boundaryExtractionWorker = createBoundaryExtractionWorker({ service: boundaryExtractionService })
  jobQueue.registerHandler(JobQueues.BOUNDARY_EXTRACT, boundaryExtractionWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Cron-driven fade for conversations the extractor's window can no longer
  // see (active → stalled → resolved on idle). No AI involved.
  const stalenessSweepWorker = createStalenessSweepWorker({ pool })
  jobQueue.registerHandler(JobQueues.CONVERSATION_STALENESS_SWEEP, stalenessSweepWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Safety net for reserved background uploads whose client died without
  // reporting failure: stale rows flip to failed/abandoned and never-bound
  // zombies are deleted. Pure SQL + S3 deletes, no AI.
  const attachmentUploadSweepWorker = createAttachmentUploadSweepWorker({ attachmentService })
  jobQueue.registerHandler(JobQueues.ATTACHMENT_UPLOAD_SWEEP, attachmentUploadSweepWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  const memoBatchCheckWorker = createMemoBatchCheckWorker({ pool, memoService, jobQueue })
  const memoBatchProcessWorker = createMemoBatchProcessWorker({ pool, memoService, jobQueue })
  // memo.batch-check is a lightweight cron-driven dispatcher; the actual heavy
  // work is memo.batch-process. Keep fairness=workspace on batch-process so
  // one noisy workspace's memo backlog doesn't monopolize the heavy tier.
  jobQueue.registerHandler(JobQueues.MEMO_BATCH_CHECK, memoBatchCheckWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })
  jobQueue.registerHandler(JobQueues.MEMO_BATCH_PROCESS, memoBatchProcessWorker, {
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.WORKSPACE,
  })

  // Command execution worker — user-triggered, must feel snappy
  const commandWorker = createCommandWorker({ pool, commandRegistry })
  jobQueue.registerHandler(JobQueues.COMMAND_EXECUTE, commandWorker, {
    tier: QueueTiers.INTERACTIVE,
    fairness: QueueFairness.NONE,
  })

  const imageCaptionService = config.useStubAI
    ? new StubImageCaptionService(pool)
    : new ImageCaptionService({ pool, ai, storage })
  const imageCaptionWorker = createImageCaptionWorker({ imageCaptionService })
  const imageCaptionOnDLQ: OnDLQHook<ImageCaptionJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
  }
  jobQueue.registerHandler(JobQueues.IMAGE_CAPTION, imageCaptionWorker, {
    hooks: { onDLQ: imageCaptionOnDLQ },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  // Image thumbnail worker — independent of captioning so a caption failure
  // never costs the thumbnail. Pure sharp + S3 work with no AI dependency, so
  // it is not gated behind useStubAI. No onDLQ: thumbnail failure is non-fatal
  // (the raw image still serves via the ?variant=thumbnail fallback) and must
  // not touch processing_status, which the extraction pipeline owns.
  const imageThumbnailService = new ImageThumbnailService({ pool, storage })
  const imageThumbnailWorker = createImageThumbnailWorker({ imageThumbnailService })
  jobQueue.registerHandler(JobQueues.IMAGE_THUMBNAIL, imageThumbnailWorker, {
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  const pdfProcessingService = config.useStubAI
    ? new StubPdfProcessingService({ pool })
    : new PdfProcessingService({ pool, ai, storage, jobQueue })
  const pdfPrepareWorker = createPdfPrepareWorker({ pdfProcessingService })
  const pdfPageWorker = createPdfPageWorker({ pdfProcessingService })
  const pdfAssembleWorker = createPdfAssembleWorker({ pdfProcessingService })
  const pdfOnDLQ: OnDLQHook<PdfPrepareJobData | PdfProcessPageJobData | PdfAssembleJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
  }
  jobQueue.registerHandler(JobQueues.PDF_PREPARE, pdfPrepareWorker, {
    hooks: { onDLQ: pdfOnDLQ as OnDLQHook<PdfPrepareJobData> },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })
  jobQueue.registerHandler(JobQueues.PDF_PROCESS_PAGE, pdfPageWorker, {
    hooks: { onDLQ: pdfOnDLQ as OnDLQHook<PdfProcessPageJobData> },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })
  jobQueue.registerHandler(JobQueues.PDF_ASSEMBLE, pdfAssembleWorker, {
    hooks: { onDLQ: pdfOnDLQ as OnDLQHook<PdfAssembleJobData> },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  const textProcessingService = config.useStubAI
    ? new StubTextProcessingService({ pool })
    : new TextProcessingService({ pool, ai, storage })
  const textProcessingWorker = createTextProcessingWorker({ textProcessingService })
  const textOnDLQ: OnDLQHook<TextProcessJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
  }
  jobQueue.registerHandler(JobQueues.TEXT_PROCESS, textProcessingWorker, {
    hooks: { onDLQ: textOnDLQ },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  const wordProcessingService = config.useStubAI
    ? new StubWordProcessingService({ pool })
    : new WordProcessingService({ pool, ai, storage })
  const wordProcessingWorker = createWordProcessingWorker({ wordProcessingService })
  const wordOnDLQ: OnDLQHook<WordProcessJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
  }
  jobQueue.registerHandler(JobQueues.WORD_PROCESS, wordProcessingWorker, {
    hooks: { onDLQ: wordOnDLQ },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  const excelProcessingService = config.useStubAI
    ? new StubExcelProcessingService({ pool })
    : new ExcelProcessingService({ pool, ai, storage })
  const excelProcessingWorker = createExcelProcessingWorker({ excelProcessingService })
  const excelOnDLQ: OnDLQHook<ExcelProcessJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
  }
  jobQueue.registerHandler(JobQueues.EXCEL_PROCESS, excelProcessingWorker, {
    hooks: { onDLQ: excelOnDLQ },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  const videoTranscodingService = config.mediaConvert.enabled
    ? new VideoTranscodingService({
        pool,
        mediaConvertClient: new ThreaMediaConvertClient({
          s3Config: config.s3,
          mediaConvertConfig: config.mediaConvert,
        }),
        s3Config: config.s3,
      })
    : new StubVideoTranscodingService(pool)
  const videoSubmitWorker = createVideoTranscodeSubmitWorker({ videoTranscodingService, jobQueue })
  const videoCheckWorker = createVideoTranscodeCheckWorker({ videoTranscodingService, jobQueue })
  const videoOnDLQ: OnDLQHook<VideoTranscodeSubmitJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
    const videoJob = await VideoTranscodeJobRepository.findByAttachmentId(querier, job.data.attachmentId)
    if (videoJob) {
      await VideoTranscodeJobRepository.updateFailed(querier, videoJob.id, "Moved to DLQ after exhausting retries")
    }
    const att = await AttachmentRepository.findById(querier, job.data.attachmentId)
    await OutboxRepository.insert(querier, "attachment:transcoded", {
      workspaceId: job.data.workspaceId,
      ...(att?.streamId && { streamId: att.streamId }),
      ...(att?.messageId && { messageId: att.messageId }),
      attachmentId: job.data.attachmentId,
      processingStatus: ProcessingStatuses.FAILED,
    })
  }
  const videoCheckOnDLQ: OnDLQHook<VideoTranscodeCheckJobData> = async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
    const videoJob = await VideoTranscodeJobRepository.findByAttachmentId(querier, job.data.attachmentId)
    if (videoJob) {
      await VideoTranscodeJobRepository.updateFailed(
        querier,
        videoJob.id,
        "Check job moved to DLQ after exhausting retries"
      )
    }
    const att = await AttachmentRepository.findById(querier, job.data.attachmentId)
    await OutboxRepository.insert(querier, "attachment:transcoded", {
      workspaceId: job.data.workspaceId,
      ...(att?.streamId && { streamId: att.streamId }),
      ...(att?.messageId && { messageId: att.messageId }),
      attachmentId: job.data.attachmentId,
      processingStatus: ProcessingStatuses.FAILED,
    })
  }
  jobQueue.registerHandler(JobQueues.VIDEO_TRANSCODE_SUBMIT, videoSubmitWorker, {
    hooks: { onDLQ: videoOnDLQ },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })
  jobQueue.registerHandler(JobQueues.VIDEO_TRANSCODE_CHECK, videoCheckWorker, {
    hooks: { onDLQ: videoCheckOnDLQ },
    tier: QueueTiers.HEAVY,
    fairness: QueueFairness.NONE,
  })

  // Avatar processing worker — fast image resize, not LLM-bound
  const avatarProcessingService = new AvatarProcessingService(pool, avatarService)
  const avatarProcessWorker = createAvatarProcessWorker({ avatarProcessingService })
  const avatarProcessOnDLQ = createAvatarProcessOnDLQ()
  jobQueue.registerHandler(JobQueues.AVATAR_PROCESS, avatarProcessWorker, {
    hooks: { onDLQ: avatarProcessOnDLQ },
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Link preview worker — fast HTTP fetch, not LLM-bound
  const linkPreviewWorker = createLinkPreviewWorker({ linkPreviewService, workspaceIntegrationService })
  jobQueue.registerHandler(JobQueues.LINK_PREVIEW_EXTRACT, linkPreviewWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // GitHub webhook worker — resolves workspaces by installation, force-refreshes
  // matching link previews via GitHub fetch (fast HTTP, not LLM-bound)
  const githubWebhookWorker = createGithubWebhookWorker({
    pool,
    linkPreviewService,
    workspaceIntegrationService,
    jobQueue,
  })
  jobQueue.registerHandler(JobQueues.GITHUB_WEBHOOK_PROCESS, githubWebhookWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Trailing GitHub preview refresh — coalesces a webhook storm's dropped
  // (debounced) refresh into one refresh once the debounce window clears
  const githubPreviewRefreshWorker = createGithubPreviewRefreshWorker({
    linkPreviewService,
    workspaceIntegrationService,
    jobQueue,
  })
  jobQueue.registerHandler(JobQueues.GITHUB_PREVIEW_REFRESH, githubPreviewRefreshWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Viewport-nudged preview refresh — conditional (ETag-gated) GitHub fetch,
  // best-effort with no retry chain (the visible card re-nudges)
  const linkPreviewVisibleRefreshWorker = createLinkPreviewVisibleRefreshWorker({
    linkPreviewService,
    workspaceIntegrationService,
  })
  jobQueue.registerHandler(JobQueues.LINK_PREVIEW_VISIBLE_REFRESH, linkPreviewVisibleRefreshWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Saved message reminder worker — delegates to service, no long I/O
  const savedReminderWorker = createSavedReminderWorker({ savedMessagesService })
  jobQueue.registerHandler(JobQueues.SAVED_REMINDER_FIRE, savedReminderWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Scheduled message send worker — fires due messages via EventService.createMessage
  const scheduledMessageSendWorker = createScheduledMessageSendWorker({ scheduledMessagesService })
  jobQueue.registerHandler(JobQueues.SCHEDULED_MESSAGE_SEND, scheduledMessageSendWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Generic backfill framework. Register definitions BEFORE the workers can run
  // so a redelivered plan/chunk job can always resolve its definition by name.
  registerMentionBackfill()
  registerGithubInstallationBackfill({ workspaceIntegrationService })
  jobQueue.registerHandler(JobQueues.BACKFILL_PLAN, createBackfillPlanWorker({ pool }), {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })
  jobQueue.registerHandler(JobQueues.BACKFILL_CHUNK, createBackfillChunkWorker({ pool }), {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Agent follow-up fire worker — CASes a due follow-up `pending → fired` and
  // enqueues the persona turn (roadmap 1.1). A fire job that never commits the
  // CAS (e.g. repeated enqueue failures) leaves the row `pending` and retries;
  // once it exhausts retries the DLQ hook marks it `failed` so it stops looking
  // schedulable.
  const agentFollowUpFireWorker = createAgentFollowUpFireWorker({ agentFollowUpService })
  const agentFollowUpOnDLQ: OnDLQHook<AgentFollowUpFireJobData> = async (querier, job, error) => {
    await AgentFollowUpRepository.markFailed(querier, job.data.workspaceId, job.data.followUpId, error.message)
  }
  jobQueue.registerHandler(JobQueues.AGENT_FOLLOW_UP_FIRE, agentFollowUpFireWorker, {
    hooks: { onDLQ: agentFollowUpOnDLQ },
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Episode-summary worker — condenses a completed companion session into its
  // `episode_summary` for later "Previous sessions" context (roadmap 3.1). Cheap
  // background LLM work, so it rides the light tier; a redelivered job no-ops via
  // the `setEpisodeSummary` CAS.
  const episodeSummarizeWorker = createEpisodeSummarizeWorker({ episodeSummaryService })
  jobQueue.registerHandler(JobQueues.AGENT_EPISODE_SUMMARIZE, episodeSummarizeWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Reflective-capture worker — distils a research-heavy completed session into
  // ≤2 agent-authored memos so research work products don't evaporate with the
  // turn (roadmap 6.3). Light tier; a redelivered job no-ops via the
  // `reflective_captured_at` CAS.
  const reflectiveCaptureWorker = createReflectiveCaptureWorker({ reflectiveCaptureService })
  jobQueue.registerHandler(JobQueues.AGENT_REFLECTIVE_CAPTURE, reflectiveCaptureWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  await jobQueue.start()

  scheduleManager.start()
  cleanupWorker.start()
  agentSessionMetrics.start()
  // Reaps lapsed endpoint leases (→ left/empty_grace), expires stale rings, ends
  // graced calls, and closes the CF sessions of reaped endpoints — every 15s
  // (the lease-reap heartbeat vs the 45s TTL). In-process interval per instance
  // (matching the sweepers above) so every instance reaps; each stage is
  // idempotent CAS, so concurrent instance sweeps don't double-act.
  callSweeper.start()

  // payload workspaceId "system" = system-wide check; schedule workspaceId null = global schedule
  if (!config.useStubAI) {
    await jobQueue.schedule(JobQueues.MEMO_BATCH_CHECK, 30, { workspaceId: "system" }, null)
  }
  // Status fade is pure SQL (no AI), but stays off in stub/test stacks so
  // long-running e2e fixtures never fade mid-test.
  if (!config.useStubAI) {
    await jobQueue.schedule(JobQueues.CONVERSATION_STALENESS_SWEEP, 600, { workspaceId: "system" }, null)
  }
  // Stale-upload thresholds are hours/days, so this can't interfere with
  // test fixtures — safe to run everywhere.
  await jobQueue.schedule(JobQueues.ATTACHMENT_UPLOAD_SWEEP, 900, { workspaceId: "system" }, null)

  // Outbox dispatcher - single LISTEN connection fans out to all handlers
  const outboxDispatcher = new OutboxDispatcher({
    listenPool: pools.listen,
    fallbackPollMs: Number(process.env.OUTBOX_FALLBACK_POLL_MS) || 2000,
  })

  // Real-time delivery handlers (broadcast, push) use a dedicated `pools.realtime`
  // so a saturated main pool (AI workers, file processing, embeddings) can never
  // starve socket.io broadcasts or push notifications. All other outbox handlers
  // use the main pool — they enqueue jobs and can tolerate back-pressure.
  // `io.of("/bot")` is idempotent — `attachBotNamespace` already created
  // this namespace above; we resolve it once and hand it to the broadcaster
  // so bot-event dispatch doesn't repeat the lookup per event.
  const botNamespace = io.of("/bot")
  const broadcastHandler = new BroadcastHandler(pools.realtime, io, botNamespace)
  const companionHandler = new CompanionHandler(pool, jobQueue)
  // Mirrors CompanionHandler for E2E streams: enqueue a claimable enclave
  // invocation per user turn when the enclave actor is invited (§2.7 pull
  // transport — the enclave polls for these). Gated on the enclave credential,
  // matching the claim/callback routes.
  const enclaveDispatchHandler = config.enclaveInternalApiKey ? new EnclaveDispatchHandler(pool) : null
  const contextBagPrecomputeHandler = new ContextBagPrecomputeHandler(pool, jobQueue)
  const namingHandler = new NamingHandler(pool, jobQueue)
  const emojiUsageHandler = new EmojiUsageHandler(pool)
  const embeddingHandler = new EmbeddingHandler(pool, jobQueue)
  const boundaryExtractionHandler = new BoundaryExtractionHandler(pool, jobQueue)
  const memoAccumulatorHandler = new MemoAccumulatorHandler(pool)
  const commandHandler = new CommandHandler(pool, jobQueue)
  const mentionInvokeHandler = new MentionInvokeHandler(pool, jobQueue)
  const agentMessageMutationHandler = new AgentMessageMutationHandler(pool, jobQueue, eventService)
  const attachmentUploadedHandler = new AttachmentUploadedHandler(pool, jobQueue)
  const attachmentEmbeddingHandler = new AttachmentEmbeddingHandler(pool, jobQueue)
  const systemMessageOutboxHandler = new SystemMessageOutboxHandler(pool, systemMessageService)
  const activityFeedHandler = new ActivityFeedHandler(pool, activityService)
  const botInvocationOutboxHandler = new BotInvocationOutboxHandler(pool, eventService)
  const pushNotificationHandler = pushService.isEnabled()
    ? new PushNotificationHandler({ pool: pools.realtime, pushService })
    : null
  const linkPreviewOutboxHandler = new LinkPreviewOutboxHandler(pool, jobQueue)
  const shadowSyncHandler =
    controlPlaneClient && config.region
      ? new InvitationShadowSyncHandler(pool, controlPlaneClient, config.region)
      : null
  // Registered whenever a region is set (matching the service's event-emit gate),
  // so every `github_route:*` event has a consumer. The service emits those events
  // on region alone, so a null control-plane client leaves the handler a no-op that
  // silently swallows emitted events — warn so the misconfiguration is visible.
  if (config.region && !controlPlaneClient) {
    logger.warn(
      "Region is set but no control-plane client is configured (missing controlPlaneUrl/internalApiKey) — GitHub route-sync events will be swallowed and installations won't register webhook routes"
    )
  }
  const githubRouteSyncHandler = config.region ? new GithubRouteSyncHandler(pool, controlPlaneClient) : null
  const outboxHandlers: (OutboxHandler & { ensureListener(): Promise<void> })[] = [
    broadcastHandler,
    companionHandler,
    contextBagPrecomputeHandler,
    namingHandler,
    emojiUsageHandler,
    embeddingHandler,
    boundaryExtractionHandler,
    memoAccumulatorHandler,
    commandHandler,
    mentionInvokeHandler,
    agentMessageMutationHandler,
    attachmentUploadedHandler,
    attachmentEmbeddingHandler,
    systemMessageOutboxHandler,
    activityFeedHandler,
    botInvocationOutboxHandler,
    linkPreviewOutboxHandler,
    ...(enclaveDispatchHandler ? [enclaveDispatchHandler] : []),
    ...(pushNotificationHandler ? [pushNotificationHandler] : []),
    ...(shadowSyncHandler ? [shadowSyncHandler] : []),
    ...(githubRouteSyncHandler ? [githubRouteSyncHandler] : []),
  ]

  for (const handler of outboxHandlers) {
    await handler.ensureListener()
    outboxDispatcher.register(handler)
  }

  // Outbox retention lifecycle - purge rows safe for all active listeners
  const outboxRetentionWorker = new OutboxRetentionWorker(pool, {
    listenerIds: outboxHandlers.map((handler) => handler.listenerId),
    intervalMs: Number(process.env.OUTBOX_RETENTION_INTERVAL_MS) || 300000,
    retentionMs: Number(process.env.OUTBOX_RETENTION_WINDOW_MS) || 7 * 24 * 60 * 60 * 1000,
    batchSize: Number(process.env.OUTBOX_RETENTION_BATCH_SIZE) || 1000,
    maxBatchesPerRun: Number(process.env.OUTBOX_RETENTION_MAX_BATCHES_PER_RUN) || 10,
  })

  const queueRetentionWorker = new QueueRetentionWorker(pool, {
    intervalMs: Number(process.env.QUEUE_RETENTION_INTERVAL_MS) || 3600000,
    completedRetentionMs: Number(process.env.QUEUE_RETENTION_COMPLETED_MS) || 7 * 24 * 60 * 60 * 1000,
    cancelledRetentionMs: Number(process.env.QUEUE_RETENTION_CANCELLED_MS) || 30 * 24 * 60 * 60 * 1000,
    dlqRetentionMs: Number(process.env.QUEUE_RETENTION_DLQ_MS) || 90 * 24 * 60 * 60 * 1000,
    batchSize: Number(process.env.QUEUE_RETENTION_BATCH_SIZE) || 5000,
    maxBatchesPerRun: Number(process.env.QUEUE_RETENTION_MAX_BATCHES_PER_RUN) || 20,
  })

  // Keeps access_log's monthly partitions provisioned ahead and drops expired
  // ones (13-month retention). Idempotent, so it runs on every pod.
  const accessLogPartitionWorker = new PartitionMaintenanceWorker(pool, {
    parentTable: "access_log",
    retainMonths: Number(process.env.ACCESS_LOG_RETENTION_MONTHS) || 13,
    aheadMonths: Number(process.env.ACCESS_LOG_PARTITION_AHEAD_MONTHS) || 2,
    intervalMs: Number(process.env.ACCESS_LOG_PARTITION_INTERVAL_MS) || 6 * 60 * 60 * 1000,
  })

  // Start single LISTEN connection that notifies all handlers
  await outboxDispatcher.start()
  outboxRetentionWorker.start()
  queueRetentionWorker.start()
  accessLogPartitionWorker.start()

  // Wake-up nudge LISTEN for the enclave claim long-poll (§2.7).
  await enclaveClaimNudge?.start()

  // Correctness net for the sync-log spine: rescues client-routed outbox
  // events the dispatcher missed (gap skip, crash) into sync_log + a late emit
  const syncLogReconciliationWorker = new SyncLogReconciliationWorker(
    { pool, io },
    {
      intervalMs: Number(process.env.SYNC_LOG_SWEEP_INTERVAL_MS) || undefined,
      delayMs: Number(process.env.SYNC_LOG_SWEEP_DELAY_MS) || undefined,
    }
  )
  await syncLogReconciliationWorker.start()

  // Broadcasts each workspace's sync-log head to its room so active-mode
  // clients detect dropped emits between reconnect/resume triggers
  const syncHeartbeatWorker = new SyncHeartbeatWorker(
    { pool, io },
    { intervalMs: Number(process.env.SYNC_HEARTBEAT_INTERVAL_MS) || undefined }
  )
  syncHeartbeatWorker.start()

  // Bounds sync_log growth: prunes entries past the retention horizon (keeping
  // a per-workspace recent floor) and advances the retention watermark that
  // catch-up reads to signal a full bootstrap for cursors below it
  const syncLogRetentionWorker = new SyncLogRetentionWorker(
    { pool },
    {
      intervalMs: Number(process.env.SYNC_LOG_RETENTION_INTERVAL_MS) || undefined,
      retentionMs: Number(process.env.SYNC_LOG_RETENTION_MS) || undefined,
      minKeep: Number(process.env.SYNC_LOG_RETENTION_MIN_KEEP) || undefined,
    }
  )
  syncLogRetentionWorker.start()

  const orphanSessionCleanup = createOrphanSessionCleanup(pools.main, io)
  orphanSessionCleanup.start()

  const delegationExpirySweep = createDelegationExpirySweep(delegationService)
  delegationExpirySweep.start()

  const pushSessionCleanup = createPushSessionCleanup(pushService)
  pushSessionCleanup.start()

  // Safety net for voice sessions the in-process max-duration timer never
  // finalized (crash/restart, or an HTTP-created session whose socket never
  // connected): sweep them to `expired` so they don't linger active.
  const voiceSessionSweeper = createVoiceSessionSweeper(voiceTranscriptionService)
  voiceSessionSweeper.start()

  await new Promise<void>((resolve) => {
    server.listen(config.port, "0.0.0.0", () => {
      logger.info({ port: config.port }, "Server started")
      resolve()
    })
  })

  const stop = async () => {
    if (config.fastShutdown) {
      logger.info("Fast shutdown mode - skipping graceful shutdown")
      server.close()
      io.close()
      // Skip pool cleanup; process exit terminates connections
      return
    }

    logger.info("Shutting down server...")
    poolMonitor.stop()
    orphanSessionCleanup.stop()
    delegationExpirySweep.stop()
    pushSessionCleanup.stop()
    voiceSessionSweeper.stop()
    callSweeper.stop()
    agentSessionMetrics.stop()
    await scheduleManager.stop()
    await cleanupWorker.stop()
    await outboxRetentionWorker.stop()
    await queueRetentionWorker.stop()
    await accessLogPartitionWorker.stop()
    await syncLogReconciliationWorker.stop()
    await syncHeartbeatWorker.stop()
    await syncLogRetentionWorker.stop()
    await outboxDispatcher.stop()
    await enclaveClaimNudge?.stop()
    await jobQueue.stop()
    logger.info("Closing socket.io...")

    // Timeout since io.close() can hang with the postgres adapter
    await Promise.race([
      new Promise<void>((resolve) => io.close(() => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          logger.warn("Socket.io close timed out, continuing...")
          resolve()
        }, 5000)
      ),
    ])

    logger.info("Closing HTTP server...")
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
    logger.info("Closing database pools...")
    // Final responses/disconnects fire-and-forget audit rows; bounded drain so
    // they don't lose the race against pool.end().
    await accessLogService.drain()
    await pools.listen.end()
    await pools.realtime.end()
    await pools.main.end()
    logger.info("Server stopped")
  }

  return { server, io, pools, jobQueue, poolMonitor, port: config.port, fastShutdown: config.fastShutdown, stop }
}
