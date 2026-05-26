// Branded ID types
export type { UserId, MemberId, WorkspaceId } from "./ids"

// Constants and their types
export {
  // Stream types
  STREAM_TYPES,
  type StreamType,
  StreamTypes,
  DM_PARTICIPANT_COUNT,
  // Visibility
  VISIBILITY_OPTIONS,
  type Visibility,
  Visibilities,
  // Companion modes
  COMPANION_MODES,
  type CompanionMode,
  CompanionModes,
  // Content formats
  CONTENT_FORMATS,
  type ContentFormat,
  // Author types
  AUTHOR_TYPES,
  type AuthorType,
  AuthorTypes,
  // Event types
  EVENT_TYPES,
  type EventType,
  COMMAND_EVENT_TYPES,
  type CommandEventType,
  // Workspace roles
  WORKSPACE_USER_ROLES,
  // Invitation statuses
  INVITATION_STATUSES,
  type InvitationStatus,
  InvitationStatuses,
  // Persona
  PERSONA_MANAGED_BY,
  type PersonaManagedBy,
  PERSONA_STATUSES,
  type PersonaStatus,
  // Attachments
  STORAGE_PROVIDERS,
  type StorageProvider,
  PROCESSING_STATUSES,
  type ProcessingStatus,
  ProcessingStatuses,
  ATTACHMENT_SAFETY_STATUSES,
  type AttachmentSafetyStatus,
  AttachmentSafetyStatuses,
  VIDEO_TRANSCODE_STATUSES,
  type VideoTranscodeStatus,
  VideoTranscodeStatuses,
  EXTRACTION_CONTENT_TYPES,
  type ExtractionContentType,
  ExtractionContentTypes,
  // Conversations
  CONVERSATION_STATUSES,
  type ConversationStatus,
  ConversationStatuses,
  // Memos (GAM)
  MEMO_TYPES,
  type MemoType,
  MemoTypes,
  KNOWLEDGE_TYPES,
  type KnowledgeType,
  KnowledgeTypes,
  MEMO_STATUSES,
  type MemoStatus,
  MemoStatuses,
  PENDING_ITEM_TYPES,
  type PendingItemType,
  // Agent tools
  AGENT_TOOL_NAMES,
  type AgentToolName,
  AgentToolNames,
  // Source types
  SOURCE_TYPES,
  type SourceType,
  SourceTypes,
  // Agent triggers
  AGENT_TRIGGERS,
  type AgentTrigger,
  AgentTriggers,
  // Agent session events
  AGENT_SESSION_EVENT_TYPES,
  type AgentSessionEventType,
  // Agent step types
  AGENT_STEP_TYPES,
  type AgentStepType,
  AgentStepTypes,
  AGENT_RECONSIDERATION_DECISIONS,
  type AgentReconsiderationDecision,
  AgentReconsiderationDecisions,
  // Agent session statuses
  AGENT_SESSION_STATUSES,
  type AgentSessionStatus,
  AgentSessionStatuses,
  // PDF processing
  PDF_PAGE_CLASSIFICATIONS,
  type PdfPageClassification,
  PdfPageClassifications,
  PDF_JOB_STATUSES,
  type PdfJobStatus,
  PdfJobStatuses,
  PDF_SIZE_TIERS,
  type PdfSizeTier,
  PdfSizeTiers,
  EXTRACTION_SOURCE_TYPES,
  type ExtractionSourceType,
  ExtractionSourceTypes,
  // Notification levels (per-stream member preference)
  NOTIFICATION_LEVELS,
  type NotificationLevel,
  NotificationLevels,
  type NotificationConfig,
  NOTIFICATION_CONFIG,
  // Activity types
  ACTIVITY_TYPES,
  type ActivityType,
  ActivityTypes,
  // Saved messages
  SAVED_STATUSES,
  type SavedStatus,
  SavedStatuses,
  // Scheduled messages
  SCHEDULED_MESSAGE_STATUSES,
  type ScheduledMessageStatus,
  ScheduledMessageStatuses,
  // Text processing
  TEXT_FORMATS,
  type TextFormat,
  TextFormats,
  TEXT_SIZE_TIERS,
  type TextSizeTier,
  TextSizeTiers,
  INJECTION_STRATEGIES,
  type InjectionStrategy,
  InjectionStrategies,
  WORKSPACE_INTEGRATION_PROVIDERS,
  type WorkspaceIntegrationProvider,
  WorkspaceIntegrationProviders,
  WORKSPACE_INTEGRATION_STATUSES,
  type WorkspaceIntegrationStatus,
  WorkspaceIntegrationStatuses,
  // Link previews
  LINK_PREVIEW_CONTENT_TYPES,
  type LinkPreviewContentType,
  LinkPreviewContentTypes,
  LINK_PREVIEW_STATUSES,
  type LinkPreviewStatus,
  LinkPreviewStatuses,
  GITHUB_PREVIEW_TYPES,
  type GitHubPreviewType,
  GitHubPreviewTypes,
  LINEAR_PREVIEW_TYPES,
  type LinearPreviewType,
  LinearPreviewTypes,
  // Share flavors
  SHARE_FLAVORS,
  type ShareFlavor,
  ShareFlavors,
  ShareErrorCodes,
  // Inter-service authentication
  INTERNAL_API_KEY_HEADER,
  // Socket heartbeat
  HEARTBEAT_INTERACTION_THROTTLE_MS,
  // Bots
  BOT_TYPES,
  type BotType,
  BotTypes,
  BOT_TRAITS,
  type BotTrait,
  BotTraits,
  botHasCapability,
  BOT_RUNTIME_KINDS,
  type BotRuntimeKind,
  BotRuntimeKinds,
  BOT_RUNTIME_SESSION_LINK_STATUSES,
  type BotRuntimeSessionLinkStatus,
  BotRuntimeSessionLinkStatuses,
  BOT_RUNTIME_STATUSES,
  type BotRuntimeStatus,
  BotRuntimeStatuses,
  BOT_INVOCATION_STATUSES,
  type BotInvocationStatus,
  BotInvocationStatuses,
  BOT_INVOCATION_TRIGGERS,
  type BotInvocationTrigger,
  BotInvocationTriggers,
  BOT_INVOCATION_CAPABILITIES,
  type BotInvocationCapability,
  BotInvocationCapabilities,
  PI_TOOL_TRACE_FORMAT,
  PI_TOOL_TRACE_SECTION_LABELS,
  type PiToolTraceSectionLabel,
  PiToolTraceSectionLabels,
  // Auth (social providers + magic auth)
  SOCIAL_PROVIDERS,
  type SocialProvider,
  MAGIC_CODE_LENGTH,
  // E2E placeholder shared between backend insert and frontend encrypt/decrypt
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
} from "./constants"

