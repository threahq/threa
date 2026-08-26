// Branded ID types
export type { UserId, MemberId, WorkspaceId } from "./ids"

export {
  VOICE_PROTOCOL_VERSION,
  VOICE_LEGACY_PROTOCOL_VERSION,
  VOICE_REPLACEMENT_ACK_STATUSES,
  VOICE_STOPPED_OUTCOMES,
} from "./voice-dictation"
export type {
  VoiceTerminationMode,
  VoiceRelayPhase,
  VoiceStartAck,
  VoiceStopPayload,
  VoiceStopAck,
  VoiceTranscriptDelta,
  VoiceTranscriptDeltaV3,
  VoiceTranscriptDeltaV4,
  VoiceTranscriptPolished,
  VoiceTranscriptPolishedV3,
  VoiceTranscriptReplacementV4,
  VoiceTranscriptReplacementSourceV4,
  VoiceTranscriptReplacementAck,
  VoiceReplacementAckStatus,
  VoiceStoppedPayload,
  VoiceStoppedOutcome,
} from "./voice-dictation"

// Constants and their types
export {
  // Title provenance
  TITLE_SOURCES,
  type TitleSource,
  TitleSources,
  // Stream types
  STREAM_TYPES,
  type StreamType,
  StreamTypes,
  // Shared-message private-placeholder kinds (STREAM_TYPES minus aside)
  SHARED_SOURCE_STREAM_KINDS,
  type SharedSourceStreamKind,
  DM_PARTICIPANT_COUNT,
  ASIDE_HOST_STREAM_TYPES,
  type AsideHostStreamType,
  isAsideHostType,
  STREAM_READ_ONLY_REASONS,
  type StreamReadOnlyReason,
  StreamReadOnlyReasons,
  StreamErrorCodes,
  STREAM_DESCRIPTION_MAX_MARKDOWN_LENGTH,
  STREAM_BRIEF_MAX_CHARS,
  // Stream purpose (system-purpose marker; NULL = ordinary stream)
  STREAM_PURPOSES,
  type StreamPurpose,
  StreamPurposes,
  // Visibility
  VISIBILITY_OPTIONS,
  type Visibility,
  Visibilities,
  // Labelable resources
  LABELABLE_RESOURCE_TYPES,
  type LabelableResourceType,
  LabelableResourceTypes,
  // Companion modes
  COMPANION_MODES,
  type CompanionMode,
  CompanionModes,
  // Memory automation modes
  MEMORY_MODES,
  type MemoryMode,
  MemoryModes,
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
  AUTHOR_SCOPED_EVENT_TYPES,
  type AuthorScopedEventType,
  TIMELINE_BROADCAST_EVENT_TYPES,
  type TimelineBroadcastEventType,
  isTimelineBroadcastEventType,
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
  // Persona style slots (tone / brevity presets)
  TONE_PRESETS,
  type TonePreset,
  TonePresets,
  BREVITY_PRESETS,
  type BrevityPreset,
  BrevityPresets,
  // Attachments
  STORAGE_PROVIDERS,
  type StorageProvider,
  PROCESSING_STATUSES,
  type ProcessingStatus,
  ProcessingStatuses,
  ATTACHMENT_SAFETY_STATUSES,
  type AttachmentSafetyStatus,
  AttachmentSafetyStatuses,
  SHAREABLE_SAFETY_STATUSES,
  BINDABLE_ATTACHMENT_SAFETY_STATUSES,
  ATTACHMENT_UPLOAD_STATUSES,
  type AttachmentUploadStatus,
  AttachmentUploadStatuses,
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
  MAX_CONVERSATION_TOPIC_LENGTH,
  MAX_BOARD_VIEW_NAME_LENGTH,
  // Board lenses
  BOARD_LENSES,
  type BoardLens,
  DEFAULT_BOARD_LENS,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
  BOARD_SCOPE_STREAM_TYPES,
  type BoardScopeStreamType,
  BOARD_TAIL_MAX_ROWS,
  CONVERSATION_INTENTS,
  type ConversationIntent,
  ConversationIntents,
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
  MEMO_TITLE_MAX_CHARS,
  MEMO_ABSTRACT_MAX_CHARS,
  MEMO_KEY_POINTS_MAX,
  MEMO_TAGS_MAX,
  AUTHORED_BY_KINDS,
  type AuthoredByKind,
  AuthoredByKinds,
  MEMO_SCOPES,
  type MemoScope,
  MemoScopes,
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
  // Agent follow-ups
  FOLLOW_UP_STATUSES,
  FOLLOW_UP_TERMINAL_STATUSES,
  type FollowUpStatus,
  FollowUpStatuses,
  // Delegated tasks
  DELEGATION_TITLE_MAX_CHARS,
  DELEGATION_BRIEF_MAX_CHARS,
  DELEGATION_CONTEXT_REFS_MAX,
  DELEGATION_STATUSES,
  type DelegationStatus,
  DelegationStatuses,
  DELEGATION_REOPEN_REASONS,
  type DelegationReopenReason,
  DELEGATION_TERMINAL_STATUSES,
  // Bot access-request lifecycle (F3)
  BOT_ACCESS_REQUEST_STATUSES,
  type BotAccessRequestStatus,
  BotAccessRequestStatuses,
  // Agent session events
  AGENT_SESSION_EVENT_TYPES,
  type AgentSessionEventType,
  // Agent step types
  AGENT_STEP_TYPES,
  type AgentStepType,
  AgentStepTypes,
  // Guardian verification state on a guarded tool call's step
  TOOL_VERIFICATION_STATUSES,
  type ToolVerificationStatus,
  ToolVerificationStatuses,
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
  // Saved suggestions
  SAVED_SUGGESTION_STATUSES,
  type SavedSuggestionStatus,
  SavedSuggestionStatuses,
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
  IN_APP_LINK_CONTENT_TYPES,
  type InAppLinkContentType,
  isInAppLinkContentType,
  INLINE_CHIP_CONTENT_TYPES,
  type InlineChipContentType,
  isInlineChipContentType,
  LINK_PREVIEW_STATUSES,
  type LinkPreviewStatus,
  LinkPreviewStatuses,
  GITHUB_PREVIEW_TYPES,
  type GitHubPreviewType,
  GitHubPreviewTypes,
  LINEAR_PREVIEW_TYPES,
  type LinearPreviewType,
  LinearPreviewTypes,
  VIDEO_PREVIEW_PROVIDERS,
  type VideoPreviewProvider,
  VideoPreviewProviders,
  VIDEO_PREVIEW_TYPES,
  type VideoPreviewType,
  VideoPreviewTypes,
  type RichLinkPreviewType,
  // Share flavors
  SHARE_FLAVORS,
  type ShareFlavor,
  ShareFlavors,
  ShareErrorCodes,
  MessageReferenceErrorCodes,
  MessageErrorCodes,
  // Inter-service authentication
  INTERNAL_API_KEY_HEADER,
  ENCLAVE_CALLBACK_TOKEN_HEADER,
  THREA_CALLBACK_TOKEN_HEADER,
  // Public API version negotiation
  THREA_VERSION_HEADER,
  // Original client host forwarded through the CF routers (survives Railway)
  ORIGINAL_HOST_HEADER,
  // Socket heartbeat
  HEARTBEAT_INTERACTION_THROTTLE_MS,
  // Push presence (attended-device interaction window)
  PRESENCE_INTERACTION_WINDOW_MS,
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
  PI_TOOL_TRACE_REDACTED_BODIES,
  PI_TOOL_TRACE_REDACTED_BODY_SET,
  // Voice dictation draft-context cap (shared FE/gateway)
  VOICE_DRAFT_CONTEXT_MAX_CHARS,
  // Auth (social providers + magic auth)
  SOCIAL_PROVIDERS,
  type SocialProvider,
  MAGIC_CODE_LENGTH,
  // E2E placeholder shared between backend insert and frontend encrypt/decrypt
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  // Leak-free label for E2E message previews (sidebar / Saved / push)
  ENCRYPTED_MESSAGE_PREVIEW_LABEL,
  // E2E actor kinds (bot / enclave)
  E2E_ACTOR_KINDS,
  type E2eActorKind,
  E2eActorKinds,
  E2E_ENCLAVE_ACTOR_ID,
  // E2E key-wrap recipient kinds (user / bot / enclave)
  E2E_KEY_WRAP_RECIPIENT_KINDS,
  type E2eKeyWrapRecipientKind,
  E2eKeyWrapRecipientKinds,
  // Label actors (user / bot)
  LABEL_ACTOR_TYPES,
  type LabelActorType,
  LabelActorTypes,
} from "./constants"

