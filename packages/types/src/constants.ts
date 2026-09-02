export const TITLE_SOURCES = ["generated", "explicit", "legacy"] as const
export type TitleSource = (typeof TITLE_SOURCES)[number]

export const TitleSources = {
  GENERATED: "generated",
  EXPLICIT: "explicit",
  LEGACY: "legacy",
} as const satisfies Record<string, TitleSource>

export const STREAM_TYPES = ["scratchpad", "channel", "dm", "thread", "system", "aside"] as const
export type StreamType = (typeof STREAM_TYPES)[number]

export const StreamTypes = {
  SCRATCHPAD: "scratchpad",
  CHANNEL: "channel",
  DM: "dm",
  THREAD: "thread",
  SYSTEM: "system",
  ASIDE: "aside",
} as const satisfies Record<string, StreamType>

/**
 * Stream kinds a shared-message `private` placeholder may report. Derived from
 * `STREAM_TYPES` minus `aside`: an aside presents as a scratchpad to
 * non-viewers, so the placeholder vocabulary never discloses one exists.
 */
export const SHARED_SOURCE_STREAM_KINDS = [
  "scratchpad",
  "channel",
  "dm",
  "thread",
  "system",
] as const satisfies readonly Exclude<StreamType, "aside">[]
export type SharedSourceStreamKind = (typeof SHARED_SOURCE_STREAM_KINDS)[number]

export const DM_PARTICIPANT_COUNT = 2

/**
 * Stream types an aside may anchor to: no aside-on-aside, no system hosts.
 * The create path, slash-command availability and the client entry points
 * all read this one list.
 */
export const ASIDE_HOST_STREAM_TYPES = [
  "channel",
  "dm",
  "scratchpad",
  "thread",
] as const satisfies readonly StreamType[]
export type AsideHostStreamType = (typeof ASIDE_HOST_STREAM_TYPES)[number]

export function isAsideHostType(type: string): type is AsideHostStreamType {
  return (ASIDE_HOST_STREAM_TYPES as readonly string[]).includes(type)
}

export const STREAM_READ_ONLY_REASONS = ["archived", "system_stream", "not_a_member"] as const
export type StreamReadOnlyReason = (typeof STREAM_READ_ONLY_REASONS)[number]

export const StreamReadOnlyReasons = {
  ARCHIVED: "archived",
  SYSTEM_STREAM: "system_stream",
  NOT_A_MEMBER: "not_a_member",
} as const satisfies Record<string, StreamReadOnlyReason>

export const StreamErrorCodes = {
  READ_ONLY: "STREAM_READ_ONLY",
} as const

// A stream's system purpose, when it exists to power a feature rather than to be
// a user-facing chat. NULL (the common case) is an ordinary stream. `persona_test`
// marks the ephemeral scratchpad bound to a persona-editor draft: it is a real,
// fully-functional stream (so it mounts and runs turns), but it is a workbench,
// not a channel, so the sidebar and workspace stream lists exclude it. No DB enum
// (INV-3) — TEXT validated in app code.
export const STREAM_PURPOSES = ["persona_test"] as const
export type StreamPurpose = (typeof STREAM_PURPOSES)[number]

export const StreamPurposes = {
  PERSONA_TEST: "persona_test",
} as const satisfies Record<string, StreamPurpose>

/**
 * Upper bound on the markdown projection of a stream description. Generous enough
 * for a rich multi-paragraph note (descriptions collapse in the UI past a few
 * lines) while still bounding the markdown that feeds search + the public-API wire.
 */
export const STREAM_DESCRIPTION_MAX_MARKDOWN_LENGTH = 10_000

/**
 * Hard cap on a stream brief's markdown (roadmap 4.1). The brief is a prompt
 * insert carried verbatim into every companion turn, not a document store, so
 * the cap keeps it from eating the context budget. Shared source of truth for
 * the backend service/Zod schema and the settings-editor char counter (INV-33).
 */
export const STREAM_BRIEF_MAX_CHARS = 4000

export const VISIBILITY_OPTIONS = ["public", "private"] as const
export type Visibility = (typeof VISIBILITY_OPTIONS)[number]

export const Visibilities = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const satisfies Record<string, Visibility>

// Labelable resource types — the polymorphic target of a label assignment.
// Labeling is resource-agnostic: the table, service, events, sync, and UI
// primitives are identical for every type. This set only gates which targets
// the API accepts; each type still needs a backend access rule
// (assertResourceAccess) and a presentation adapter — adding "user" |
// "attachment" later is a one-line change here plus those two seams.
export const LABELABLE_RESOURCE_TYPES = ["stream", "message"] as const
export type LabelableResourceType = (typeof LABELABLE_RESOURCE_TYPES)[number]

export const LabelableResourceTypes = {
  STREAM: "stream",
  MESSAGE: "message",
} as const satisfies Record<string, LabelableResourceType>

// The actor that owns/applies a label — a workspace user or a bot. A shared bot
// has no owning user, so label ownership can't be reduced to a UserId.
// `actorType` is the discriminator and the companion id column (`creator_user_id`
// / `user_id`) carries the actor's id — a UserId when "user", a bot id when
// "bot". User and bot ids are globally unique prefixed ULIDs, so the id alone
// never collides across types.
export const LABEL_ACTOR_TYPES = ["user", "bot"] as const
export type LabelActorType = (typeof LABEL_ACTOR_TYPES)[number]

export const LabelActorTypes = {
  USER: "user",
  BOT: "bot",
} as const satisfies Record<string, LabelActorType>

export const COMPANION_MODES = ["off", "on"] as const
export type CompanionMode = (typeof COMPANION_MODES)[number]