// Domain entities (wire format)
export { getAvatarUrl, getBotAvatarUrl } from "./domain"
export type {
  Workspace,
  User,
  WorkspaceInvitation,
  WorkspaceInvitationKind,
  Stream,
  LastMessagePreview,
  StreamWithPreview,
  StreamActiveActor,
  BotRuntimeInstance,
  BotRuntimeSessionLink,
  BotInvocation,
  StreamMember,
  Message,
  ThreadSummary,
  MessageVersion,
  StreamEvent,
  Persona,
  Bot,
  Attachment,
  AttachmentSummary,
  SourceItem,
  Conversation,
  ConversationWithStaleness,
  Memo,
  PendingMemoItem,
  MemoStreamState,
  ChartData,
  TableData,
  DiagramData,
  AttachmentExtraction,
  PdfSection,
  PdfMetadata,
  // Text extraction types
  TextSection,
  MarkdownStructure,
  JsonStructure,
  CsvStructure,
  CodeStructure,
  TextMetadata,
  // Word extraction types
  WordMetadata,
  // Excel extraction types
  ExcelSheetInfo,
  ExcelChartInfo,
  ExcelMetadata,
  // Link previews
  LinkPreview,
  LinkPreviewSummary,
  WorkspaceIntegration,
  WorkspaceIntegrationRateLimit,
  GitHubInstalledRepository,
  GitHubWorkspaceIntegration,
  GitHubPreviewActor,
  GitHubPreviewRepository,
  GitHubReviewStatusSummary,
  GitHubPrPreviewData,
  GitHubIssueLabel,
  GitHubIssuePreviewData,
  GitHubCommitPreviewData,
  GitHubSnippetLine,
  GitHubFilePreviewData,
  GitHubDiffLine,
  GitHubDiffPreviewData,
  GitHubCommentParent,
  GitHubCommentPreviewData,
  GitHubPreview,
  // Linear integration + previews
  LinearWorkspaceIntegration,
  LinearAuthorizedUser,
  LinearRateLimit,
  LinearActor,
  LinearTeam,
  LinearIssueState,
  LinearIssueLabel,
  LinearOrganizationSummary,
  LinearIssuePreviewData,
  LinearCommentParent,
  LinearCommentPreviewData,
  LinearProjectPreviewData,
  LinearDocumentPreviewData,
  LinearPreview,
  // Message link previews (internal permalinks)
  MessageLinkAccessTier,
  MessageLinkPreviewData,
} from "./domain"