// Single source of truth for how each stream event renders across the timeline
// and the board/conversation projection (anti-drift spec — see stream-rows.ts).
export {
  STREAM_ROW_SPEC,
  BOARD_EVENT_ROW_TYPES,
  THREAD_ANCHORABLE_EVENT_TYPES,
  READ_BLOCKING_EVENT_TYPES,
} from "./stream-rows"
export type { StreamRowSpec, ConversationRef } from "./stream-rows"

// Markdown → plain-text stripping for preview surfaces (shared FE/BE, INV-60)
export {
  stripMarkdown,
  stripMarkdownKeepingCode,
  stripMarkdownToInline,
  resolveEmojiShortcodes,
} from "./markdown-strip"

// Board lens predicate (shared FE filter / BE seed)
export { matchesBoardLens, degradeBoardLens } from "./board-lens"
export { summarizeSdpMSections } from "./sdp"

// Domain entities (wire format)
export { getAvatarUrl, getBotAvatarUrl, getPersonaAvatarUrl } from "./domain"
export type {
  Workspace,
  User,
  WorkspaceInvitation,
  WorkspaceInvitationKind,
  Stream,
  E2eActor,
  LastMessagePreview,
  StreamWithPreview,
  StreamViewerState,
  ViewerStream,
  ViewerStreamWithPreview,
  StreamActiveActor,
  BotRuntimeInstance,
  BotRuntimeSessionLink,
  BotInvocation,
  BotOutputManifest,
  BotRuntimeManifest,
  StreamMember,
  Label,
  LabelAssignment,
  LabelActor,
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
  BoardPost,
  BoardView,
  BoardPostMessage,
  LabeledMessage,
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
  MemoEmbedSummary,
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
  // Video-embed previews
  VideoPreview,
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
  // In-app link previews (internal permalinks)
  InAppLinkAccessTier,
  MessageLinkPreviewData,
  StreamLinkPreviewData,
  MemoLinkPreviewData,
  ConversationLinkPreviewData,
  DelegationLinkPreviewData,
  InAppLinkPreviewData,
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
} from "./slug"
export type { BroadcastSlug } from "./slug"