export const CompanionModes = {
  OFF: "off",
  ON: "on",
} as const satisfies Record<string, CompanionMode>

// Per-stream gate for GAM memory automation (memo extraction + passive to-do
// capture). `auto` runs the pipeline as usual; `off` excludes the stream so a
// high-volume scratchpad (e.g. a coding-agent build session) can opt out of
// indexing. Threads inherit from their root stream; the memo accumulator reads
// the flag on the resolved top-level stream.
export const MEMORY_MODES = ["auto", "off"] as const
export type MemoryMode = (typeof MEMORY_MODES)[number]

export const MemoryModes = {
  AUTO: "auto",
  OFF: "off",
} as const satisfies Record<string, MemoryMode>

export const CONTENT_FORMATS = ["plaintext", "markdown"] as const
export type ContentFormat = (typeof CONTENT_FORMATS)[number]

export const AUTHOR_TYPES = ["user", "persona", "system", "bot"] as const
export type AuthorType = (typeof AUTHOR_TYPES)[number]

export const AuthorTypes = {
  USER: "user",
  PERSONA: "persona",
  SYSTEM: "system",
  BOT: "bot",
} as const satisfies Record<string, AuthorType>

export const EVENT_TYPES = [
  "message_created",
  "message_edited",
  "message_deleted",
  "reaction_added",
  "reaction_removed",
  "member_joined",
  "member_added",
  "member_left",
  "description_set",
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
  "agent_session:interrupted",
  "agent_session:deleted",
  "messages:moved",
  "memos:captured",
  "agent:follow_up_scheduled",
  "agent:follow_up_cancelled",
  "brief_updated",
  "delegation:created",
  "delegation:status_changed",
  "subagent:created",
  "subagent:status_changed",
  "bot_access:requested",
  "bot_access:status_changed",
  "call_started",
  "call_ended",
  "aside:anchored",
] as const
export type EventType = (typeof EVENT_TYPES)[number]

// Command event types (subset of EVENT_TYPES for command lifecycle)
export const COMMAND_EVENT_TYPES = ["command_dispatched", "command_completed", "command_failed"] as const
export type CommandEventType = (typeof COMMAND_EVENT_TYPES)[number]

/**
 * Author-scoped event types (subset of EVENT_TYPES): persisted rows only their
 * actor may ever read. The repo's viewer filter hides other actors' rows from
 * fetch and catch-up, and every client surface re-applies the actor rule
 * (`isOwnCommandEvent`). Command lifecycle plus the aside anchor row — a
 * private aside's one visible trace in its host stream.
 */
export const AUTHOR_SCOPED_EVENT_TYPES = [...COMMAND_EVENT_TYPES, "aside:anchored"] as const
export type AuthorScopedEventType = (typeof AUTHOR_SCOPED_EVENT_TYPES)[number]

/**
 * Timeline broadcast event types (subset of EVENT_TYPES): events that every
 * stream member receives as individually delivered timeline rows — via a
 * stream-room socket append AND bootstrap/list responses. These, and only
 * these, consume the per-stream dense `broadcastSequence` counter that lets
 * clients verify their visible timeline window is contiguous (INV-61).
 *
 * Excluded on purpose:
 * - Command events are author-scoped — other viewers never receive them, so
 *   giving them broadcast slots would create permanent holes for everyone else.
 * - Edits / deletes / reactions are delivered live as payload *patches* onto
 *   the original message row, not as appended rows, so a broadcast slot for
 *   them would never be filled by live delivery.
 * - Legacy/no-longer-emitted types (thread_created, companion_response) ride
 *   along in bootstrap windows without slots. (stream_archived/unarchived are
 *   first-class broadcast events — they render as timeline rows and are
 *   delivered live with a broadcast slot, like member_joined.)
 */
export const TIMELINE_BROADCAST_EVENT_TYPES = [
  "message_created",
  "stream_archived",
  "stream_unarchived",
  "member_joined",
  "member_added",
  "member_left",
  "description_set",
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
  // Non-terminal "Interrupted, retrying…" between queue retries. Like its sibling
  // lifecycle events it is appended and delivered to every member (grouped into the
  // session card, not a standalone row), so it takes a dense slot — a later
  // completed/failed for the same session supersedes it (deriveStatus precedence).
  "agent_session:interrupted",
  "agent_session:deleted",
  "messages:moved",
  "memos:captured",
  "agent:follow_up_scheduled",
  // The stream's durable brief changed (roadmap 4.2): every member sees the row,
  // so it takes a broadcast slot like `description_set`. Emitted for user edits
  // and persona `update_stream_brief` writes alike — brief changes are never
  // silent (INV-69 spirit).
  "brief_updated",
  // A delegated task was handed off (roadmap 5.1): every member sees the
  // delegation card, so it takes a broadcast slot like `agent:follow_up_scheduled`.
  "delegation:created",
  // A subagent was delegated from this stream: every member sees the subagent
  // card, so it takes a broadcast slot like `delegation:created`.
  // `subagent:status_changed` is deliberately NOT here — it is a patch on that
  // card, like the delegation status change below.
  "subagent:created",
  // A bot filed an access request (F3): every member sees the request card, so
  // it takes a broadcast slot like `delegation:created`. `bot_access:status_changed`
  // is deliberately NOT here — it is a patch on the request card, like the
  // delegation status change below.
  "bot_access:requested",
  // A call started on this stream (roadmap 1.4): every member sees the live call
  // card, so it takes a broadcast slot like `delegation:created`. `call_ended` is
  // deliberately NOT here — it is a patch on the call card (carrying the end
  // summary), like the delegation status change below.
  "call_started",
  // `agent:follow_up_cancelled` and `delegation:status_changed` are deliberately
  // NOT here: each is a patch on its originating card (cancel flips the
  // scheduled card; a delegation status change flips the created card), not a
  // scheduled card (it flips that row to "Cancelled" via correlation), not a
  // visible row of its own — so, like edits/reactions, it takes no broadcast
  // slot (INV-61). Each is still an EVENT_TYPE, delivered + persisted, so every
  // viewer's card reflects the change live and after reload.
] as const
export type TimelineBroadcastEventType = (typeof TIMELINE_BROADCAST_EVENT_TYPES)[number]

