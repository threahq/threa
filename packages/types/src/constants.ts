// Stream types
export const STREAM_TYPES = ["scratchpad", "channel", "dm", "thread", "system"] as const
export type StreamType = (typeof STREAM_TYPES)[number]

export const StreamTypes = {
  SCRATCHPAD: "scratchpad",
  CHANNEL: "channel",
  DM: "dm",
  THREAD: "thread",
  SYSTEM: "system",
} as const satisfies Record<string, StreamType>

export const DM_PARTICIPANT_COUNT = 2

// Visibility
export const VISIBILITY_OPTIONS = ["public", "private"] as const
export type Visibility = (typeof VISIBILITY_OPTIONS)[number]

export const Visibilities = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const satisfies Record<string, Visibility>

// Labelable resource types — the polymorphic target of a label assignment.
// Labeling is resource-agnostic: the table, service, events, sync, and UI
// primitives are identical for every type. This set only gates which targets
// the API accepts today; adding "message" | "user" | "attachment" later is a
// one-line change here plus a presentation adapter — no new mechanism.
export const LABELABLE_RESOURCE_TYPES = ["stream"] as const
export type LabelableResourceType = (typeof LABELABLE_RESOURCE_TYPES)[number]

export const LabelableResourceTypes = {
  STREAM: "stream",
} as const satisfies Record<string, LabelableResourceType>

// Companion modes
export const COMPANION_MODES = ["off", "on"] as const
export type CompanionMode = (typeof COMPANION_MODES)[number]

export const CompanionModes = {
  OFF: "off",
  ON: "on",
} as const satisfies Record<string, CompanionMode>

// Content formats
export const CONTENT_FORMATS = ["plaintext", "markdown"] as const
export type ContentFormat = (typeof CONTENT_FORMATS)[number]

// Author types
export const AUTHOR_TYPES = ["user", "persona", "system", "bot"] as const
export type AuthorType = (typeof AUTHOR_TYPES)[number]

export const AuthorTypes = {
  USER: "user",
  PERSONA: "persona",
  SYSTEM: "system",
  BOT: "bot",
} as const satisfies Record<string, AuthorType>

// Event types
export const EVENT_TYPES = [
  "message_created",
  "message_edited",
  "message_deleted",
  "reaction_added",
  "reaction_removed",
  "member_joined",
  "member_added",
  "member_left",
  "thread_created",
  "stream_archived",
  "stream_unarchived",
  "companion_response",
  "command_dispatched",
  "command_completed",
  "command_failed",
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
  "agent_session:deleted",
  "messages:moved",
] as const
export type EventType = (typeof EVENT_TYPES)[number]

// Command event types (subset of EVENT_TYPES for command lifecycle)
export const COMMAND_EVENT_TYPES = ["command_dispatched", "command_completed", "command_failed"] as const
export type CommandEventType = (typeof COMMAND_EVENT_TYPES)[number]

// Workspace user roles — re-exported from workspace-permissions so the catalog
// (`WORKSPACE_ROLE_DEFINITIONS`) and the User.role union cannot drift.
export { WORKSPACE_USER_ROLES, type WorkspaceRoleSlug } from "./workspace-permissions"

// Notification levels (per-stream member preference)
export const NOTIFICATION_LEVELS = ["everything", "activity", "mentions", "muted"] as const
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]

export const NotificationLevels = {
  EVERYTHING: "everything",
  ACTIVITY: "activity",
  MENTIONS: "mentions",
  MUTED: "muted",
} as const satisfies Record<string, NotificationLevel>

/** Per-stream-type notification config: which levels are allowed and what the default is */
export interface NotificationConfig {
  defaultLevel: NotificationLevel
  allowedLevels: readonly NotificationLevel[]
}