// Outbound fetch identity (shared User-Agent for third-party URL fetches)
export {
  isRedditUrl,
  REDDIT_CRAWLER_USER_AGENT,
  resolveFetchUserAgent,
  THREA_BOT_CONTACT_URL,
  threaFetchUserAgent,
} from "./outbound-fetch"

// URL filtering/dedup values shared by the backend link filter and the client projection
export { BLOCKED_HOSTNAMES, BLOCKED_IP_PATTERNS, TRACKING_PARAMS } from "./url-normalization"

// Attachment categories (mime → category mapping for the attachment explorer)
export { ATTACHMENT_CATEGORIES, categoryFromMime, mimePrefixesForCategory } from "./attachment-categories"
export type { AttachmentCategory } from "./attachment-categories"
export {
  TOOL_PRIVACY_CATEGORIES,
  TOOL_PRIVACY_CATEGORY_LABELS,
  ToolPrivacyCategories,
  TOOL_CATEGORIES_BY_NAME,
  isToolCategoryAllowed,
  isToolAllowedByPolicy,
  areToolCategoriesAllowed,
} from "./tool-privacy"
export type { ToolPrivacyCategory, ToolPrivacyPolicy } from "./tool-privacy"

export {
  TOOL_TIERS,
  ToolTiers,
  TOOL_TIERS_BY_NAME,
  GUARDED_TOOL_NAMES,
  tierOfTool,
  requiresGuardianReview,
} from "./tool-tiers"
export type { ToolTier } from "./tool-tiers"
export {
  TOOL_EFFECT_KINDS,
  MUTATING_TOOLS,
  MUTATING_TOOL_NAMES,
  toolMutates,
  resolveToolEffects,
  EFFECT_LABEL_MAX_CHARS,
  EFFECTS_PER_CALL_MAX,
  EFFECTS_PER_SESSION_MAX,
  guardedToolsMissingFromMutating,
} from "./tool-effects"
export type { ToolEffectKind, AgentToolEffect } from "./tool-effects"