export function isTimelineBroadcastEventType(eventType: string): eventType is TimelineBroadcastEventType {
  return (TIMELINE_BROADCAST_EVENT_TYPES as readonly string[]).includes(eventType)
}

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
  // Asides are a silent pull surface: the anchor row is the whole signal.
  aside: { defaultLevel: "muted", allowedLevels: ["muted"] },
}

export const ACTIVITY_TYPES = [
  "mention",
  "message",
  "reaction",
  "saved_reminder",
  "member_added",
  "missed_call",
] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export const ActivityTypes = {
  MENTION: "mention",
  MESSAGE: "message",
  REACTION: "reaction",
  SAVED_REMINDER: "saved_reminder",
  MEMBER_ADDED: "member_added",
  MISSED_CALL: "missed_call",
} as const satisfies Record<string, ActivityType>

export const SAVED_STATUSES = ["saved", "done", "archived"] as const
export type SavedStatus = (typeof SAVED_STATUSES)[number]

export const SavedStatuses = {
  SAVED: "saved",
  DONE: "done",
  ARCHIVED: "archived",
} as const satisfies Record<string, SavedStatus>

// Saved suggestion statuses — passively collected to-do candidates. A
// suggestion is never a saved item; accepting one creates the saved item and
// records the link. Dismissed rows are kept as negative examples for the
// extractor prompt.
export const SAVED_SUGGESTION_STATUSES = ["suggested", "accepted", "dismissed"] as const
export type SavedSuggestionStatus = (typeof SAVED_SUGGESTION_STATUSES)[number]

export const SavedSuggestionStatuses = {
  SUGGESTED: "suggested",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
} as const satisfies Record<string, SavedSuggestionStatus>

export const SCHEDULED_MESSAGE_STATUSES = ["pending", "sending", "sent", "cancelled", "failed"] as const
export type ScheduledMessageStatus = (typeof SCHEDULED_MESSAGE_STATUSES)[number]

export const ScheduledMessageStatuses = {
  PENDING: "pending",
  SENDING: "sending",
  SENT: "sent",
  CANCELLED: "cancelled",
  FAILED: "failed",
} as const satisfies Record<string, ScheduledMessageStatus>

export const INVITATION_STATUSES = ["pending", "accepted", "expired", "revoked"] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

export const InvitationStatuses = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const satisfies Record<string, InvitationStatus>

export const PERSONA_MANAGED_BY = ["system", "workspace", "user"] as const
export type PersonaManagedBy = (typeof PERSONA_MANAGED_BY)[number]

export const PERSONA_STATUSES = ["pending", "active", "disabled", "archived"] as const
export type PersonaStatus = (typeof PERSONA_STATUSES)[number]

// Persona style slots (roadmap 7.1). Two orthogonal aspects of response style
// an admin sets on a persona: TONE (how it sounds) and BREVITY (how long it
// goes). Built-in personas pick a preset; each preset maps to an authored
// prompt fragment (backend-only, in features/agents/companion/config.ts) that
// replaces that aspect's default guidance in the `## Response Style` section.
// Custom personas carry free-text slot content instead of a preset key. No DB
// enum (INV-3) — TEXT validated in app code.
export const TONE_PRESETS = ["warm", "neutral", "direct"] as const
export type TonePreset = (typeof TONE_PRESETS)[number]

export const TonePresets = {
  WARM: "warm",
  NEUTRAL: "neutral",
  DIRECT: "direct",
} as const satisfies Record<string, TonePreset>

export const BREVITY_PRESETS = ["brief", "balanced", "thorough"] as const
export type BrevityPreset = (typeof BREVITY_PRESETS)[number]

export const BrevityPresets = {
  BRIEF: "brief",
  BALANCED: "balanced",
  THOROUGH: "thorough",
} as const satisfies Record<string, BrevityPreset>

export const STORAGE_PROVIDERS = ["s3"] as const
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number]

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
export const ATTACHMENT_SAFETY_STATUSES = [
  "pending_upload",
  "pending_scan",
  "clean",
  "quarantined",
  "e2e_unscanned",
] as const
export type AttachmentSafetyStatus = (typeof ATTACHMENT_SAFETY_STATUSES)[number]