export const NOTIFICATION_CONFIG: Record<StreamType, NotificationConfig> = {
  scratchpad: { defaultLevel: "everything", allowedLevels: ["everything", "muted"] },
  dm: { defaultLevel: "everything", allowedLevels: ["everything", "muted"] },
  system: { defaultLevel: "everything", allowedLevels: ["everything", "muted"] },
  channel: { defaultLevel: "mentions", allowedLevels: ["everything", "activity", "mentions", "muted"] },
  thread: { defaultLevel: "activity", allowedLevels: ["everything", "activity", "mentions", "muted"] },
}

// Activity types
export const ACTIVITY_TYPES = ["mention", "message", "reaction", "saved_reminder", "member_added"] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export const ActivityTypes = {
  MENTION: "mention",
  MESSAGE: "message",
  REACTION: "reaction",
  SAVED_REMINDER: "saved_reminder",
  MEMBER_ADDED: "member_added",
} as const satisfies Record<string, ActivityType>

// Saved message statuses
export const SAVED_STATUSES = ["saved", "done", "archived"] as const
export type SavedStatus = (typeof SAVED_STATUSES)[number]

export const SavedStatuses = {
  SAVED: "saved",
  DONE: "done",
  ARCHIVED: "archived",
} as const satisfies Record<string, SavedStatus>

// Scheduled message statuses
export const SCHEDULED_MESSAGE_STATUSES = ["pending", "sending", "sent", "cancelled", "failed"] as const
export type ScheduledMessageStatus = (typeof SCHEDULED_MESSAGE_STATUSES)[number]

export const ScheduledMessageStatuses = {
  PENDING: "pending",
  SENDING: "sending",
  SENT: "sent",
  CANCELLED: "cancelled",
  FAILED: "failed",
} as const satisfies Record<string, ScheduledMessageStatus>

// Invitation statuses
export const INVITATION_STATUSES = ["pending", "accepted", "expired", "revoked"] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

export const InvitationStatuses = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const satisfies Record<string, InvitationStatus>

// Persona managed by
export const PERSONA_MANAGED_BY = ["system", "workspace"] as const
export type PersonaManagedBy = (typeof PERSONA_MANAGED_BY)[number]

// Persona status
export const PERSONA_STATUSES = ["pending", "active", "disabled", "archived"] as const
export type PersonaStatus = (typeof PERSONA_STATUSES)[number]

// Attachment storage providers
export const STORAGE_PROVIDERS = ["s3"] as const
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number]

// Attachment processing status
export const PROCESSING_STATUSES = ["pending", "processing", "completed", "failed", "skipped"] as const
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number]

export const ProcessingStatuses = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const satisfies Record<string, ProcessingStatus>

// Attachment malware safety status
export const ATTACHMENT_SAFETY_STATUSES = ["pending_scan", "clean", "quarantined", "e2e_unscanned"] as const
export type AttachmentSafetyStatus = (typeof ATTACHMENT_SAFETY_STATUSES)[number]

export const AttachmentSafetyStatuses = {
  PENDING_SCAN: "pending_scan",
  CLEAN: "clean",
  QUARANTINED: "quarantined",
  /**
   * E2E attachment: the bytes in S3 are client-side ciphertext, so the malware
   * scanner can't read them. We don't scan and say so — never a faked `clean`.
   * Download is allowed (it's the owner's own ciphertext); processors skip.
   */
  E2E_UNSCANNED: "e2e_unscanned",
} as const satisfies Record<string, AttachmentSafetyStatus>

// Video transcode job status
export const VIDEO_TRANSCODE_STATUSES = ["pending", "submitted", "completed", "failed"] as const
export type VideoTranscodeStatus = (typeof VIDEO_TRANSCODE_STATUSES)[number]

export const VideoTranscodeStatuses = {
  PENDING: "pending",
  SUBMITTED: "submitted",
  COMPLETED: "completed",
  FAILED: "failed",
} as const satisfies Record<string, VideoTranscodeStatus>