// API types
export type {
  // Streams
  CreateStreamInput,
  E2eKeyWrap,
  E2eOwnerKeyWrapInput,
  E2eKeyWrapsResponse,
  E2eKeyRollRecipient,
  E2eKeyRoll,
  InviteActorResponse,
  E2eKeyWrapInput,
  E2eKeyRollInput,
  E2eActorRewrapInput,
  EnclaveStreamEnvelope,
  EnclaveSealedMessage,
  EnclaveSskWrap,
  SealedReply,
  SealedComplete,
  EnclaveSealedSummary,
  SealedStep,
  SealedStepStart,
  EnclaveSealedSubstep,
  EnclaveSessionAssignment,
  SealedTurnContext,
  EnclaveSessionResult,
  EnclaveSessionFailure,
  EnclaveClaimResponse,
  EnclaveSessionHeartbeatResponse,
  EnclaveMidTurnMessage,
  EnclaveMidTurnMessagesResponse,
  UpdateStreamInput,
  UpdateCompanionModeInput,
  StreamBootstrap,
  BotRuntimePresenceSummary,
  StreamContextBagPayload,
  StreamContextRef,
  StreamContextRefSource,
  EventsAroundResponse,
  EventsAroundDateResponse,
  // Sync log catch-up
  SyncCatchUpEntry,
  SyncCatchUpResponse,
  SyncHeartbeatPayload,
  // Messages
  ComposeTrace,
  ConversationDirective,
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
  CapturedMemoSummary,
  MemosCapturedEventPayload,
  AgentFollowUpScheduledEventPayload,
  AgentFollowUpCancelledEventPayload,
  DelegationCreatedEventPayload,
  DelegationStatusChangedEventPayload,
  BotAccessRequestedEventPayload,
  BotAccessStatusChangedEventPayload,
  CallStartedEventPayload,
  CallEndedEventPayload,
  DelegationSummary,
  ListDelegationsResponse,
  DescriptionSetEventPayload,
  BriefUpdatedEventPayload,
  // Workspaces
  CreateWorkspaceInput,
  WorkspaceBootstrap,
  StreamReadFrontier,
  StreamReadFrontierSnapshot,
  MarkAllAsReadResponse,
  MarkAsReadResponse,
  ActiveAgentSession,
  ActiveCall,
  StreamActiveCall,
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
  ActivityReadPayload,
  // Saved messages
  SavedMessageView,
  SavedMessageSnapshot,
  SaveMessageInput,
  UpdateSavedMessageInput,
  SavedMessageListResponse,
  SavedUpsertedPayload,
  SavedDeletedPayload,
  SavedReminderFiredPayload,
  BoardConversationHideChangedPayload,
  BoardStreamMuteChangedPayload,
  // Saved suggestions
  SavedSuggestionView,
  SavedSuggestionListResponse,
  AcceptSavedSuggestionResponse,
  SavedSuggestionUpsertedPayload,
  // Scheduled messages
  ScheduledMessageView,
  ScheduleMessageInput,
  UpdateScheduledMessageInput,
  LockScheduledMessageResponse,
  ScheduledMessageListResponse,
  ScheduledMessageUpsertedPayload,
  ScheduledMessageSentPayload,
  ScheduledMessageCancelledPayload,
  // Drafts
  DraftScope,
  DraftCommand,
  Draft,
  UpsertDraftInput,
  UpsertDraftResponse,
  ResolveDraftInput,
  ResolveDraftResponse,
  DeleteDraftInput,
  DraftListResponse,
  DraftUpsertedPayload,
  DraftDeletedPayload,
  EnclaveRewrapNeededPayload,
  // Labels
  CreateLabelInput,
  UpdateLabelInput,
  LabelUpsertedPayload,
  LabelDeletedPayload,
  LabelAssignedPayload,
  LabelUnassignedPayload,
  // Emojis
  EmojiEntry,
  // Giphy
  GiphyGif,
  GiphySearchResponse,
  GiphyConfigResponse,
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
  AsideAnchoredEventPayload,
  // AI Usage
  AIUsageSummary,
  AIUsageOrigin,
  AIUsageByOrigin,
  AIUsageByUser,
  AIUsageCategory,
  AIUsageByFunction,
  AIUsageByModel,
  AIUsageByDay,
  AIUsageRecord,
  AIUsageResponse,
  AIRecentUsageResponse,
  AIBudgetConfig,
  AIBudgetResponse,
  UpdateAIBudgetInput,
} from "./api"

export {
  ENCLAVE_NAMING_CHECKPOINTS,
  EnclaveNamingInstructionSchema,
  EnclaveNamingDecisionSchema,
  type EnclaveNamingInstruction,
  type EnclaveNamingDecision,
} from "./enclave-naming"