export const AttachmentSafetyStatuses = {
  /**
   * Reserved row whose bytes haven't finished uploading. Distinct from
   * `pending_scan` (bytes exist, scan pending) so the stale-scan quarantine
   * sweep never eats a reservation that is legitimately hours old.
   */
  PENDING_UPLOAD: "pending_upload",
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

/**
 * Safety statuses that may bind/download as a message attachment: scanned-clean
 * or E2E ciphertext (unscannable, but the owner's own bytes). Single source of
 * truth so the `isAttachmentSafeForSharing` predicate and the race-safe
 * `attachToMessage` SQL filter can't drift (INV-33).
 */
export const SHAREABLE_SAFETY_STATUSES = [
  AttachmentSafetyStatuses.CLEAN,
  AttachmentSafetyStatuses.E2E_UNSCANNED,
] as const satisfies readonly AttachmentSafetyStatus[]

/**
 * Safety statuses a fresh send may BIND to a message: shareable, plus the
 * author's own still-settling reservations (send-while-uploading). Bindable is
 * deliberately wider than shareable — a pending attachment renders as an inert
 * status chip and stays non-downloadable until it settles clean.
 */
export const BINDABLE_ATTACHMENT_SAFETY_STATUSES = [
  AttachmentSafetyStatuses.PENDING_UPLOAD,
  AttachmentSafetyStatuses.PENDING_SCAN,
  ...SHAREABLE_SAFETY_STATUSES,
] as const satisfies readonly AttachmentSafetyStatus[]

/**
 * Reserved-upload workflow state (the `attachment_uploads` tracking table,
 * INV-57). Rows exist only while an upload is in flight or has failed —
 * successful settles delete the row, so `uploaded` is a transient scan-window
 * state and absence means "settled, trust `safetyStatus`".
 */
export const ATTACHMENT_UPLOAD_STATUSES = ["reserved", "uploading", "uploaded", "failed", "abandoned"] as const
export type AttachmentUploadStatus = (typeof ATTACHMENT_UPLOAD_STATUSES)[number]

export const AttachmentUploadStatuses = {
  RESERVED: "reserved",
  UPLOADING: "uploading",
  UPLOADED: "uploaded",
  FAILED: "failed",
  ABANDONED: "abandoned",
} as const satisfies Record<string, AttachmentUploadStatus>

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

export const CONVERSATION_STATUSES = ["active", "stalled", "resolved"] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

export const ConversationStatuses = {
  ACTIVE: "active",
  STALLED: "stalled",
  RESOLVED: "resolved",
} as const satisfies Record<string, ConversationStatus>

/**
 * Max length of a user-set conversation topic (the board card / panel rename).
 * A generous cap — the LLM's own topic prompt targets ≤5 words, but a person
 * renaming a card gets more room. Shared by the write endpoint's Zod schema and
 * the rename dialog input (INV-33, one source of truth).
 */
export const MAX_CONVERSATION_TOPIC_LENGTH = 120

/** Max length of a user-saved board-view (custom lens) name. Shared by the create
 *  endpoint's Zod schema and the save/rename dialog input (INV-33). */
export const MAX_BOARD_VIEW_NAME_LENGTH = 60

/**
 * Structural lenses over the workspace board.
 * Each is a true filter over signals Threa already computes — the board gives
 * the dials, it doesn't decide what matters. `all` is the default and always
 * available: the board's job is to SURFACE, so the home view shows everything
 * and a lens is an optional narrowing the viewer opts into, never a mode they
 * must opt out of. Ordered as they render in the lens picker. Retired values
 * (`decisions`) may still sit in saved views and persisted URLs — every read
 * boundary degrades them to `all` rather than throwing.
 */
export const BOARD_LENSES = ["all", "mine"] as const
export type BoardLens = (typeof BOARD_LENSES)[number]

/** The board's home view: everything, newest activity first, nothing hidden. */
export const DEFAULT_BOARD_LENS: BoardLens = "all"

/**
 * Upper bound on the board's stream-scope selection — keeps a hand-built URL
 * from splicing an unbounded ANY() array into the feed query. Shared by the
 * backend validator and the frontend picker so the client can't offer a
 * selection the server rejects.
 */
export const MAX_BOARD_SCOPE_STREAMS = 50

/** Upper bound on the board's label filter selections (include and exclude
 *  lists each), for the same reason as {@link MAX_BOARD_SCOPE_STREAMS}. */
export const MAX_BOARD_SCOPE_LABELS = 50

/**
 * Stream types the board's filters operate on — the ROOT-stream grains a
 * conversation can live under (a thread's effective root is one of these, so
 * `thread` is deliberately absent: filtering happens by root type, never by the
 * anchor's own type). Shared by the backend validator and the frontend picker.
 */
export const BOARD_SCOPE_STREAM_TYPES = ["channel", "dm", "scratchpad", "system"] as const
export type BoardScopeStreamType = (typeof BOARD_SCOPE_STREAM_TYPES)[number]

/** How many recent replies the board projection ships per conversation — the
 *  server-side slice backing the card's ledger + full tail. */
export const BOARD_TAIL_MAX_ROWS = 5

// How a message's conversation was decided. Absent/null on a message means the
// async boundary-extractor inferred (clustered) it — the default. A set value
// records that the sender DECLARED the conversation at send time, so the
// extractor must not re-cluster it: 'new' minted a fresh conversation seeded
// with the message; 'existing' attached it to a caller-named conversation;
// 'threadFromMessage' attached this reply to the SAME source conversation as a
// cross-stream member so one conversation spans root + thread (board reply path);
// 'newSubtopic' minted a fresh child conversation anchored to the message's
// thread stream (the board branch gesture).
export const CONVERSATION_INTENTS = ["new", "existing", "threadFromMessage", "newSubtopic"] as const
export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number]

export const ConversationIntents = {
  NEW: "new",
  EXISTING: "existing",
  THREAD_FROM_MESSAGE: "threadFromMessage",
  NEW_SUBTOPIC: "newSubtopic",
} as const satisfies Record<string, ConversationIntent>

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

/**
 * Caps for user-edited memo text (the memory explorer's edit form). A memo's
 * abstract is injected into agent retrieval and embedded, so it is a prompt
 * insert, not a document store — bounded to keep edits cheap. The char caps are
 * shared by the backend Zod validator and the editor's character counter
 * (INV-33); `TITLE` matches the memorizer's generation cap (`memoItemSchema`).
 * The array ceilings are edit-only and deliberately more generous than the
 * generation defaults (keyPoints 3 / tags 5), which are prompt guidance for the
 * model, not hard limits on what a person may curate.
 */