// Extraction content types (for image/document analysis)
export const EXTRACTION_CONTENT_TYPES = [
  "chart",
  "table",
  "diagram",
  "screenshot",
  "photo",
  "document",
  "other",
] as const
export type ExtractionContentType = (typeof EXTRACTION_CONTENT_TYPES)[number]

export const ExtractionContentTypes = {
  CHART: "chart",
  TABLE: "table",
  DIAGRAM: "diagram",
  SCREENSHOT: "screenshot",
  PHOTO: "photo",
  DOCUMENT: "document",
  OTHER: "other",
} as const satisfies Record<string, ExtractionContentType>

// Conversation status
export const CONVERSATION_STATUSES = ["active", "stalled", "resolved"] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

export const ConversationStatuses = {
  ACTIVE: "active",
  STALLED: "stalled",
  RESOLVED: "resolved",
} as const satisfies Record<string, ConversationStatus>

// Memo types (GAM)
export const MEMO_TYPES = ["message", "conversation"] as const
export type MemoType = (typeof MEMO_TYPES)[number]

export const MemoTypes = {
  MESSAGE: "message",
  CONVERSATION: "conversation",
} as const satisfies Record<string, MemoType>

// Knowledge types (classification categories)
export const KNOWLEDGE_TYPES = ["decision", "learning", "procedure", "context", "reference"] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

export const KnowledgeTypes = {
  DECISION: "decision",
  LEARNING: "learning",
  PROCEDURE: "procedure",
  CONTEXT: "context",
  REFERENCE: "reference",
} as const satisfies Record<string, KnowledgeType>

// Memo statuses (lifecycle)
export const MEMO_STATUSES = ["draft", "active", "archived", "superseded"] as const
export type MemoStatus = (typeof MEMO_STATUSES)[number]

export const MemoStatuses = {
  DRAFT: "draft",
  ACTIVE: "active",
  ARCHIVED: "archived",
  SUPERSEDED: "superseded",
} as const satisfies Record<string, MemoStatus>

// Pending memo item types
export const PENDING_ITEM_TYPES = ["message", "conversation"] as const
export type PendingItemType = (typeof PENDING_ITEM_TYPES)[number]

// Agent tool names
export const AGENT_TOOL_NAMES = [
  "send_message",
  "web_search",
  "read_url",
  "general_research",
  "search_messages",
  "search_streams",
  "search_users",
  "get_stream_messages",
  "search_attachments",
  "get_attachment",
  "load_attachment",
  "load_pdf_section",
  "load_file_section",
  "load_excel_section",
  "describe_memo",
  "github_list_repos",
  "github_list_branches",
  "github_list_commits",
  "github_get_commit",
  "github_list_pull_requests",
  "github_get_pull_request",
  "github_list_pr_files",
  "github_get_file_contents",
  "github_search_code",
  "github_list_workflow_runs",
  "github_get_workflow_run",
  "github_list_releases",
  "github_get_release",
  "github_search_issues",
  "github_get_issue",
  "linear_list_issues",
  "linear_get_issue",
  "linear_list_projects",
  "linear_get_project",
] as const
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