// Slots — canonical hydration envelope for renderable pointers
export type { Slot, SharedMessageSlot, SlotMap, SharedMessageRef } from "./slots"
export { sharedMessageSlotKey, parseSharedMessageSlotKey } from "./slots"

// Push Notifications
export { DEVICE_KEY_LENGTH } from "./api"

// AI usage category constants
export { AI_USAGE_CATEGORIES } from "./api"

// Command kind constants
export { CommandKinds, CommandScopes } from "./api"

// Draft scope builders (single source of truth for the scope string format)
// and the shared bootstrap cap (the client must know when a snapshot is truncated)
export {
  draftStreamScope,
  draftThreadScope,
  asideDraftScope,
  asideDraftScopePrefix,
  parseAsideDraftScope,
  isAsideDraftScope,
  type AsideDraftScope,
  MAX_DRAFTS_PER_USER,
  MAX_SEARCH_PHRASES,
} from "./api"

// Open-an-aside client-action id (single source of truth)
export const ASIDE_COMMAND = "aside" as const

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
  ContentRange,
  ThreaQuoteReply,
  ThreaAgentBlock,
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

// Authoritative actor/stream references for mentions/channel links (INV-64)
export {
  MENTION_BROADCAST_HERE,
  MENTION_BROADCAST_CHANNEL,
  isResolvedMentionId,
  isResolvedChannelLinkId,
  actorTypeFromMentionId,
} from "./actor-ref"
export type { MentionActorType, MentionActorRef } from "./actor-ref"

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
  // Composer action side
  COMPOSER_ACTION_SIDE_OPTIONS,
  type ComposerActionSide,
  ComposerActionSides,
  // Link preview default
  LINK_PREVIEW_DEFAULT_OPTIONS,
  type LinkPreviewDefault,
  LinkPreviewDefaults,
  // Label-remove-on-move behavior
  LABEL_REMOVE_ON_MOVE_OPTIONS,
  type LabelRemoveOnMove,
  LabelRemoveOnMoveOptions,
  // Unread open position
  UNREAD_OPEN_POSITION_OPTIONS,
  type UnreadOpenPosition,
  UnreadOpenPositions,
  // Code block collapse threshold
  CODE_BLOCK_COLLAPSE_THRESHOLD_MIN,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  // Blockquote collapse threshold
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  // Code block wrapping
  CODE_BLOCK_WRAP_OPTIONS,
  DEFAULT_CODE_BLOCK_WRAP,
  type CodeBlockWrap,
  resolveCodeBlockWrap,
  DEFAULT_DESCRIPTION_COLLAPSE_THRESHOLD,
  // Message collapse settings
  MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
  MESSAGE_COLLAPSE_AT_HEIGHT_MAX,
  DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
  MESSAGE_COLLAPSE_TO_HEIGHT_MAX,
  DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  MESSAGE_COLLAPSE_THRESHOLD_MIN,
  MESSAGE_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_MESSAGE_COLLAPSE_THRESHOLD,
  // Board card collapse settings
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX,
  DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX,
  DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT,
  BOARD_CARD_COLLAPSE_THRESHOLD_MIN,
  BOARD_CARD_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD,
  // Board ledger settings
  BOARD_FULL_TAIL_COUNT_MIN,
  BOARD_FULL_TAIL_COUNT_MAX,
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  BOARD_LEDGER_ROWS_MIN,
  BOARD_LEDGER_ROWS_MAX,
  DEFAULT_BOARD_LEDGER_ROWS,
  BOARD_LEAD_LINE_LENGTH_MIN,
  BOARD_LEAD_LINE_LENGTH_MAX,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
  BOARD_MASS_BADGE_MODES,
  DEFAULT_BOARD_MASS_BADGE,
  normalizeBoardMassBadge,
  type BoardMassBadge,
  // Voice transcription model picker
  VOICE_TRANSCRIPTION_MODELS,
  type VoiceTranscriptionModelOption,
  // Voice polish level
  VOICE_POLISH_LEVEL_OPTIONS,
  type VoicePolishLevel,
  VoicePolishLevels,
  // Voice steering words
  VOICE_STEERING_WORDS_MAX,
  VOICE_STEERING_WORD_MAX_LENGTH,
  VOICE_STEERING_BASE_TERMS,
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
  // What an agent may change on the user's behalf
  AGENT_SETTABLE_PREFERENCE_KEYS,
  type AgentSettablePreferenceKey,
  type AgentSettablePreferences,
} from "./preferences"