export const MEMO_TITLE_MAX_CHARS = 100
export const MEMO_ABSTRACT_MAX_CHARS = 2000
export const MEMO_KEY_POINTS_MAX = 20
export const MEMO_TAGS_MAX = 20

// Delegation content caps (roadmap 5.1) — shared by the backend Zod schema and
// the delegations feature config (re-exported there, INV-33). Live here rather
// than in features/delegations/config.ts because the delegate_task tool (in
// features/agents/) also needs them, and importing the delegations barrel from
// an agents tool creates a module cycle (delegations/service -> agents barrel
// -> tools barrel -> the tool) that leaves these undefined at init.
export const DELEGATION_TITLE_MAX_CHARS = 200
export const DELEGATION_BRIEF_MAX_CHARS = 20_000
export const DELEGATION_CONTEXT_REFS_MAX = 20

/**
 * Who authored a memo. `pipeline` is the passive GAM extractor (the batch
 * memorizer over settled conversations — the default for every existing row);
 * `agent` is an explicit persona write via the `save_memo` tool (roadmap 6.2).
 * The distinction feeds a structural retrieval boost (agent memos rank below
 * conversation-sourced ones to damp self-reinforcement) and provenance.
 */
export const AUTHORED_BY_KINDS = ["pipeline", "agent"] as const
export type AuthoredByKind = (typeof AUTHORED_BY_KINDS)[number]

export const AuthoredByKinds = {
  PIPELINE: "pipeline",
  AGENT: "agent",
} as const satisfies Record<string, AuthoredByKind>

/**
 * Visibility tier of a memo within its workspace (roadmap 6.4). `workspace` and
 * `stream` memos are gated by the retriever's stream access (INV-62); `user`
 * memos are additionally private to a single owner (`scope_user_id`) — the
 * per-user "what Ariadne knows about you" tier, extracted from private
 * scratchpads and set explicitly via `save_memo`. `workspace_id` is required for
 * every scope (INV-8): `user` subdivides within the workspace, it is not a global
 * private store.
 */
export const MEMO_SCOPES = ["user", "stream", "workspace"] as const
export type MemoScope = (typeof MEMO_SCOPES)[number]

export const MemoScopes = {
  USER: "user",
  STREAM: "stream",
  WORKSPACE: "workspace",
} as const satisfies Record<string, MemoScope>

// Pending memo item types
export const PENDING_ITEM_TYPES = ["message", "conversation"] as const
export type PendingItemType = (typeof PENDING_ITEM_TYPES)[number]

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
  "read_attachment",
  "describe_memo",
  "react_to_message",
  "schedule_follow_up",
  "list_follow_ups",
  "cancel_follow_up",
  "update_follow_up",
  "update_stream_brief",
  "delegate_task",
  "start_subagent",
  "report_back",
  "save_memo",
  "update_user_settings",
  "github_repos",
  "github_commits",
  "github_pulls",
  "github_content",
  "github_workflows",
  "github_releases",
  "github_issues",
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
  READ_ATTACHMENT: "read_attachment",
  DESCRIBE_MEMO: "describe_memo",
  REACT_TO_MESSAGE: "react_to_message",
  SCHEDULE_FOLLOW_UP: "schedule_follow_up",
  LIST_FOLLOW_UPS: "list_follow_ups",
  CANCEL_FOLLOW_UP: "cancel_follow_up",
  UPDATE_FOLLOW_UP: "update_follow_up",
  UPDATE_STREAM_BRIEF: "update_stream_brief",
  DELEGATE_TASK: "delegate_task",
  START_SUBAGENT: "start_subagent",
  REPORT_BACK: "report_back",
  SAVE_MEMO: "save_memo",
  UPDATE_USER_SETTINGS: "update_user_settings",
  GITHUB_REPOS: "github_repos",
  GITHUB_COMMITS: "github_commits",
  GITHUB_PULLS: "github_pulls",
  GITHUB_CONTENT: "github_content",
  GITHUB_WORKFLOWS: "github_workflows",
  GITHUB_RELEASES: "github_releases",
  GITHUB_ISSUES: "github_issues",
  LINEAR_LIST_ISSUES: "linear_list_issues",
  LINEAR_GET_ISSUE: "linear_get_issue",
  LINEAR_LIST_PROJECTS: "linear_list_projects",
  LINEAR_GET_PROJECT: "linear_get_project",
} as const satisfies Record<string, AgentToolName>

export const SOURCE_TYPES = ["web", "workspace", "github"] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const SourceTypes = {
  WEB: "web",
  WORKSPACE: "workspace",
  GITHUB: "github",
} as const satisfies Record<string, SourceType>

export const AGENT_TRIGGERS = ["mention", "companion"] as const
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number]

export const AgentTriggers = {
  MENTION: "mention",
  COMPANION: "companion",
} as const satisfies Record<string, AgentTrigger>

// Agent follow-up lifecycle (scheduled "check back later" work an agent creates
// for itself). `pending` → `fired` when the firing worker CASes it and enqueues
// the persona turn; `cancelled` when a member cancels before it fires; `failed`
// when the fire path errors terminally.
export const FOLLOW_UP_STATUSES = ["pending", "fired", "cancelled", "failed"] as const
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

/** Terminal follow-up statuses — no further transitions. */
export const FOLLOW_UP_TERMINAL_STATUSES = ["fired", "cancelled", "failed"] as const satisfies readonly FollowUpStatus[]