// Slug validation
export {
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  MENTION_PATTERN,
  INVALID_SLUG_CHARS,
  BROADCAST_SLUGS,
  isValidSlug,
  isBroadcastSlug,
  extractMentionSlugs,
  hasMention,
} from "./slug"
export type { BroadcastSlug } from "./slug"

// Attachment categories (mime → category mapping for the attachment explorer)
export { ATTACHMENT_CATEGORIES, categoryFromMime, mimePrefixesForCategory } from "./attachment-categories"
export type { AttachmentCategory } from "./attachment-categories"

// API types
export type {
  // Streams
  CreateStreamInput,
  UpdateStreamInput,
  UpdateCompanionModeInput,
  StreamBootstrap,
  BotRuntimePresenceSummary,
  StreamContextBagPayload,
  StreamContextRef,
  StreamContextRefSource,
  EventsAroundResponse,
  SharedMessageHydration,
  // Messages
  CreateMessageInput,
  CreateMessageInputJson,
  CreateMessageInputMarkdown,
  CreateDmMessageInput,
  CreateDmMessageInputJson,
  CreateDmMessageInputMarkdown,
  UpdateMessageInput,
  UpdateMessageInputJson,
  UpdateMessageInputMarkdown,
  MoveMessagesToThreadInput,
  MoveMessagesToThreadResponse,
  ValidateMoveMessagesToThreadInput,
  ValidateMoveMessagesToThreadResponse,
  MovedMessagePreview,
  MessagesMovedEventPayload,
  MovedFromProvenance,
  // Workspaces
  CreateWorkspaceInput,
  WorkspaceBootstrap,
  // Invitations
  PendingInvitation,
  SendInvitationsInput,
  SendInvitationsResponse,
  InvitationSkipReason,
  CreateInvitationLinkInput,
  CreateInvitationLinkResponse,
  InvitationLinkLookupResponse,
  ClaimInvitationLinkInput,
  ClaimInvitationLinkResponse,
  CompleteUserSetupInput,
  // Activity
  Activity,
  ActivityCreatedPayload,
  // Saved messages
  SavedMessageView,
  SavedMessageSnapshot,
  SaveMessageInput,
  UpdateSavedMessageInput,
  SavedMessageListResponse,
  SavedUpsertedPayload,
  SavedDeletedPayload,
  SavedReminderFiredPayload,
  // Scheduled messages
  ScheduledMessageView,
  ScheduleMessageInput,
  UpdateScheduledMessageInput,
  LockScheduledMessageResponse,
  ScheduledMessageListResponse,
  ScheduledMessageUpsertedPayload,
  ScheduledMessageSentPayload,
  ScheduledMessageCancelledPayload,
  // Emojis
  EmojiEntry,
  // Commands
  CommandInfo,
  CommandKind,
  CommandScope,
  CommandArgumentInfo,
  CommandArgumentSuggestion,
  DispatchCommandInput,
  DispatchCommandResponse,
  DispatchCommandError,
  CommandDispatchedPayload,
  CommandCompletedPayload,
  CommandFailedPayload,
  // AI Usage
  AIUsageSummary,
  AIUsageOrigin,
  AIUsageByOrigin,
  AIUsageByUser,
  AIUsageRecord,
  AIUsageResponse,
  AIRecentUsageResponse,
  AIBudgetConfig,
  AIBudgetResponse,
  UpdateAIBudgetInput,
} from "./api"

// Push Notifications
export { DEVICE_KEY_LENGTH } from "./api"

// Command kind constants
export { CommandKinds, CommandScopes } from "./api"

// Discuss-with-Ariadne client-action id (single source of truth)
export const DISCUSS_WITH_ARIADNE_COMMAND = "discuss-with-ariadne" as const

/**
 * Persona slug for Ariadne — the workspace-companion persona that backs
 * "Discuss with Ariadne" scratchpads. Single source of truth (INV-33) so
 * backend lookups (`PersonaRepository.findBySlug`), frontend command
 * filters, and any future onboarding seeding stay in sync.
 */
export const ARIADNE_PERSONA_SLUG = "ariadne" as const

// ProseMirror / TipTap JSON types
export type {
  // Loose input type (compatible with TipTap)
  JSONContent,
  JSONContentMark,
  // Strict document types
  ThreaDocument,
  ThreaBlockNode,
  ThreaParagraph,
  ThreaHeading,
  ThreaCodeBlock,
  ThreaBlockquote,
  ThreaQuoteReply,
  ThreaSharedMessage,
  ThreaBulletList,
  ThreaOrderedList,
  ThreaListItem,
  ThreaHorizontalRule,
  ThreaInlineNode,
  ThreaTextNode,
  ThreaMention,
  ThreaChannelLink,
  ThreaCommand,
  ThreaEmoji,
  ThreaAttachmentReference,
  ThreaHardBreak,
  ThreaMark,
  ThreaBoldMark,
  ThreaItalicMark,
  ThreaStrikeMark,
  ThreaCodeMark,
  ThreaLinkMark,
  ThreaNodeType,
  ThreaMarkType,
} from "./prosemirror"
export {
  // Validation schema
  threaDocumentSchema,
  // Error class
  ContentValidationError,
  // Type guards and validators
  isThreaDocument,
  validateContent,
  tryValidateContent,
} from "./prosemirror"