// Work schedule (working week + working hours)
export {
  type Weekday,
  WEEKDAYS,
  WEEKDAYS_MONDAY_FIRST,
  type ShiftInterval,
  type WorkSchedule,
  DEFAULT_WORK_SCHEDULE,
  parseHHMM,
  minutesToHHMM,
  getDayShifts,
  isWorkingDay,
  workingDays,
  startOfWorkMinutes,
  typicalStartMinutes,
  startOfWorkForDay,
  firstWorkingWeekday,
} from "./work-schedule"

// Workspace settings
export {
  type WorkspaceSettings,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_MAX_PENDING_FOLLOW_UPS,
  MAX_PENDING_FOLLOW_UPS_MIN,
  MAX_PENDING_FOLLOW_UPS_MAX,
  type UpdateWorkspaceSettingsInput,
  type WorkspaceSettingKey,
} from "./workspace-settings"

// Persona config editing (INV-31: shared editable-field patch schema; model
// allowlist is registry-derived server-side and rides on the config response)
export {
  type PersonaModelOption,
  PERSONA_SYSTEM_PROMPT_MAX_CHARS,
  PERSONA_SLOT_MAX_CHARS,
  PERSONA_NAME_MAX_CHARS,
  PERSONA_DESCRIPTION_MAX_CHARS,
  SYSTEM_PERSONA_EDITABLE_FIELDS,
  type SystemPersonaEditableField,
  personaConfigPatchSchema,
  type PersonaConfigPatch,
  personaCustomConfigSchema,
  type PersonaCustomConfig,
  personaConfigStatusSchema,
  personaResolvedConfigSchema,
  type PersonaResolvedConfig,
  type PersonaKind,
  type PersonaListItem,
  type PersonaDraftState,
  type PersonaConfigResponse,
  type PersonaConfigRevision,
  PERSONA_REVISION_AUTHOR_KINDS,
  type PersonaRevisionAuthorKind,
  type RestorePersonaRevisionInput,
  type UpdatePersonaOverrideInput,
  type ForkPersonaInput,
  type UpdatePersonaCustomInput,
  PERSONA_ATTACHMENT_MAX_COUNT,
  PERSONA_ATTACHMENT_MAX_SIZE_BYTES,
  PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES,
  PERSONA_ATTACHMENT_ALLOWED_MIME_PREFIXES,
  isPersonaAttachmentMimeAllowed,
  PERSONA_ATTACHMENT_PROCESSING_STATUSES,
  type PersonaAttachmentProcessingStatus,
  PERSONA_ATTACHMENT_CONTEXT_MODES,
  type PersonaAttachmentContextMode,
  type PersonaAttachmentItem,
} from "./persona-config"

// Feature flags (scoped rollout switches, managed from the backoffice)
export {
  FEATURE_FLAGS,
  FEATURE_FLAG_DEFINITIONS,
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_SCOPES,
  type FeatureFlagKey,
  type FeatureFlagValue,
  type FeatureFlags,
  type FeatureFlagScope,
  type FeatureFlagDefinition,
  type FeatureFlagLayers,
  defineFlag,
  isFeatureFlagKey,
  isFeatureFlagValue,
  flagAllowsScope,
  defaultFeatureFlagValue,
  defaultFeatureFlags,
  resolveFeatureFlags,
  coerceLayers,
} from "./feature-flags"

// Client performance capture (closed mark registry + wire schema)
export {
  PERF_MARK_NAMES,
  PERF_DEVICE_CLASSES,
  PERF_CAPTURE_MAX_SAMPLES,
  performanceSampleSchema,
  performanceCaptureSchema,
  type PerfMarkName,
  type PerfDeviceClass,
  type PerformanceSample,
  type PerformanceCapture,
} from "./performance-capture"

// User statuses (cosmetic emoji + text shown beside the avatar)
export {
  type StatusDuration,
  type StatusPreset,
  type ActiveStatus,
  type UserStatusFields,
  type UserNotificationPauseFields,
  type ActiveNotificationPause,
  type NotificationPauseSource,
  isStatusContentful,
  resolveActiveStatus,
  resolveNotificationPause,
  presetPausesNotifications,
  SYSTEM_DEFAULT_STATUSES,
  STATUS_TEXT_MAX_LENGTH,
  MAX_STATUS_PRESETS,
} from "./user-status"