export const FollowUpStatuses = {
  PENDING: "pending",
  FIRED: "fired",
  CANCELLED: "cancelled",
  FAILED: "failed",
} as const satisfies Record<string, FollowUpStatus>

// Delegated-task lifecycle (roadmap 5.1): a hand-off compiled by an agent (or a
// person, later) for the user's local agent to execute. `open` until a local
// agent claims it via the public API (5.3); `claimed`/`running` while held under
// a TTL'd claim token; `completed`/`failed` are terminal reports; `cancelled` by
// a stream member from the card; historical `expired` claims remain recoverable.
export const DELEGATION_STATUSES = [
  "open",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number]

export const DelegationStatuses = {
  OPEN: "open",
  CLAIMED: "claimed",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const satisfies Record<string, DelegationStatus>

export const DELEGATION_REOPEN_REASONS = ["claim_expired", "claim_released", "requeued"] as const
export type DelegationReopenReason = (typeof DELEGATION_REOPEN_REASONS)[number]

/** Settled delegation statuses with no further transitions. */
export const DELEGATION_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly DelegationStatus[]

/**
 * Subagent run lifecycle. A subagent is a second model bound to a thread off
 * the parent stream: `active` while it is the stream's one live delegation,
 * terminal in every other state. Validated in code, never a DB enum (INV-3);
 * `active` is also the partial-unique-index predicate that enforces one live
 * subagent per parent stream (INV-20).
 */
export const SUBAGENT_STATUSES = ["active", "completed", "cancelled", "failed", "expired"] as const
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number]

export const SubagentStatuses = {
  ACTIVE: "active",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  EXPIRED: "expired",
} as const satisfies Record<string, SubagentStatus>

/** Settled subagent statuses with no further transitions (requeue re-inserts, it does not transition). */
export const SUBAGENT_TERMINAL_STATUSES = [
  "completed",
  "cancelled",
  "failed",
  "expired",
] as const satisfies readonly SubagentStatus[]

/**
 * Why a subagent run ended without the delegated model reporting back. A code,
 * not prose: the backend never authors display text (INV-46), and these are
 * system transitions with no human actor to have written one. Validated in
 * code, stored in `subagent_runs.status_note` (INV-3).
 */
export const SUBAGENT_FAILURE_REASONS = ["turn_failed", "session_orphaned", "kickoff_failed"] as const
export type SubagentFailureReason = (typeof SUBAGENT_FAILURE_REASONS)[number]

export const SubagentFailureReasons = {
  TURN_FAILED: "turn_failed",
  SESSION_ORPHANED: "session_orphaned",
  KICKOFF_FAILED: "kickoff_failed",
} as const satisfies Record<string, SubagentFailureReason>

// Subagent content caps — same numbers as the delegation caps and here for the
// same reason: the `start_subagent` tool (features/agents/) and the
// subagents feature both need them, and importing the subagents barrel from an
// agents tool creates a module cycle.
export const SUBAGENT_TITLE_MAX_CHARS = 200
export const SUBAGENT_BRIEF_MAX_CHARS = 20_000

// Bot access-request lifecycle (F3): a bot runtime that lacks stream access
// files a request; a stream member approves (granting access + re-nudging the
// runner) or denies. `open` until a member resolves it; `approved`/`denied` are
// terminal. Approve/deny CAS on `open` in application code (INV-3/20).
export const BOT_ACCESS_REQUEST_STATUSES = ["open", "approved", "denied"] as const
export type BotAccessRequestStatus = (typeof BOT_ACCESS_REQUEST_STATUSES)[number]

export const BotAccessRequestStatuses = {
  OPEN: "open",
  APPROVED: "approved",
  DENIED: "denied",
} as const satisfies Record<string, BotAccessRequestStatus>

// Agent session event types (stream events for session lifecycle)
export const AGENT_SESSION_EVENT_TYPES = [
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
  "agent_session:interrupted",
  "agent_session:deleted",
] as const
export type AgentSessionEventType = (typeof AGENT_SESSION_EVENT_TYPES)[number]

/**
 * Where a guarded (tier 2+) tool call stands with the guardian. Carried on the
 * step the call opened rather than as a step of its own, so the trace shows one
 * row per action with its approval state attached.
 *
 * `pending` is written when the call's step opens and is what renders as a
 * spinner; it is not a resting state — a step left pending means the turn died
 * mid-review, which is why it is distinguishable from a step with no
 * verification at all (tier 1, and every step written before tiers existed).
 */
export const TOOL_VERIFICATION_STATUSES = ["pending", "approved", "denied"] as const
export type ToolVerificationStatus = (typeof TOOL_VERIFICATION_STATUSES)[number]

export const ToolVerificationStatuses = {
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
} as const satisfies Record<string, ToolVerificationStatus>

// Agent step types (semantic - frontend maps to display labels)
export const AGENT_STEP_TYPES = [
  "context_received",
  "thinking",
  "reconsidering",
  "steer",
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
  "turn_digest",
  "model_escalated",
] as const
export type AgentStepType = (typeof AGENT_STEP_TYPES)[number]

export const AgentStepTypes = {
  CONTEXT_RECEIVED: "context_received",
  THINKING: "thinking",
  RECONSIDERING: "reconsidering",
  STEER: "steer",
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
  TURN_DIGEST: "turn_digest",
  MODEL_ESCALATED: "model_escalated",
} as const satisfies Record<string, AgentStepType>

export const AGENT_RECONSIDERATION_DECISIONS = ["kept_previous_response"] as const
export type AgentReconsiderationDecision = (typeof AGENT_RECONSIDERATION_DECISIONS)[number]

export const AgentReconsiderationDecisions = {
  KEPT_PREVIOUS_RESPONSE: "kept_previous_response",
} as const satisfies Record<string, AgentReconsiderationDecision>

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