// User Preferences
export {
  // Theme
  THEME_OPTIONS,
  type Theme,
  Themes,
  // Message display
  MESSAGE_DISPLAY_OPTIONS,
  type MessageDisplay,
  MessageDisplays,
  // Date format
  DATE_FORMAT_OPTIONS,
  type DateFormat,
  DateFormats,
  // Time format
  TIME_FORMAT_OPTIONS,
  type TimeFormat,
  TimeFormats,
  // Notification level (user-level global preference)
  PREF_NOTIFICATION_LEVEL_OPTIONS,
  type PrefNotificationLevel,
  PrefNotificationLevels,
  // Font size
  FONT_SIZE_OPTIONS,
  type FontSize,
  FontSizes,
  // Font family
  FONT_FAMILY_OPTIONS,
  type FontFamily,
  FontFamilies,
  // Message send mode
  MESSAGE_SEND_MODE_OPTIONS,
  type MessageSendMode,
  MessageSendModes,
  // Link preview default
  LINK_PREVIEW_DEFAULT_OPTIONS,
  type LinkPreviewDefault,
  LinkPreviewDefaults,
  // Code block collapse threshold
  CODE_BLOCK_COLLAPSE_THRESHOLD_MIN,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  // Blockquote collapse threshold
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  // Voice transcription model picker
  VOICE_TRANSCRIPTION_MODELS,
  type VoiceTranscriptionModelOption,
  // Voice polish level
  VOICE_POLISH_LEVEL_OPTIONS,
  type VoicePolishLevel,
  VoicePolishLevels,
  // Settings tabs
  SETTINGS_TAB_OPTIONS,
  SETTINGS_TABS,
  type SettingsTab,
  // Domain types
  type AccessibilityPreferences,
  DEFAULT_ACCESSIBILITY,
  type KeyboardShortcuts,
  type UserPreferences,
  DEFAULT_USER_PREFERENCES,
  // API types
  type UpdateUserPreferencesInput,
} from "./preferences"

// API Keys
export {
  SENT_VIA_API_PREFIX,
  sentViaApiKey,
  isSentViaApi,
  API_KEY_ELIGIBLE_SCOPES,
  API_KEY_ELIGIBLE_PICKER_SCOPES,
  type UserApiKey,
  type CreateUserApiKeyResponse,
  BOT_KEY_PREFIX,
  type BotApiKey,
  type CreateBotApiKeyResponse,
} from "./api-keys"

// Workspace permissions catalog
export {
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_PERMISSIONS,
  WORKSPACE_ROLE_SLUGS,
  WORKSPACE_ROLE_DEFINITIONS,
  WORKSPACE_INVITABLE_ROLES,
  permissionsForRole,
  parseJwtPermissions,
  roleDisplayName,
  rolesGrant,
  type WorkspacePermission,
  type WorkspacePermissionSlug,
  type WorkspaceRoleSlug,
  type WorkspaceInvitableRole,
  type WorkspaceRoleDefinition,
} from "./workspace-permissions"

// Context bag primitive
export {
  ContextIntents,
  CONTEXT_INTENTS,
  ContextRefKinds,
  CONTEXT_REF_KINDS,
  type ContextIntent,
  type ContextRefKind,
  type ContextRef,
  type ContextBag,
} from "./context-bag"

// Agent trace types
export {
  TRACE_SOURCE_TYPES,
  type TraceSourceType,
  type TraceSource,
  type AgentSessionRerunCause,
  type AgentSessionRerunContext,
  type AgentSessionStep,
  type AgentSession,
  type AgentSessionWithSteps,
  type AgentActivityUpdate,
  type AgentSessionStartedPayload,
  type AgentSessionCompletedPayload,
  type AgentSessionFailedPayload,
  type AgentSessionDeletedPayload,
  type AgentSessionProgressPayload,
  type AgentSessionSubstepPayload,
  type StepStartedPayload,
  type StepProgressPayload,
  type StepCompletedPayload,
  type SessionTerminalPayload,
  type AgentActivityStartedPayload,
  type AgentActivityEndedPayload,
} from "./agent-trace"