// Sidebar configuration
export {
  SIDEBAR_SECTION_KEYS,
  type SidebarSectionKey,
  SIDEBAR_TYPE_SECTIONS,
  type SidebarTypeSection,
  MAX_CUSTOM_SECTION_NAME_LENGTH,
  MAX_CUSTOM_SECTION_STREAM_IDS,
  type SidebarSectionSpec,
  type SidebarSection,
  SIDEBAR_BASE_PRESETS,
  type SidebarBasePreset,
  SIDEBAR_QUICK_LINKS,
  type SidebarQuickLinkKey,
  QUICK_LINKS_SECTION_ID,
  SIDEBAR_QUICK_LINKS_WITH_ACTIVE_STATE,
  type SidebarActiveQuickLinkKey,
  quickLinkHasActiveState,
  isKnownQuickLinkKey,
  SIDEBAR_QUICK_LINK_VISIBILITIES,
  type SidebarQuickLinkVisibility,
  type SidebarQuickLink,
  DEFAULT_QUICK_LINKS,
  SIDEBAR_CONFIG_VERSION,
  type SidebarConfig,
  type StoredQuickLink,
  type RawSidebarConfig,
  normalizeSidebarConfig,
  SMART_SIDEBAR_CONFIG,
  ALL_SIDEBAR_CONFIG,
  sidebarConfigForPreset,
  DEFAULT_SIDEBAR_CONFIG,
} from "./sidebar"

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

// Dated public-API versions (Threa-Version header)
export { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion } from "./api-versions"

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
  type ThreadContextRef,
  type ConversationContextRef,
  type ViewportContextRef,
  VIEWPORT_MAX_VISIBLE_IDS,
  type ContextBag,
} from "./context-bag"

// Agent trace types
export {
  TRACE_SOURCE_TYPES,
  type TraceSourceType,
  type TraceSource,
  type TurnDigestStepContent,
  type AgentSessionRerunCause,
  type AgentSessionRerunContext,
  type AgentSessionStep,
  type AgentSession,
  type AgentSessionWithSteps,
  type AgentActivityUpdate,
  type AgentSessionStartedPayload,
  type AgentSessionCompletedPayload,
  type AgentSessionFailedPayload,
  type AgentSessionInterruptedPayload,
  type AgentSessionDeletedPayload,
  type AgentSessionProgressPayload,
  type AgentSessionSubstepPayload,
  type StepStartedPayload,
  type StepProgressPayload,
  type StepCompletedPayload,
  type StepVerificationPayload,
  type SessionTerminalPayload,
  type AgentActivityStartedPayload,
  type AgentActivityEndedPayload,
} from "./agent-trace"

// Agent outcomes (follow-ups + delegations)
export {
  AGENT_OUTCOME_KINDS,
  AGENT_OUTCOME_STATES,
  AGENT_OUTCOME_SCOPES,
  type AgentOutcomeKind,
  type AgentOutcomeState,
  type AgentOutcomeScope,
  type AgentOutcomeSummary,
  type FollowUpOutcomeSummary,
  type DelegationOutcomeSummary,
  type ListAgentOutcomesResponse,
} from "./agent-outcomes"

// "In this stream" context index
export {
  CONTEXT_CATEGORIES,
  STREAM_CONTEXT_REF_KINDS,
  MESSAGE_BODY_CONTEXT_CATEGORIES,
  STREAM_CONTEXT_SCOPES,
  streamContextItemKey,
  type ContextCategory,
  type StreamContextRefKind,
  type StreamContextScope,
  type StreamContextItem,
  type StreamContextItemDetail,
  type StreamContextLinkDetail,
  type StreamContextAttachmentDetail,
  type StreamContextMemoDetail,
  type StreamContextDelegationDetail,
  type StreamContextFollowUpDetail,
  type StreamContextThreadDetail,
  type ListStreamContextResponse,
  type ListStreamContextOccurrencesResponse,
} from "./stream-context"

export {
  CODE_LANGUAGES,
  CODE_LANGUAGE_IDS,
  CODE_LANGUAGE_PRELOAD_IDS,
  PLAINTEXT_LANGUAGE_ID,
  type CodeLanguage,
  type CodeLanguageId,
  formatCodeLanguage,
  normalizeCodeLanguage,
} from "./code-languages"