export const AgentToolNames = {
  SEND_MESSAGE: "send_message",
  WEB_SEARCH: "web_search",
  READ_URL: "read_url",
  GENERAL_RESEARCH: "general_research",
  SEARCH_MESSAGES: "search_messages",
  SEARCH_STREAMS: "search_streams",
  SEARCH_USERS: "search_users",
  GET_STREAM_MESSAGES: "get_stream_messages",
  SEARCH_ATTACHMENTS: "search_attachments",
  GET_ATTACHMENT: "get_attachment",
  LOAD_ATTACHMENT: "load_attachment",
  LOAD_PDF_SECTION: "load_pdf_section",
  LOAD_FILE_SECTION: "load_file_section",
  LOAD_EXCEL_SECTION: "load_excel_section",
  DESCRIBE_MEMO: "describe_memo",
  GITHUB_LIST_REPOS: "github_list_repos",
  GITHUB_LIST_BRANCHES: "github_list_branches",
  GITHUB_LIST_COMMITS: "github_list_commits",
  GITHUB_GET_COMMIT: "github_get_commit",
  GITHUB_LIST_PULL_REQUESTS: "github_list_pull_requests",
  GITHUB_GET_PULL_REQUEST: "github_get_pull_request",
  GITHUB_LIST_PR_FILES: "github_list_pr_files",
  GITHUB_GET_FILE_CONTENTS: "github_get_file_contents",
  GITHUB_SEARCH_CODE: "github_search_code",
  GITHUB_LIST_WORKFLOW_RUNS: "github_list_workflow_runs",
  GITHUB_GET_WORKFLOW_RUN: "github_get_workflow_run",
  GITHUB_LIST_RELEASES: "github_list_releases",
  GITHUB_GET_RELEASE: "github_get_release",
  GITHUB_SEARCH_ISSUES: "github_search_issues",
  GITHUB_GET_ISSUE: "github_get_issue",
  LINEAR_LIST_ISSUES: "linear_list_issues",
  LINEAR_GET_ISSUE: "linear_get_issue",
  LINEAR_LIST_PROJECTS: "linear_list_projects",
  LINEAR_GET_PROJECT: "linear_get_project",
} as const satisfies Record<string, AgentToolName>

// Source types for message citations
export const SOURCE_TYPES = ["web", "workspace", "github"] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const SourceTypes = {
  WEB: "web",
  WORKSPACE: "workspace",
  GITHUB: "github",
} as const satisfies Record<string, SourceType>

// Agent invocation triggers
export const AGENT_TRIGGERS = ["mention", "companion"] as const
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number]

export const AgentTriggers = {
  MENTION: "mention",
  COMPANION: "companion",
} as const satisfies Record<string, AgentTrigger>

// Agent session event types (stream events for session lifecycle)
export const AGENT_SESSION_EVENT_TYPES = [
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
  "agent_session:deleted",
] as const
export type AgentSessionEventType = (typeof AGENT_SESSION_EVENT_TYPES)[number]

// Agent step types (semantic - frontend maps to display labels)
export const AGENT_STEP_TYPES = [
  "context_received",
  "thinking",
  "reconsidering",
  "web_search",
  "visit_page",
  "workspace_search",
  "research",
  "github_access",
  "linear_access",
  "message_sent",
  "message_edited",
  "response",
  "tool_call",
  "tool_error",
  "rate_limited",
  "rate_limit_retry",
] as const
export type AgentStepType = (typeof AGENT_STEP_TYPES)[number]

export const AgentStepTypes = {
  CONTEXT_RECEIVED: "context_received",
  THINKING: "thinking",
  RECONSIDERING: "reconsidering",
  WEB_SEARCH: "web_search",
  VISIT_PAGE: "visit_page",
  WORKSPACE_SEARCH: "workspace_search",
  RESEARCH: "research",
  GITHUB_ACCESS: "github_access",
  LINEAR_ACCESS: "linear_access",
  MESSAGE_SENT: "message_sent",
  MESSAGE_EDITED: "message_edited",
  RESPONSE: "response",
  TOOL_CALL: "tool_call",
  TOOL_ERROR: "tool_error",
  RATE_LIMITED: "rate_limited",
  RATE_LIMIT_RETRY: "rate_limit_retry",
} as const satisfies Record<string, AgentStepType>

// Agent reconsideration decision values
export const AGENT_RECONSIDERATION_DECISIONS = ["kept_previous_response"] as const
export type AgentReconsiderationDecision = (typeof AGENT_RECONSIDERATION_DECISIONS)[number]

export const AgentReconsiderationDecisions = {
  KEPT_PREVIOUS_RESPONSE: "kept_previous_response",
} as const satisfies Record<string, AgentReconsiderationDecision>

