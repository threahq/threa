import { createServer, Server } from "http"
import { Server as SocketIOServer } from "socket.io"
import { createAdapter } from "@socket.io/postgres-adapter"
import { Pool } from "pg"
import { createApp } from "./app"
import { registerRoutes } from "./routes"
import { errorHandler } from "./middleware/error-handler"
import { registerSocketHandlers } from "./socket"
import { createDatabasePools, warmPool, type DatabasePools } from "./db"
import { runMigrations } from "./db/migrations"
import { WorkosAuthService, StubAuthService, WorkosApiKeyService, StubApiKeyService } from "@threa/backend-common"
import { BotChannelService } from "./features/api-keys"
import { UserApiKeyService as UserApiKeyServiceImpl } from "./features/user-api-keys"
import { BotApiKeyService } from "./features/public-api"
import { LinkPreviewService, LinkPreviewOutboxHandler, createLinkPreviewWorker } from "./features/link-previews"
import { WorkspaceIntegrationService } from "./features/workspace-integrations"
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
import {
  StreamService,
  StreamNamingService,
  StubStreamNamingService,
  NamingHandler,
  createNamingWorker,
} from "./features/streams"
import { EventService } from "./features/messaging"
import { AttachmentService } from "./features/attachments"
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
  BoundaryExtractionService,
  BoundaryExtractionHandler,
  createBoundaryExtractionWorker,
  LLMBoundaryExtractor,
  StubBoundaryExtractor,
} from "./features/conversations"
import { UserPreferencesService } from "./features/user-preferences"
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
  WorkspaceAgent,
  PersonaAgent,
  TraceEmitter,
  SessionAbortRegistry,
  AgentSessionMetricsCollector,
  ConversationSummaryService,
  COMPANION_SUMMARY_MODEL_ID,
  COMPANION_SUMMARY_TEMPERATURE,
  stripInaccessibleAgentRefs,
} from "./features/agents"
import { EmojiUsageHandler } from "./features/emoji"
import { SystemMessageService, SystemMessageOutboxHandler } from "./features/system-messages"
import { ActivityService, ActivityFeedHandler } from "./features/activity"
import { SavedMessagesService, createSavedReminderWorker } from "./features/saved-messages"
import { ScheduledMessagesService, createScheduledMessageSendWorker } from "./features/scheduled-messages"
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
} from "./lib/queue"
import { ProcessingStatuses } from "@threa/types"
import { AttachmentRepository } from "./features/attachments"
import { ulid } from "ulid"
import { loadConfig } from "./lib/env"
import { createCorsOriginChecker } from "./lib/cors"
import type { AuthorType } from "@threa/types"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threa/prosemirror"
import { normalizeMessage, toEmoji } from "./features/emoji"
import { logger } from "./lib/logger"
import { createAI } from "./lib/ai/ai"
import { createModelRegistry } from "./lib/ai/model-registry"
import { createStaticConfigResolver } from "./lib/ai/static-config-resolver"
import {
  QueueManager,
  QueueTiers,
  QueueFairness,
  ScheduleManager,
  CleanupWorker,
  QueueRepository,
  TokenPoolRepository,
} from "./lib/queue"
import { UserSocketRegistry } from "./lib/user-socket-registry"
import { PoolMonitor } from "./lib/observability"
import { ControlPlaneClient } from "./lib/control-plane-client"

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

  // Initialize Prometheus metrics collection
  const { collectDefaultMetrics } = await import("./lib/observability")
  collectDefaultMetrics()
  logger.info("Prometheus metrics collection initialized")

  // Create separated connection pools:
  // - main: services, workers, queue system, HTTP handlers (30 connections)
  // - listen: OutboxListener LISTEN connections (12 connections)
  // - realtime: broadcast + push outbox handlers (8 connections, reserved)
  const pools = createDatabasePools(config.databaseUrl)
  const pool = pools.main // Alias for backwards compatibility during transition

  // Start monitoring pool health
  // Note: Logging disabled - use Grafana dashboard for monitoring
  // Will still log warnings for high utilization or waiting connections
  const poolMonitor = new PoolMonitor(
    { main: pools.main, listen: pools.listen, realtime: pools.realtime },
    {
      logIntervalMs: 30000, // Update metrics every 30 seconds
      warnThreshold: 80, // Warn when 80% utilized
      disableLogging: true, // Disable periodic console logs (use Grafana instead)
    }
  )
  poolMonitor.start()

  await runMigrations(pool)

  // Pre-warm pool before starting workers to prevent thundering herd
  // When 15+ workers start simultaneously, they all try to connect at once
  // which can overwhelm an empty pool and cause phantom connections
  logger.info("Pre-warming connection pool...")
  await warmPool(pools.main, 15) // Pre-create 15 connections for workers
  logger.info("Connection pool pre-warmed")

  const workosOrgService = config.useStubAuth ? new StubWorkosOrgService() : new WorkosOrgServiceImpl(config.workos)
  const storage = createS3Storage(config.s3)
  const avatarService = new AvatarService(storage)
  const streamService = new StreamService(pool)
  const eventService = new EventService(pool)
  const authService = config.useStubAuth ? new StubAuthService() : new WorkosAuthService(config.workos)

  // Attachment service
  const malwareScanner = createMalwareScanner(storage, config.attachments)
  const attachmentService = new AttachmentService(pool, storage, malwareScanner)
  await attachmentService.recoverStalePendingScans()

  // Create cost tracking service for AI usage
  const costService = new AICostService({ pool })
  const budgetService = new AIBudgetService({ pool })

  const ai = createAI({
    openrouter: { apiKey: config.ai.openRouterApiKey },
    costRecorder: costService,
    budgetEnforcer: budgetService,
  })
  const modelRegistry = createModelRegistry()
  const configResolver = createStaticConfigResolver()
  const messageFormatter = new MessageFormatter()
  const streamNamingService = config.useStubAI
    ? new StubStreamNamingService()
    : new StreamNamingService(pool, ai, configResolver, messageFormatter)
  const conversationService = new ConversationService(pool)
  const userPreferencesService = new UserPreferencesService(pool)

  // Search and embedding services
  const embeddingService = config.useStubAI ? new StubEmbeddingService() : new EmbeddingService({ ai })
  const memoReranker = config.useStubAI ? new StubReranker() : new MemoReranker({ ai })
  const searchService = new SearchService({ pool, embeddingService })
  const memoExplorerService = new MemoExplorerService({ pool, embeddingService, reranker: memoReranker })

  // Job queue for durable background work (companion responses, etc.).
  //
  // Tiered concurrency budgets: each tier has its own in-flight cap so slow
  // heavy work (PDF/image/memo) cannot monopolize the pool and starve
  // interactive work (persona agent responses, commands). Budgets roughly
  // target: 45 worst-case concurrent handlers (15 tokens × 3 msgs/token),
  // bounded per tier. Main pool = 30, so real-time handlers on `pools.realtime`
  // are isolated regardless of queue load.
  //
  // Fairness defaults to `none` per-queue (see handler registrations below).
  // Region-level sharding already isolates tenants, so a single workspace can
  // use a tier's full budget — the previous per-workspace fairness was
  // serializing bursts unnecessarily.
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

  // Schedule manager for cron tick generation
  const scheduleManager = new ScheduleManager(pool, {
    lookaheadSeconds: 60, // Generate ticks for next minute
    intervalMs: 10000, // Check every 10 seconds
    batchSize: 100, // Process up to 100 schedules per run
  })

  // Cleanup worker for expired and orphaned cron ticks
  const cleanupWorker = new CleanupWorker(pool, {
    intervalMs: 300000, // Run every 5 minutes
    expiredThresholdMs: 300000, // Delete ticks expired for 5+ minutes
  })

  // Agent session metrics collector
  const agentSessionMetrics = new AgentSessionMetricsCollector(pool)

  // Create helpers for agents
  // This adapter accepts markdown content and converts to JSON+markdown format
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
  }) => {
    const initialMarkdown = normalizeMessage(params.content)
    const initialJson = parseMarkdown(initialMarkdown, undefined, toEmoji)
    // For agent-authored messages, pre-validate the structural pointers
    // (`shared-message:`, `quote:`, `attachment:`) and drop nodes that
    // wouldn't pass event-service's strict gate. Without this, a single
    // bad ref (out-of-scope stream, deleted message, cross-workspace id)
    // causes the entire message to fail rather than just losing the
    // pointer. The helper re-serializes the cleaned tree to keep the
    // wire markdown in sync with `contentJson`.
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
  const createThread = (params: Parameters<typeof streamService.createThread>[0]) => streamService.createThread(params)

  const activityService = new ActivityService({ pool })
  const savedMessagesService = new SavedMessagesService({ pool })
  const scheduledMessagesService = new ScheduledMessagesService({ pool, eventService })
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

  // Command infrastructure - created early for route registration
  const commandRegistry = new CommandRegistry()
  commandRegistry.register(new InviteCommand({ pool, streamService }))

  // Public API key service — WorkOS validates API keys in production, stub in dev
  const apiKeyService = config.useStubAuth ? new StubApiKeyService() : new WorkosApiKeyService(config.workos)
  const botChannelService = new BotChannelService({ pool })

  // User-scoped API key service — managed by Threa (not WorkOS)
  const userApiKeyService = new UserApiKeyServiceImpl(pool)

  // Bot API key service — self-managed keys for bot integrations
  const botApiKeyService = new BotApiKeyService(pool)

  // Workspace authz mirror service — shared by routes (middleware + handlers,
  // public API auth) and feature services that need to gate on workspace
  // permissions outside the request middleware chain.
  const workspaceAuthzService = new WorkspaceAuthzService({ pool })

  // Link preview service — created early for route registration
  const workspaceIntegrationService = new WorkspaceIntegrationService({
    pool,
    github: config.github,
    linear: config.linear,
  })
  const linkPreviewService = new LinkPreviewService({ pool, streamService })

  const isProduction = process.env.NODE_ENV === "production"
  const app = createApp({ corsAllowedOrigins: config.corsAllowedOrigins, isProduction })

  registerRoutes(app, {
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
    s3Config: config.s3,
    commandRegistry,
    avatarService,
    rateLimiterConfig: config.rateLimits,
    corsAllowedOrigins: config.corsAllowedOrigins,
    allowDevAuthRoutes: config.useStubAuth && !isProduction,
    internalApiKey: config.internalApiKey,
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
  })

  app.use(errorHandler)

  const server = createServer(app)

  const io = new SocketIOServer(server, {
    path: "/socket.io/",
    cors: {
      origin: createCorsOriginChecker(config.corsAllowedOrigins),
      credentials: true,
    },
  })

  io.adapter(createAdapter(pools.realtime))

  const userSocketRegistry = new UserSocketRegistry()
  const sessionAbortRegistry = new SessionAbortRegistry()
  registerSocketHandlers(io, {
    pool,
    authService,
    streamService,
    pushService,
    userSocketRegistry,
    sessionAbortRegistry,
  })

  const serverId = `server_${ulid()}`

  // Create workspace agent for on-demand workspace knowledge retrieval
  const workspaceAgent = new WorkspaceAgent({ pool, ai, configResolver, embeddingService })

  const traceEmitter = new TraceEmitter({ io, pool })
  const conversationSummaryService = new ConversationSummaryService({
    ai,
    modelId: COMPANION_SUMMARY_MODEL_ID,
    temperature: COMPANION_SUMMARY_TEMPERATURE,
  })
  const personaAgent = new PersonaAgent({
    pool,
    ai,
    traceEmitter,
    sessionAbortRegistry,
    userPreferencesService,
    workspaceAgent,
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
    createThread,
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

  // Boundary extraction
  const boundaryExtractor = config.useStubBoundaryExtraction
    ? new StubBoundaryExtractor()
    : new LLMBoundaryExtractor(ai, configResolver)
  const boundaryExtractionService = new BoundaryExtractionService(pool, boundaryExtractor)
  const boundaryExtractionWorker = createBoundaryExtractionWorker({ service: boundaryExtractionService })
  jobQueue.registerHandler(JobQueues.BOUNDARY_EXTRACT, boundaryExtractionWorker, {
    tier: QueueTiers.LIGHT,
    fairness: QueueFairness.NONE,
  })

  // Memo (GAM) processing — batched extraction, heavy LLM work
  const memoService = config.useStubAI
    ? new StubMemoService()
    : new MemoService({
        pool,
        classifier: new MemoClassifier(ai, configResolver, messageFormatter),
        memorizer: new Memorizer(ai, configResolver, messageFormatter),
        embeddingService,
        messageFormatter,
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

  // Image captioning worker
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

  // PDF processing workers
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

  // Text processing worker
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

  // Word processing worker
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

  // Excel processing worker
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

  // Video transcoding workers
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

  // Register handlers before starting
  await jobQueue.start()

  // Start schedule manager, cleanup worker, and metrics collectors
  scheduleManager.start()
  cleanupWorker.start()
  agentSessionMetrics.start()

  // Schedule memo batch check cron job (every 30 seconds)
  // workspaceId in payload: "system" for system-wide batch check
  // workspaceId in schedule: null for global (not workspace-specific) schedule
  // Skip when AI is stubbed - stub memo services don't need batch processing
  if (!config.useStubAI) {
    await jobQueue.schedule(JobQueues.MEMO_BATCH_CHECK, 30, { workspaceId: "system" }, null)
  }

  // Outbox dispatcher - single LISTEN connection fans out to all handlers
  const outboxDispatcher = new OutboxDispatcher({ listenPool: pools.listen })

  // Create handlers - each manages its own cursor, debouncing, and processing.
  //
  // Real-time delivery handlers (broadcast, push) use a dedicated `pools.realtime`
  // so a saturated main pool (AI workers, file processing, embeddings) can never
  // starve socket.io broadcasts or push notifications. All other outbox handlers
  // use the main pool — they enqueue jobs and can tolerate back-pressure.
  const broadcastHandler = new BroadcastHandler(pools.realtime, io)
  const companionHandler = new CompanionHandler(pool, jobQueue)
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
  const pushNotificationHandler = pushService.isEnabled()
    ? new PushNotificationHandler({ pool: pools.realtime, pushService })
    : null
  const linkPreviewOutboxHandler = new LinkPreviewOutboxHandler(pool, jobQueue)
  const shadowSyncHandler =
    controlPlaneClient && config.region
      ? new InvitationShadowSyncHandler(pool, controlPlaneClient, config.region)
      : null
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
    linkPreviewOutboxHandler,
    ...(pushNotificationHandler ? [pushNotificationHandler] : []),
    ...(shadowSyncHandler ? [shadowSyncHandler] : []),
  ]

  // Ensure listeners exist in database, then register all handlers
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

  // Start single LISTEN connection that notifies all handlers
  await outboxDispatcher.start()
  outboxRetentionWorker.start()

  const orphanSessionCleanup = createOrphanSessionCleanup(pools.main)
  orphanSessionCleanup.start()

  const pushSessionCleanup = createPushSessionCleanup(pushService)
  pushSessionCleanup.start()

  await new Promise<void>((resolve) => {
    server.listen(config.port, "0.0.0.0", () => {
      logger.info({ port: config.port }, "Server started")
      resolve()
    })
  })

  const stop = async () => {
    // In fast shutdown mode, skip graceful shutdown for immediate termination
    if (config.fastShutdown) {
      logger.info("Fast shutdown mode - skipping graceful shutdown")
      // Force close everything immediately without waiting
      server.close()
      io.close()
      // Skip pool cleanup entirely - process exit will terminate connections
      return
    }

    logger.info("Shutting down server...")
    poolMonitor.stop()
    orphanSessionCleanup.stop()
    pushSessionCleanup.stop()
    agentSessionMetrics.stop()
    await scheduleManager.stop()
    await cleanupWorker.stop()
    await outboxRetentionWorker.stop()
    await outboxDispatcher.stop()
    await jobQueue.stop()
    logger.info("Closing socket.io...")

    // Close socket.io with callback - add timeout since it can hang with postgres adapter
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
    await pools.listen.end()
    await pools.realtime.end()
    await pools.main.end()
    logger.info("Server stopped")
  }

  return { server, io, pools, jobQueue, poolMonitor, port: config.port, fastShutdown: config.fastShutdown, stop }
}