export const WORKSPACE_INTEGRATION_PROVIDERS = ["github", "linear"] as const
export type WorkspaceIntegrationProvider = (typeof WORKSPACE_INTEGRATION_PROVIDERS)[number]

export const WorkspaceIntegrationProviders = {
  GITHUB: "github",
  LINEAR: "linear",
} as const satisfies Record<string, WorkspaceIntegrationProvider>

export const WORKSPACE_INTEGRATION_STATUSES = ["active", "inactive", "error"] as const
export type WorkspaceIntegrationStatus = (typeof WORKSPACE_INTEGRATION_STATUSES)[number]

export const WorkspaceIntegrationStatuses = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  ERROR: "error",
} as const satisfies Record<string, WorkspaceIntegrationStatus>

export const LINK_PREVIEW_CONTENT_TYPES = [
  "website",
  "pdf",
  "image",
  "video",
  "message_link",
  "stream_link",
  "memo_link",
  "conversation_link",
  "delegation_link",
] as const
export type LinkPreviewContentType = (typeof LINK_PREVIEW_CONTENT_TYPES)[number]

export const LinkPreviewContentTypes = {
  WEBSITE: "website",
  PDF: "pdf",
  IMAGE: "image",
  VIDEO: "video",
  MESSAGE_LINK: "message_link",
  STREAM_LINK: "stream_link",
  MEMO_LINK: "memo_link",
  CONVERSATION_LINK: "conversation_link",
  DELEGATION_LINK: "delegation_link",
} as const satisfies Record<string, LinkPreviewContentType>

/**
 * Content types that point at another in-app resource rather than the public web.
 * These are resolved per-viewer through the permission-checked resolve endpoint
 * and never fetched over the network, so the worker skips them and the frontend
 * routes them to the in-app preview card instead of the generic web card.
 */
export const IN_APP_LINK_CONTENT_TYPES = [
  "message_link",
  "stream_link",
  "memo_link",
  "conversation_link",
  "delegation_link",
] as const
export type InAppLinkContentType = (typeof IN_APP_LINK_CONTENT_TYPES)[number]

export function isInAppLinkContentType(contentType: LinkPreviewContentType): contentType is InAppLinkContentType {
  return (IN_APP_LINK_CONTENT_TYPES as readonly string[]).includes(contentType)
}

/**
 * In-app link kinds that render as an inline chip inside the message body
 * (replacing the URL text). Message, conversation, and delegation links pair the
 * inline chip with a below-message card (the chip is a compact reference, the
 * card the rich preview); a stream link's card is suppressed (the chip says it
 * all). Only memo links have no inline chip — they are card-only — so they are
 * excluded here.
 */
export type InlineChipContentType = Exclude<InAppLinkContentType, "memo_link">
export const INLINE_CHIP_CONTENT_TYPES = IN_APP_LINK_CONTENT_TYPES.filter(
  (t): t is InlineChipContentType => t !== "memo_link"
)

export function isInlineChipContentType(contentType: LinkPreviewContentType): contentType is InlineChipContentType {
  return (INLINE_CHIP_CONTENT_TYPES as readonly string[]).includes(contentType)
}

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

// Video-embed providers whose links unfurl into a click-to-play facade card.
// The embed URL is always reconstructed from the parsed video id against a
// trusted per-provider origin — never from oEmbed HTML (iframe-injection guard).
export const VIDEO_PREVIEW_PROVIDERS = ["youtube", "vimeo", "loom", "twitch"] as const
export type VideoPreviewProvider = (typeof VIDEO_PREVIEW_PROVIDERS)[number]

export const VideoPreviewProviders = {
  YOUTUBE: "youtube",
  VIMEO: "vimeo",
  LOOM: "loom",
  TWITCH: "twitch",
} as const satisfies Record<string, VideoPreviewProvider>

// Video is a single rich preview variant (unlike GitHub/Linear which fan out
// into many). Kept as a one-member list for parity with the other unions so
// `preview_type` stays a closed set derived from a source-of-truth constant.
export const VIDEO_PREVIEW_TYPES = ["video"] as const
export type VideoPreviewType = (typeof VIDEO_PREVIEW_TYPES)[number]

export const VideoPreviewTypes = {
  VIDEO: "video",
} as const satisfies Record<string, VideoPreviewType>

/** Every value `link_previews.preview_type` can hold — the closed set of rich provider cards. */
export type RichLinkPreviewType = GitHubPreviewType | LinearPreviewType | VideoPreviewType

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

/**
 * Wire-format error codes for server-side reference resolution — the pass that
 * pins every `quoteReply` / `sharedMessage` node to a source revision and range
 * before the message is stored. All are 400s: the client sent a reference the
 * server cannot honour, and the composer keeps the draft so it can be retried.
 */
export const MessageReferenceErrorCodes = {
  SOURCE_NOT_FOUND: "REFERENCE_SOURCE_NOT_FOUND",
  VERSION_NOT_FOUND: "REFERENCE_VERSION_NOT_FOUND",
  RANGE_INVALID: "REFERENCE_RANGE_INVALID",
  RANGE_NOT_FOUND: "REFERENCE_RANGE_NOT_FOUND",
} as const

export const MessageErrorCodes = {
  STEER_UNAVAILABLE: "STEER_UNAVAILABLE",
} as const

// Inter-service authentication header (control-plane ↔ regional backend ↔ workspace-router)
export const INTERNAL_API_KEY_HEADER = "X-Internal-Api-Key"