// Agent session statuses
export const AGENT_SESSION_STATUSES = ["pending", "running", "completed", "failed", "deleted", "superseded"] as const
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number]

export const AgentSessionStatuses = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  DELETED: "deleted",
  SUPERSEDED: "superseded",
} as const satisfies Record<string, AgentSessionStatus>

// PDF page classifications
export const PDF_PAGE_CLASSIFICATIONS = ["text_rich", "scanned", "complex_layout", "mixed", "empty"] as const
export type PdfPageClassification = (typeof PDF_PAGE_CLASSIFICATIONS)[number]

export const PdfPageClassifications = {
  TEXT_RICH: "text_rich",
  SCANNED: "scanned",
  COMPLEX_LAYOUT: "complex_layout",
  MIXED: "mixed",
  EMPTY: "empty",
} as const satisfies Record<string, PdfPageClassification>

// PDF processing job statuses (fan-out/fan-in coordination)
export const PDF_JOB_STATUSES = ["preparing", "processing_pages", "assembling", "completed", "failed"] as const
export type PdfJobStatus = (typeof PDF_JOB_STATUSES)[number]

export const PdfJobStatuses = {
  PREPARING: "preparing",
  PROCESSING_PAGES: "processing_pages",
  ASSEMBLING: "assembling",
  COMPLETED: "completed",
  FAILED: "failed",
} as const satisfies Record<string, PdfJobStatus>

// PDF size tiers (determines injection strategy)
export const PDF_SIZE_TIERS = ["small", "medium", "large"] as const
export type PdfSizeTier = (typeof PDF_SIZE_TIERS)[number]

export const PdfSizeTiers = {
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
} as const satisfies Record<string, PdfSizeTier>

// Extraction source types (image, PDF, text, Word, or Excel)
export const EXTRACTION_SOURCE_TYPES = ["image", "pdf", "text", "word", "excel"] as const
export type ExtractionSourceType = (typeof EXTRACTION_SOURCE_TYPES)[number]

export const ExtractionSourceTypes = {
  IMAGE: "image",
  PDF: "pdf",
  TEXT: "text",
  WORD: "word",
  EXCEL: "excel",
} as const satisfies Record<string, ExtractionSourceType>

// Text file formats (plain is fallback for ALL unrecognized text formats)
export const TEXT_FORMATS = ["plain", "markdown", "json", "yaml", "csv", "code"] as const
export type TextFormat = (typeof TEXT_FORMATS)[number]

export const TextFormats = {
  PLAIN: "plain",
  MARKDOWN: "markdown",
  JSON: "json",
  YAML: "yaml",
  CSV: "csv",
  CODE: "code",
} as const satisfies Record<string, TextFormat>

// Text size tiers (determines injection strategy)
export const TEXT_SIZE_TIERS = ["small", "medium", "large"] as const
export type TextSizeTier = (typeof TEXT_SIZE_TIERS)[number]

export const TextSizeTiers = {
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
} as const satisfies Record<string, TextSizeTier>

// Context injection strategies for text files
export const INJECTION_STRATEGIES = ["full", "full_with_note", "summary"] as const
export type InjectionStrategy = (typeof INJECTION_STRATEGIES)[number]

export const InjectionStrategies = {
  FULL: "full",
  FULL_WITH_NOTE: "full_with_note",
  SUMMARY: "summary",
} as const satisfies Record<string, InjectionStrategy>

// Workspace integration providers
export const WORKSPACE_INTEGRATION_PROVIDERS = ["github", "linear"] as const
export type WorkspaceIntegrationProvider = (typeof WORKSPACE_INTEGRATION_PROVIDERS)[number]

export const WorkspaceIntegrationProviders = {
  GITHUB: "github",
  LINEAR: "linear",
} as const satisfies Record<string, WorkspaceIntegrationProvider>

