// Auth
export { WorkosAuthService } from "./auth/auth-service"
export type { AuthResult, AuthService } from "./auth/auth-service"
export { StubAuthService } from "./auth/auth-service.stub"
export type { DevLoginResult } from "./auth/auth-service.stub"
export {
  WorkosOrgServiceImpl,
  getWorkosErrorCode,
  WORKOS_MIRROR_EVENT_TYPES,
  WORKOS_MEMBERSHIP_STATUSES,
} from "./auth/workos-org-service"
export type {
  WorkosOrgService,
  WorkosAppInvitation,
  WorkosUserSummary,
  WorkosMembershipEvent,
  WorkosMirrorEventType,
  WorkosMembershipStatus,
  WorkosOrganizationMembership,
} from "./auth/workos-org-service"
export { StubWorkosOrgService } from "./auth/workos-org-service.stub"
export { createAuthMiddleware } from "./auth/middleware"
export { WorkosApiKeyService } from "./auth/api-key-service"
export type { ApiKeyService, ValidatedApiKey } from "./auth/api-key-service"
export { StubApiKeyService } from "./auth/api-key-service.stub"
export { displayNameFromWorkos } from "./auth/display-name"
export { decodeAndSanitizeRedirectState } from "./auth/redirect"
export { renderLoginPage } from "./auth/stub-login-page"
export type { WorkosConfig } from "./auth/types"

// Database
export { sql, createDatabasePool, createDatabasePools, withTransaction, withClient, warmPool } from "./db/index"
export type { Querier, DatabasePools } from "./db/index"
export { createMigrator, runMigrations } from "./db/migrations"

// Errors
export { HttpError, isUniqueViolation } from "./errors"

// Middleware
export { errorHandler } from "./middleware/error-handler"
export { createInternalAuthMiddleware, INTERNAL_API_KEY_HEADER } from "./middleware/internal-auth"
export { createRateLimit, getClientIp } from "./middleware/rate-limit"
export type { RateLimitOptions } from "./middleware/rate-limit"

// Utilities
export { logger } from "./logger"
export { extractWorkspaceIdFromGithubInstallState } from "./github-install-state"
export {
  userId,
  workspaceId,
  streamId,
  eventId,
  messageId,
  attachmentId,
  personaId,
  notificationId,
  invitationId,
  sessionId,
  stepId,
  conversationId,
  memoId,
  pendingItemId,
  commandId,
  emojiUsageId,
  aiUsageId,
  aiBudgetId,
  aiQuotaId,
  aiAlertId,
  researcherCacheId,
  queueId,
  tokenId,
  workerId,
  tickerId,
  tickId,
  cronId,
  extractionId,
  pdfPageId,
  pdfJobId,
  agentConversationSummaryId,
  activityId,
  avatarUploadId,
  messageVersionId,
  taskId,
  pushSubscriptionId,
  userSessionId,
  apiKeyChannelAccessId,
  botId,
  linkPreviewId,
  workspaceIntegrationId,
  userApiKeyId,
  botApiKeyId,
  botChannelAccessId,
  videoTranscodeJobId,
  savedMessageId,
  reminderQueueId,
  scheduledMessageId,
  scheduledMessageQueueId,
  sharedMessageId,
  attachmentReferenceId,
  streamContextAttachmentId,
  contextSummaryId,
  leaseId,
  streamActiveActorId,
  botRuntimeInstanceId,
  botRuntimeSessionLinkId,
  botInvocationId,
} from "./id"
export {
  parseCookies,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_CONFIG,
  setSessionCookie,
  clearSessionCookie,
  MAX_ACCOUNTS,
  MAX_ALT_SLOTS,
  assertSlot,
  altSessionCookieName,
  setAltSessionCookie,
  clearAltSessionCookie,
  readAltSessionCookies,
} from "./cookies"
export type { SessionCookieOptions } from "./cookies"
export { generateSlug, generateUniqueSlug } from "./slug"

// Outbox infrastructure
export {
  OutboxDispatcher,
  OutboxRetentionWorker,
  OutboxRepository,
  CursorLock,
  ensureListener,
  ensureListenerFromLatest,
  compact,
  OUTBOX_CHANNEL,
} from "./outbox/index"
export type {
  OutboxHandler,
  OutboxDispatcherConfig,
  OutboxRetentionWorkerConfig,
  OutboxEvent,
  OutboxEventStatus,
  OutboxEventProcessingStatus,
  DeleteRetainedOutboxEventsParams,
  CursorLockConfig,
  ProcessResult,
  ProcessedIdsMap,
  CompactState,
} from "./outbox/index"

// CORS
export { createCorsOriginChecker } from "./cors"

// Shared utilities
export { DebounceWithMaxWait } from "./debounce"
export { calculateBackoffMs, type BackoffOptions } from "./backoff"
export { bigIntReplacer, serializeBigInt } from "./serialization"
export { Ticker, type TickerConfig } from "./ticker"