// Per-session callback binding for enclave turns (Phase 2.4b, E2EE-21): the
// dispatch-minted token from the session assignment, echoed by the enclave on
// every session callback so the backend can verify the caller is the runner
// the session was assigned to — the internal key alone proves only "internal".
export const ENCLAVE_CALLBACK_TOKEN_HEADER = "X-Enclave-Callback-Token"

// Per-session callback binding for sealed turns delivered to an owner-granted
// external runner (a third-party / self-hosted bot harness). The claim-minted
// token (the claim token itself, model A) is echoed on every sealed
// `/steps`/`/complete` callback so the backend can verify the caller is the
// instance the session was assigned to — the workspace bot key alone proves only
// "this workspace". Deliberately not enclave-named (§2.6 rule 1): the enclave
// keeps its own `X-Enclave-Callback-Token`, and this is the same binding for the
// bot transport, shared by every sealed-capable external driver.
export const THREA_CALLBACK_TOKEN_HEADER = "X-Threa-Callback-Token"

// Public API wire-version negotiation: on requests it overrides the key's
// pinned version; on responses it echoes the resolved version. No X- prefix —
// it's a documented public header, named like Stripe-Version.
export const THREA_VERSION_HEADER = "Threa-Version"

// Original client-facing host (e.g. `admin.threa.io`)
// carried from the Cloudflare routers to the control-plane.
//
// We can't reuse the standard `X-Forwarded-Host` for this: Railway's edge proxy
// fronts the control-plane and overwrites every `X-Forwarded-*` header with its
// own ingress hostname before the app sees it, so the real client host is lost.
// A custom header outside the `X-Forwarded-*` namespace passes through Railway
// untouched. The control-plane uses it to build per-host WorkOS redirect URIs
// and to validate post-auth redirect targets.
export const ORIGINAL_HOST_HEADER = "X-Threa-Host"

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
 * Cap on each side of the composer draft context sent with `voice:start` and
 * fed to the transcript polish model as surrounding-text context. The frontend
 * keeps the text closest to the insertion point (the LAST chars before the
 * caret, the FIRST chars after it); the gateway applies the same cap
 * defensively. Shared so the two sides cannot drift (INV-33).
 */
export const VOICE_DRAFT_CONTEXT_MAX_CHARS = 2_000

/**
 * Floor for interaction-driven socket heartbeats. The frontend throttles
 * interaction-flagged heartbeats to this interval; the backend ignores
 * non-interaction heartbeats faster than this. Shared so the two sides
 * cannot drift.
 */
export const HEARTBEAT_INTERACTION_THROTTLE_MS = 15_000

/**
 * How recently a device must have seen a direct interaction (pointer/key/touch)
 * to count as "the device the user is actively on." Shared across the push
 * presence boundary: the backend uses it to decide which device is attended for
 * notification routing, and the frontend service worker uses the same window to
 * decide whether to suppress a push for the stream on screen. Shared so the two
 * sides cannot drift on what "present" means.
 */
export const PRESENCE_INTERACTION_WINDOW_MS = 2 * 60 * 1_000

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

// Exact bodies the backend substitutes for redacted trace sections
// (public-api sanitize). The frontend matches on these to collapse the
// section into a one-line "hidden for safety" notice.
export const PI_TOOL_TRACE_REDACTED_BODIES = {
  ARGUMENTS: "Tool arguments omitted for safety.",
  OUTPUT: "Tool output omitted for safety.",
} as const
export const PI_TOOL_TRACE_REDACTED_BODY_SET: ReadonlySet<string> = new Set(
  Object.values(PI_TOOL_TRACE_REDACTED_BODIES)
)

// 'archived' is the recoverable end state written when the linked scratchpad is
// archived — stream:unarchived revives exactly these links back to 'active'.
// 'ended' is terminal (normal shutdown) and is never revived.
export const BOT_RUNTIME_SESSION_LINK_STATUSES = ["active", "paused", "ended", "archived"] as const
export type BotRuntimeSessionLinkStatus = (typeof BOT_RUNTIME_SESSION_LINK_STATUSES)[number]

export const BotRuntimeSessionLinkStatuses = {
  ACTIVE: "active",
  PAUSED: "paused",
  ENDED: "ended",
  ARCHIVED: "archived",
} as const satisfies Record<string, BotRuntimeSessionLinkStatus>

export const BOT_RUNTIME_STATUSES = ["available", "busy", "offline", "error"] as const
export type BotRuntimeStatus = (typeof BOT_RUNTIME_STATUSES)[number]

export const BotRuntimeStatuses = {
  AVAILABLE: "available",
  BUSY: "busy",
  OFFLINE: "offline",
  ERROR: "error",
} as const satisfies Record<string, BotRuntimeStatus>

export const BOT_INVOCATION_STATUSES = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "parked",
] as const
export type BotInvocationStatus = (typeof BOT_INVOCATION_STATUSES)[number]

export const BotInvocationStatuses = {
  PENDING: "pending",
  CLAIMED: "claimed",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  // Terminal dead-letter state: the claim loop re-dispatched this invocation
  // `BOT_CLAIM_MAX_ATTEMPTS` times without it ever completing (a runtime that
  // keeps claiming and going silent), so it is parked instead of retried
  // forever. No longer claimable; kept for inspection.
  PARKED: "parked",
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

// User-facing label shown wherever a preview of an E2E message is rendered
// without the key material to decrypt it (sidebar stream preview, Saved list,
// saved-reminder push). The body itself stays sealed; this is the leak-free
// stand-in for the zero-width placeholder. Centralized so the backend and
// frontend surfaces can't drift (INV-33).
export const ENCRYPTED_MESSAGE_PREVIEW_LABEL = "\uD83D\uDD12 Encrypted message"