// Workspace integration lifecycle statuses
export const WORKSPACE_INTEGRATION_STATUSES = ["active", "inactive", "error"] as const
export type WorkspaceIntegrationStatus = (typeof WORKSPACE_INTEGRATION_STATUSES)[number]

export const WorkspaceIntegrationStatuses = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  ERROR: "error",
} as const satisfies Record<string, WorkspaceIntegrationStatus>

// Link preview content types
export const LINK_PREVIEW_CONTENT_TYPES = ["website", "pdf", "image", "message_link"] as const
export type LinkPreviewContentType = (typeof LINK_PREVIEW_CONTENT_TYPES)[number]

export const LinkPreviewContentTypes = {
  WEBSITE: "website",
  PDF: "pdf",
  IMAGE: "image",
  MESSAGE_LINK: "message_link",
} as const satisfies Record<string, LinkPreviewContentType>

// Link preview fetch statuses
export const LINK_PREVIEW_STATUSES = ["pending", "completed", "failed"] as const
export type LinkPreviewStatus = (typeof LINK_PREVIEW_STATUSES)[number]

export const LinkPreviewStatuses = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
} as const satisfies Record<string, LinkPreviewStatus>

// Rich GitHub preview variants returned through the link preview pipeline
export const GITHUB_PREVIEW_TYPES = [
  "github_pr",
  "github_issue",
  "github_commit",
  "github_file",
  "github_diff",
  "github_comment",
] as const
export type GitHubPreviewType = (typeof GITHUB_PREVIEW_TYPES)[number]

export const GitHubPreviewTypes = {
  PR: "github_pr",
  ISSUE: "github_issue",
  COMMIT: "github_commit",
  FILE: "github_file",
  DIFF: "github_diff",
  COMMENT: "github_comment",
} as const satisfies Record<string, GitHubPreviewType>

// Rich Linear preview variants returned through the link preview pipeline
export const LINEAR_PREVIEW_TYPES = ["linear_issue", "linear_comment", "linear_project", "linear_document"] as const
export type LinearPreviewType = (typeof LINEAR_PREVIEW_TYPES)[number]

export const LinearPreviewTypes = {
  ISSUE: "linear_issue",
  COMMENT: "linear_comment",
  PROJECT: "linear_project",
  DOCUMENT: "linear_document",
} as const satisfies Record<string, LinearPreviewType>

// Share flavors (cross-stream message sharing)
export const SHARE_FLAVORS = ["pointer", "quote"] as const
export type ShareFlavor = (typeof SHARE_FLAVORS)[number]

export const ShareFlavors = {
  POINTER: "pointer",
  QUOTE: "quote",
} as const satisfies Record<string, ShareFlavor>

/**
 * Wire-format error codes for the sharing feature. Centralised here because
 * the privacy-confirmation code is matched on by the frontend message queue
 * to surface the "Share anyway" / "Cancel" toast — keeping it as a magic
 * string in two places would let typos drift the contract silently.
 */
export const ShareErrorCodes = {
  PRIVACY_CONFIRMATION_REQUIRED: "SHARE_PRIVACY_CONFIRMATION_REQUIRED",
  SOURCE_MESSAGE_NOT_FOUND: "SHARE_SOURCE_MESSAGE_NOT_FOUND",
  SOURCE_STREAM_MISMATCH: "SHARE_SOURCE_STREAM_MISMATCH",
  SOURCE_STREAM_NOT_FOUND: "SHARE_SOURCE_STREAM_NOT_FOUND",
  CROSS_WORKSPACE_FORBIDDEN: "SHARE_CROSS_WORKSPACE_FORBIDDEN",
  SOURCE_FORBIDDEN: "SHARE_SOURCE_FORBIDDEN",
  E2E_SHARING_NOT_ALLOWED: "SHARE_E2E_NOT_ALLOWED",
} as const

// Inter-service authentication header (control-plane ↔ regional backend ↔ workspace-router)
export const INTERNAL_API_KEY_HEADER = "X-Internal-Api-Key"

// Kinds of non-human actor that can be invited into an E2E stream. Each invited
// actor gets the stream key (SSK) wrapped to it and may reply. Humans are not
// actors here — they live in `stream_members` with a different identity and
// lifecycle. The set of invited actors lives in `e2e_stream_actors`; an empty
// set means the stream is owner-only (no agent).
//   - "bot"     — Pi-style remote runtime (Phase 2).
//   - "enclave" — first-party Ariadne running in the enclave service (Phase 5a).
export const E2E_ACTOR_KINDS = ["bot", "enclave"] as const
export type E2eActorKind = (typeof E2E_ACTOR_KINDS)[number]

export const E2eActorKinds = {
  BOT: "bot",
  ENCLAVE: "enclave",
} as const satisfies Record<string, E2eActorKind>

// The `actor_id` pinned on an E2E stream's enclave actor row. The enclave is a
// single first-party service (one logical Ariadne, many ephemeral EIK
// instances), so it needs no per-instance id — this fixed sentinel keeps the
// (workspace, stream, kind, actor_id) primary key satisfied with one enclave
// row per stream. Bot actor rows use the real bot_id instead.
export const E2E_ENCLAVE_ACTOR_ID = "enclave"

// Who an SSK key-wrap row (`stream_e2e_key_wraps.recipient_kind`) is wrapped
// to. Superset of `E2eActorKind`: the stream owner's UIK is a recipient too
// ("user"), it is just not an *invited actor*. Stored as TEXT, validated in
// code (INV-3).
export const E2E_KEY_WRAP_RECIPIENT_KINDS = ["user", "bot", "enclave"] as const
export type E2eKeyWrapRecipientKind = (typeof E2E_KEY_WRAP_RECIPIENT_KINDS)[number]

export const E2eKeyWrapRecipientKinds = {
  USER: "user",
  BOT: "bot",
  ENCLAVE: "enclave",
} as const satisfies Record<string, E2eKeyWrapRecipientKind>

/**
 * Floor for interaction-driven socket heartbeats. The frontend throttles
 * interaction-flagged heartbeats to this interval; the backend ignores
 * non-interaction heartbeats faster than this. Shared so the two sides
 * cannot drift.
 */
export const HEARTBEAT_INTERACTION_THROTTLE_MS = 15_000

// Bot kind: shared (admin-managed, workspace-wide) vs personal (owned by one user)
export const BOT_TYPES = ["shared", "personal"] as const
export type BotType = (typeof BOT_TYPES)[number]

export const BotTypes = {
  SHARED: "shared",
  PERSONAL: "personal",
} as const satisfies Record<string, BotType>

// Bot capability tags. Stored as a TEXT[] column on `bots` and validated
// against this vocabulary on read/write. New traits are added here only.
export const BOT_TRAITS = ["mentionable", "active-scratchpad"] as const
export type BotTrait = (typeof BOT_TRAITS)[number]

export const BotTraits = {
  MENTIONABLE: "mentionable",
  ACTIVE_SCRATCHPAD: "active-scratchpad",
} as const satisfies Record<string, BotTrait>

export const BOT_RUNTIME_KINDS = ["pi-local", "hermes", "openclaw", "claude-code-channel", "custom"] as const
export type BotRuntimeKind = (typeof BOT_RUNTIME_KINDS)[number]

export const BotRuntimeKinds = {
  PI_LOCAL: "pi-local",
  HERMES: "hermes",
  OPENCLAW: "openclaw",
  CLAUDE_CODE_CHANNEL: "claude-code-channel",
  CUSTOM: "custom",
} as const satisfies Record<string, BotRuntimeKind>

export const PI_TOOL_TRACE_FORMAT = "pi_tool_trace" as const

export const PI_TOOL_TRACE_SECTION_LABELS = ["Arguments", "Output", "Error output", "Details"] as const
export type PiToolTraceSectionLabel = (typeof PI_TOOL_TRACE_SECTION_LABELS)[number]

export const PiToolTraceSectionLabels = {
  ARGUMENTS: "Arguments",
  OUTPUT: "Output",
  ERROR_OUTPUT: "Error output",
  DETAILS: "Details",
} as const satisfies Record<string, PiToolTraceSectionLabel>

export const BOT_RUNTIME_SESSION_LINK_STATUSES = ["active", "paused", "ended"] as const
export type BotRuntimeSessionLinkStatus = (typeof BOT_RUNTIME_SESSION_LINK_STATUSES)[number]

export const BotRuntimeSessionLinkStatuses = {
  ACTIVE: "active",
  PAUSED: "paused",
  ENDED: "ended",
} as const satisfies Record<string, BotRuntimeSessionLinkStatus>

export const BOT_RUNTIME_STATUSES = ["available", "busy", "offline", "error"] as const
export type BotRuntimeStatus = (typeof BOT_RUNTIME_STATUSES)[number]

export const BotRuntimeStatuses = {
  AVAILABLE: "available",
  BUSY: "busy",
  OFFLINE: "offline",
  ERROR: "error",
} as const satisfies Record<string, BotRuntimeStatus>

export const BOT_INVOCATION_STATUSES = ["pending", "claimed", "completed", "failed", "cancelled", "expired"] as const
export type BotInvocationStatus = (typeof BOT_INVOCATION_STATUSES)[number]

export const BotInvocationStatuses = {
  PENDING: "pending",
  CLAIMED: "claimed",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const satisfies Record<string, BotInvocationStatus>

export const BOT_INVOCATION_TRIGGERS = ["mention", "active-scratchpad", "session-control"] as const
export type BotInvocationTrigger = (typeof BOT_INVOCATION_TRIGGERS)[number]

export const BotInvocationTriggers = {
  MENTION: "mention",
  ACTIVE_SCRATCHPAD: "active-scratchpad",
  SESSION_CONTROL: "session-control",
} as const satisfies Record<string, BotInvocationTrigger>

export const BOT_INVOCATION_CAPABILITIES = ["mentionable", "active-scratchpad", "session-control"] as const
export type BotInvocationCapability = (typeof BOT_INVOCATION_CAPABILITIES)[number]

export const BotInvocationCapabilities = {
  MENTIONABLE: "mentionable",
  ACTIVE_SCRATCHPAD: "active-scratchpad",
  SESSION_CONTROL: "session-control",
} as const satisfies Record<string, BotInvocationCapability>

export function botHasCapability(
  bot: { traits: readonly BotTrait[] },
  capability: Extract<BotInvocationCapability, BotTrait>
): boolean {
  return bot.traits.includes(capability)
}

// Social IdPs that bypass AuthKit's hosted UI. Used by the add-account flow
// where AuthKit silent-refreshes through its own session cookie regardless of
// `prompt`, making provider-direct the only reliable way to route a different
// account through the IdP's native account picker.
export const SOCIAL_PROVIDERS = ["GoogleOAuth", "MicrosoftOAuth"] as const
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number]

// Length of the WorkOS Magic Auth code. Shared between the backend Zod schema
// and the frontend OTP input so both sides accept the same shape.
export const MAGIC_CODE_LENGTH = 6

// Placeholder stored in `messages.content_markdown` / `content_json` for
// messages in an E2E scratchpad. The canonical payload lives in
// `messages.ciphertext` + `messages.envelope`; this value keeps the NOT NULL
// projection columns satisfied and gives accidental plaintext rendering a
// visible sentinel (zero-width space). Must stay byte-identical across
// backend insert, frontend encrypt, and frontend decrypt paths — the explicit
// \u200B escape keeps the source readable instead of a literal invisible byte.
export const E2E_PLACEHOLDER_CONTENT_MARKDOWN = "\u200B"
