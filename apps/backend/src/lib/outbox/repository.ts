import { OutboxRepository as BaseOutboxRepository, type Querier } from "@threa/backend-common"
import type { Stream } from "../../features/streams"
import type { StreamEvent } from "../../features/streams"
import type { User } from "../../features/workspaces"
import type { ConversationWithStaleness } from "../../features/conversations"
import type { HydratedSharedMessage } from "../../features/messaging/sharing"
import type {
  MemoEmbedSummary,
  StreamEvent as WireStreamEvent,
  UserPreferences,
  SidebarConfig,
  WorkspaceSettings,
  LastMessagePreview,
  Bot as WireBot,
  BotInvocationCapability,
  Label,
  LabelAssignment,
  LabelableResourceType,
  SavedMessageView,
  SavedSuggestionView,
  ScheduledMessageView,
  Draft as WireDraft,
  WorkspaceInvitableRole,
  AuthorType,
  Visibility,
  NotificationLevel,
  AttachmentSafetyStatus,
  AttachmentUploadStatus,
  PersonaListItem,
  StreamReadFrontierSnapshot,
} from "@threa/types"

export type OutboxEventType =
  | "message:created"
  | "message:edited"
  | "message:deleted"
  | "messages:moved"
  | "thread:updated"
  | "reaction:added"
  | "reaction:removed"
  | "stream:created"
  | "stream:updated"
  | "stream:archived"
  | "stream:unarchived"
  | "stream:display_name_updated"
  | "stream:read"
  | "stream:read_set"
  | "stream:read_all"
  | "stream:read_messages"
  | "stream:notification_level_updated"
  | "stream:activity"
  | "attachment:uploaded"
  | "attachment:extraction_completed"
  | "workspace_user:added"
  | "workspace_user:removed"
  | "workspace_user:updated"
  | "conversation:created"
  | "conversation:updated"
  | "conversation:message_assigned"
  | "conversation:message_reassigned"
  | "dynamic_naming:requested"
  | "board:conversation_hide_changed"
  | "board:stream_mute_changed"
  | "memo:created"
  | "memo:updated"
  | "command:dispatched"
  | "command:completed"
  | "command:failed"
  | "agent_session:started"
  | "agent_session:completed"
  | "agent_session:failed"
  | "agent_session:interrupted"
  | "agent_session:deleted"
  | "user_preferences:updated"
  | "sidebar_config:updated"
  | "workspace_settings:updated"
  | "feature_flags:updated"
  | "feature_flags:workspace_updated"
  | "agent_config:updated"
  | "budget:alert"
  | "stream:member_joined"
  | "stream:member_added"
  | "stream:member_removed"
  | "stream:memos_captured"
  | "stream:description_set"
  | "stream:agent_follow_up_scheduled"
  | "stream:agent_follow_up_cancelled"
  | "stream:brief_updated"
  | "stream:delegation_created"
  | "stream:delegation_status_changed"
  | "stream:bot_access_requested"
  | "stream:bot_access_status_changed"
  | "invitation:sent"
  | "invitation:link-created"
  | "invitation:link-claimed"
  | "invitation:accepted"
  | "invitation:revoked"
  | "activity:created"
  | "activity:read"
  | "saved:upserted"
  | "saved:deleted"
  | "saved_reminder:fired"
  | "saved_suggestion:upserted"
  | "scheduled_message:upserted"
  | "scheduled_message:sent"
  | "scheduled_message:cancelled"
  | "draft:upserted"
  | "draft:deleted"
  | "bot:created"
  | "bot:updated"
  | "link_preview:ready"
  | "link_preview:dismissed"
  | "attachment:transcoded"
  | "attachment:thumbnailed"
  | "attachment:upload_status_changed"
  | "bot_invocation:available"
  | "bot_invocation:claimed"
  | "bot:active_actor_changed"
  | "bot:resync"
  | "bot:session_archived"
  | "bot:session_restored"
  | "label:created"
  | "label:updated"
  | "label:deleted"
  | "label:assigned"
  | "label:unassigned"
  | "enclave:rewrap_needed"
  | "enclave:rewrap_nudge"
  | "github_route:register"
  | "github_route:unregister"
  | "call:invitation_created"
  | "call:invitation_settled"
  | "stream:call_started"
  | "stream:call_ended"
  | "call:participants_changed"

/** Events that are scoped to a stream (have streamId) */
export type StreamScopedEventType =
  | "memo:created"
  | "memo:updated"
  | "message:created"
  | "message:edited"
  | "message:deleted"
  | "messages:moved"
  | "thread:updated"
  | "reaction:added"
  | "reaction:removed"
  | "stream:display_name_updated"
  | "stream:member_joined"
  | "stream:member_added"
  | "stream:member_removed"
  | "stream:memos_captured"
  | "stream:description_set"
  | "stream:agent_follow_up_scheduled"
  | "stream:agent_follow_up_cancelled"
  | "stream:brief_updated"
  | "stream:delegation_created"
  | "stream:delegation_status_changed"
  | "stream:bot_access_requested"
  | "stream:bot_access_status_changed"
  | "stream:call_started"
  | "stream:call_ended"
  | "call:participants_changed"
  | "stream:activity"
  | "conversation:created"
  | "conversation:updated"
  | "conversation:message_assigned"
  | "conversation:message_reassigned"
  | "agent_session:started"
  | "agent_session:completed"
  | "agent_session:failed"
  | "agent_session:interrupted"
  | "agent_session:deleted"
  | "link_preview:ready"
  | "command:dispatched"
  | "command:completed"
  | "command:failed"

/** Events that are scoped to a workspace (no streamId) */
export type WorkspaceScopedEventType =
  | "stream:created"
  | "stream:updated"
  | "stream:archived"
  | "stream:unarchived"
  | "attachment:uploaded"
  | "attachment:extraction_completed"
  | "workspace_user:added"
  | "workspace_user:removed"
  | "workspace_user:updated"
  | "bot:created"
  | "bot:updated"
  | "attachment:transcoded"
  | "attachment:thumbnailed"
  | "attachment:upload_status_changed"
  | "agent_config:updated"

interface StreamScopedPayload {
  workspaceId: string
  streamId: string
}

interface WorkspaceScopedPayload {
  workspaceId: string
}

export interface MessageCreatedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
  /** Canonical namespaced slot map (`shared:<messageId>` keys). */
  slots?: Record<string, HydratedSharedMessage>
  /** TEMPORARY legacy bare-key map for pre-slots clients (D8 removal). */
  sharedMessages?: Record<string, HydratedSharedMessage>
}

export interface MessageEditedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
  /** Canonical namespaced slot map (`shared:<messageId>` keys). */
  slots?: Record<string, HydratedSharedMessage>
  /** TEMPORARY legacy bare-key map for pre-slots clients (D8 removal). */
  sharedMessages?: Record<string, HydratedSharedMessage>
}

export interface MessageDeletedOutboxPayload extends StreamScopedPayload {
  messageId: string
  deletedAt: string
}

export interface MessagesMovedOutboxPayload extends StreamScopedPayload {
  sourceStreamId: string
  destinationStreamId: string
  targetMessageId: string
  movedMessageIds: string[]
  thread: Stream
  events: WireStreamEvent[]
  removedEventIds: string[]
  /**
   * The `messages:moved` tombstone inserted into the SOURCE stream. Source
   * clients append this to their IDB cache after applying `removedEventIds`
   * so the timeline keeps a "moved 3 messages → thread" trace where the
   * messages used to be. Not part of `events` because that array is the
   * destination-side write set.
   */
  sourceTombstoneEvent: WireStreamEvent
  /**
   * Authoritative `replyCount` for the drop-target message (the thread parent),
   * read off the destination thread row AFTER the move. Frontend sets this
   * directly on the parent message in the source stream. Including it in
   * `messages:moved` makes this event self-sufficient: ThreadCard surfaces with
   * the right count even if the sibling `thread:updated` outbox event is delayed,
   * dropped, or processed out of order.
   */
  parentReplyCount: number
  /**
   * Recomputed thread summary for the drop-target — same field shape
   * `thread:updated` ships, included here so the card preview/participants
   * land alongside the move without waiting for a second event.
   */
  parentThreadSummary: import("@threa/types").ThreadSummary | null
  /**
   * The SOURCE stream's `message_created` count AFTER the move relocated rows
   * out of it. The move drops the source's true message ordinal, but no client
   * applier ever corrects `latestOrdinals` downward (max-merge only), so stale
   * inflated unread sticks for the session. The client SETs
   * `latestOrdinals[source]` to this value and recomputes unread — the one
   * sanctioned non-monotonic latest write (fix A1, sparse-read design).
   */
  sourceMessageOrdinal: number
  /**
   * Dual slot map for the moved messages' share references, hydrated
   * room-uniform for the DESTINATION stream (B3). The client merges it under
   * the destination stream so pointer cards in the moved messages render
   * immediately in the thread panel. Omitted when no moved message carries a
   * share reference.
   */
  slots?: Record<string, HydratedSharedMessage>
  /** TEMPORARY legacy bare-key map for pre-slots clients (D8 removal). */
  sharedMessages?: Record<string, HydratedSharedMessage>
}

/**
 * A thread's reply stats changed. Stream-scoped ONLY (no timeline row, no
 * EVENT_TYPES entry — same delivery class as `call:participants_changed`):
 * `streamId` is the PARENT stream, so the generic stream-scoped router fans it
 * to the parent room. The sole reply-stat projection for every anchor kind.
 * `anchorId` is the canonical id of the anchored timeline item (`msg_…` /
 * `event_…`); `replyCount` is the post-mutation value read off the thread stream
 * row; `threadSummary` is `null` when the thread has no live reply.
 * Both stat fields are optional: the edit path re-emits only a refreshed
 * `threadSummary` (no count change) and omits `replyCount` so it can never
 * republish a count read without a lock (a concurrent create/delete owns the
 * authoritative count). Consumers heal only the fields present.
 */
export interface ThreadUpdatedOutboxPayload extends StreamScopedPayload {
  parentStreamId: string
  anchorId: string
  threadId: string
  replyCount?: number
  threadSummary?: import("@threa/types").ThreadSummary | null
}

export interface ReactionOutboxPayload extends StreamScopedPayload {
  messageId: string
  emoji: string
  userId: string
  /**
   * Actor type of the reactor. "user" for human reactions; "persona" when an
   * agent reacted via `react_to_message`. Downstream handlers (activity feed,
   * emoji-usage) use this to attribute or skip the reaction correctly. Optional
   * on the wire so pre-existing/un-upgraded producers still validate; consumers
   * treat a missing value as "user".
   */
  actorType?: AuthorType
}

export interface StreamDisplayNameUpdatedPayload extends StreamScopedPayload {
  displayName: string
  visibility: string
  source: import("@threa/types").TitleSource
  revision: number
}

export interface StreamMemberJoinedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface StreamMemberAddedOutboxPayload extends StreamScopedPayload {
  memberId: string
  stream: Stream
  event: StreamEvent
  /**
   * Present when the added member is a bot: the receiving client may not have
   * the bot in its roster (personal bots are visibility-scoped), so the event
   * carries the metadata needed to render it.
   */
  bot?: WireBot
}

export interface StreamMemberRemovedOutboxPayload extends StreamScopedPayload {
  memberId: string
  event: StreamEvent
}

/**
 * Carries a `memos:captured` timeline event (INV-69) to the source stream's
 * room. Same envelope shape as the membership events: the full stream event
 * rides along so clients append it without a fetch.
 */
export interface StreamMemosCapturedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

/**
 * Carries a `description_set` timeline event to the stream's room. Same envelope
 * shape as the membership/memos events: the full stream event rides along so
 * clients append it without a fetch.
 */
export interface StreamDescriptionSetOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

/**
 * Carries an `agent:follow_up_scheduled` / `agent:follow_up_cancelled` timeline
 * event (roadmap 1.3) to the stream's room. Same envelope shape as the
 * memos/description events: the full stream event rides along so clients append
 * it without a fetch.
 */
export interface StreamAgentFollowUpScheduledOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface StreamAgentFollowUpCancelledOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

/**
 * Carries a `brief_updated` timeline event (roadmap 4.2) to the stream's room.
 * Same envelope shape as the memos/description events: the full stream event
 * rides along so clients append it without a fetch. Routed on the effective root
 * stream — the brief keys on the root (threads inherit), so the row lands where
 * the brief lives.
 */
export interface StreamBriefUpdatedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

/**
 * Carries a `delegation:created` / `delegation:status_changed` timeline event
 * (roadmap 5.1) to the stream's room. Same envelope shape as the follow-up
 * events: the full stream event rides along so clients append it without a
 * fetch (created renders the card; status_changed patches it).
 */
export interface StreamDelegationCreatedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface StreamDelegationStatusChangedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

/**
 * Carries a `bot_access:requested` / `bot_access:status_changed` timeline event
 * (F3) to the stream's room. Same envelope shape as the delegation events: the
 * full stream event rides along so clients append it without a fetch (requested
 * renders the card; status_changed patches it). The status event additionally
 * feeds the broadcast-handler re-nudge branch — an approved request carrying a
 * delegation re-emits `delegation:available` from the event payload alone.
 */
export interface StreamBotAccessRequestedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface StreamBotAccessStatusChangedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

// StreamCreatedOutboxPayload includes streamId for routing:
// - For threads: streamId = parentStreamId (broadcast to parent stream room)
// - For non-threads: streamId = stream.id (broadcast to workspace room)
export interface StreamCreatedOutboxPayload extends WorkspaceScopedPayload {
  streamId: string
  stream: Stream
  dmUserIds?: [string, string]
}

export interface StreamUpdatedOutboxPayload extends WorkspaceScopedPayload {
  streamId: string
  stream: Stream
}

export interface StreamArchivedOutboxPayload extends WorkspaceScopedPayload {
  streamId: string
  stream: Stream
  /** The timeline event row, so clients append it live (first-class broadcast). */
  event: StreamEvent
  /**
   * Active descendant thread ids (any depth) so the event can be routed to
   * their stream rooms too — a client viewing a thread only joins the
   * thread's room, not the root's, so without this it would never learn the
   * root was archived and the composer would stay live until a refresh.
   * Threads inherit access from the root (INV-62), so routing to their rooms
   * reaches exactly the same audience as the root room — no leak.
   */
  threadStreamIds?: string[]
}

export interface StreamUnarchivedOutboxPayload extends WorkspaceScopedPayload {
  streamId: string
  stream: Stream
  /** See {@link StreamArchivedOutboxPayload.event}. */
  event: StreamEvent
  /** See {@link StreamArchivedOutboxPayload.threadStreamIds}. */
  threadStreamIds?: string[]
}

export interface AttachmentUploadedOutboxPayload extends WorkspaceScopedPayload {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
}

export interface AttachmentTranscodedOutboxPayload extends WorkspaceScopedPayload {
  attachmentId: string
  processingStatus: string
  streamId?: string
  messageId?: string
}

/**
 * Fired when the image thumbnail worker finishes resizing an uploaded image.
 * Carries the orientation-corrected dimensions so clients can reserve the
 * image box (and switch from the raw fallback to the thumbnail variant) even
 * when the message was sent before the worker completed.
 */
export interface AttachmentThumbnailedOutboxPayload extends WorkspaceScopedPayload {
  attachmentId: string
  width: number
  height: number
  streamId?: string
  messageId?: string
}

/**
 * Fired when a reserved upload's state changes for an attachment already
 * bound to a message: settled (bytes landed + scan verdict applied), failed
 * (client report or staleness sweep), or abandoned. Stored message content is
 * never revisited, so this event is what flips already-rendered timeline
 * chips; unbound reservations emit nothing (only the uploader's own composer
 * tracks those, locally).
 */
export interface AttachmentUploadStatusChangedOutboxPayload extends WorkspaceScopedPayload {
  attachmentId: string
  uploadStatus: AttachmentUploadStatus
  safetyStatus: AttachmentSafetyStatus
  streamId: string
  messageId: string
}

/**
 * Fired in the same transaction as the `attachment_extractions` insert,
 * across all extraction pipelines (text/word/image-caption via
 * `processAttachment`, plus the PDF assemble path). The
 * `AttachmentEmbeddingHandler` consumes it to enqueue summary-embedding
 * jobs; carries `contentType` so the handler can short-circuit ineligible
 * extractions (`photo`, `other`) before paying for an enqueue.
 */
export interface AttachmentExtractionCompletedOutboxPayload extends WorkspaceScopedPayload {
  attachmentId: string
  contentType: import("@threa/types").ExtractionContentType
}

export interface WorkspaceUserAddedOutboxPayload extends WorkspaceScopedPayload {
  user: User
}

export interface WorkspaceUserRemovedOutboxPayload extends WorkspaceScopedPayload {
  removedUserId: string
}

export interface WorkspaceUserUpdatedOutboxPayload extends WorkspaceScopedPayload {
  user: User
}

/** Stream-scoped event for sidebar updates when new messages arrive.
 *  Only members of the stream receive preview content. */
export interface StreamActivityOutboxPayload extends StreamScopedPayload {
  authorId: string
  /** The message event's per-stream sequence (bigint as string). */
  sequence: string
  /**
   * Count of message_created events with sequence ≤ this one — an absolute,
   * recipient-independent stream fact (sync phase 2c). Clients derive
   * unread as latestOrdinal - lastReadOrdinal instead of incrementing.
   */
  messageOrdinal: number
  lastMessagePreview: LastMessagePreview
}

export interface ConversationCreatedOutboxPayload extends StreamScopedPayload {
  conversationId: string
  conversation: ConversationWithStaleness
  /** For thread conversations, the parent channel's stream ID (for discoverability) */
  parentStreamId?: string
  /** Visibility of the conversation's access-root stream (the parent channel for
   *  a thread). Drives workspace-wide board delivery: `public` → the whole
   *  workspace receives it (the board can show it); otherwise only the stream's
   *  own members do, via the stream room (INV-62). */
  streamVisibility?: Visibility
  /** Members of this conversation whose assignment is still settling (provisional
   *  low-confidence placement). Omitted by emitters that don't read the state;
   *  an explicit `[]` means "nothing settling here". */
  settlingMessageIds?: string[]
}

export interface ConversationUpdatedOutboxPayload extends StreamScopedPayload {
  conversationId: string
  conversation: ConversationWithStaleness
  /** For thread conversations, the parent channel's stream ID (for discoverability) */
  parentStreamId?: string
  /** See {@link ConversationCreatedOutboxPayload.streamVisibility}. */
  streamVisibility?: Visibility
  /** See {@link ConversationCreatedOutboxPayload.settlingMessageIds}. */
  settlingMessageIds?: string[]
  /**
   * Set when the update is a pure status fade from the staleness sweep — no
   * new content. The memo accumulator skips these instead of re-queueing the
   * conversation for extraction.
   */
  origin?: "staleness-sweep"
}

/**
 * Emitted when a message is assigned to a conversation (primary or secondary).
 * The frontend uses this to update its per-message conversation membership map
 * without refetching the conversation aggregate.
 */
export interface ConversationMessageAssignedOutboxPayload extends StreamScopedPayload {
  messageId: string
  conversationId: string
  isPrimary: boolean
  reason: string
  /** For thread messages, the parent channel's stream ID so the parent-channel
   *  room also receives the membership update. */
  parentStreamId?: string
  /** Whether this assignment is provisional (low extractor confidence). */
  settling?: boolean
}

/**
 * Emitted when the boundary extractor moves a previously-classified message's
 * primary assignment from one conversation to another. Carries both ends so the
 * frontend can update its membership map in a single hop.
 */
export interface ConversationMessageReassignedOutboxPayload extends StreamScopedPayload {
  messageId: string
  fromConversationId: string
  toConversationId: string
  reason: string
}

/**
 * A memo was captured, for the room it was captured from.
 *
 * STREAM-scoped to the memo's source root and carries the id alone — the memory
 * explorer only invalidates on it, and every payload is copied verbatim into
 * `sync_log` and replayed on catch-up for weeks, so content here would outlive
 * the emit. `scopeUserId` is set for a `user`-scoped memo (private to its owner
 * even inside a shared stream), which routes to that user instead of the room.
 */
export interface MemoCreatedOutboxPayload extends StreamScopedPayload {
  memoId: string
  scopeUserId?: string
}

/**
 * A memo's card content changed, for the streams that cite it.
 *
 * STREAM-scoped, one event per citing stream, and it carries only the card's
 * fields — never the abstract or key points. Both are deliberate: the summary a
 * room may see is decided per room (`findEmbedSummaries`), so a workspace-wide
 * broadcast would hand it to people who can't open the memo, and the card needs
 * nothing beyond what it draws.
 *
 * This is the ONLY thing allowed to change a rendered memo card. Content may
 * change when the memo changed; it may not change because it hadn't loaded.
 */
export interface MemoUpdatedOutboxPayload extends StreamScopedPayload {
  memoId: string
  summary: MemoEmbedSummary
}

// Author-scoped event payloads (only visible to the author)
export interface CommandDispatchedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
  authorId: string
}

export interface CommandCompletedOutboxPayload extends StreamScopedPayload {
  authorId: string
  event: StreamEvent
}

export interface CommandFailedOutboxPayload extends StreamScopedPayload {
  authorId: string
  event: StreamEvent
}

interface AgentSessionOutboxPayload extends StreamScopedPayload {
  rootStreamId?: string
  event: StreamEvent
}

export type AgentSessionStartedOutboxPayload = AgentSessionOutboxPayload
export type AgentSessionCompletedOutboxPayload = AgentSessionOutboxPayload
export type AgentSessionFailedOutboxPayload = AgentSessionOutboxPayload
export type AgentSessionInterruptedOutboxPayload = AgentSessionOutboxPayload
export type AgentSessionDeletedOutboxPayload = AgentSessionOutboxPayload

// Read state event payloads (author-scoped - only visible to the user marking as read)
export interface StreamReadOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamId: string
  lastReadEventId: string
  /** The read event's per-stream sequence (bigint as string; "0" when the event is missing). */
  lastReadSequence: string
  /**
   * Message ordinal of the read position (sync phase 2c): count of
   * message_created events with sequence ≤ the read event's. Clients derive
   * unread as latestOrdinal - lastReadOrdinal.
   */
  lastReadOrdinal: number
  /**
   * The member's ENTIRE sparse read overlay for this stream after the watermark
   * advance + prune (usually empty — the advance absorbs the run below it). The
   * client SETs its overlay to this absolute snapshot. See the sparse-read design.
   */
  readMessageIds: string[]
}

/**
 * The absolute post-write read-state snapshot for one stream, emitted by every
 * sparse-read overlay write (conversation read/unread). `readMessageIds` is the
 * ENTIRE overlay after the write (post-compaction) — absolute state, not a delta,
 * so application is idempotent under the sync log's total order. Author-scoped.
 */
export interface StreamReadMessagesOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamId: string
  readMessageIds: string[]
  lastReadEventId: string | null
  /** The watermark's per-stream sequence (bigint as string; "0" when no watermark). */
  lastReadSequence: string
  lastReadOrdinal: number
  /** The ids this write marked read (pre-compaction) — drives the client's
   * message-granular activity drop. Absent on unread/regress writes. */
  markedMessageIds?: string[]
}

/**
 * Read-pointer SET (author-scoped). Unlike `stream:read`, which advances the
 * read position monotonically (the client MAX-merges its ordinal), this is an
 * authoritative set emitted by an explicit "mark as unread" and may move the
 * pointer BACKWARD. Clients apply the ordinal as a plain set so unread can rise.
 * `lastReadEventId` is null when the pointer lands before the first message.
 */
export interface StreamReadSetOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamId: string
  lastReadEventId: string | null
  /** The read pointer's per-stream sequence (bigint as string; "0" when before the first message). */
  lastReadSequence: string
  /** Message ordinal of the read pointer; clients derive unread as latestOrdinal - lastReadOrdinal. */
  lastReadOrdinal: number
  /**
   * The member's ENTIRE sparse read overlay for this stream after the pointer
   * SET + overlay delete. The client SETs its overlay to this absolute snapshot.
   */
  readMessageIds: string[]
}

// Notification-level event payload (author-scoped — the mute/notify choice is
// the acting user's own per-stream preference, so it reaches only their other
// sessions, mirroring stream:read).
export interface StreamNotificationLevelUpdatedOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamId: string
  notificationLevel: NotificationLevel | null
}

export interface StreamsReadAllOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamIds: string[]
  /**
   * Absolute read position per updated stream (sync phase 2c). Read-all
   * pins each membership to its stream's latest event, so the ordinal is the
   * stream's total message count at read time.
   */
  reads: Array<{ streamId: string; lastReadOrdinal: number }>
  /**
   * The canonical post-write frontier per updated stream (additive) — the
   * standalone watermark + resolved sequence + absolute ordinal a client
   * advances its read state from. One bounded snapshot for the whole batch.
   * Absent on events emitted before the field shipped: the client leaves its
   * frontier untouched and reconciles on the next bootstrap.
   */
  frontiers?: StreamReadFrontierSnapshot[]
}

// User preferences event payload (author-scoped - only visible to the user who updated)
export interface UserPreferencesUpdatedOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  preferences: UserPreferences
}

// Sidebar config event payload (author-scoped - only visible to the user who updated)
export interface SidebarConfigUpdatedOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  sidebarConfig: SidebarConfig
}

// Workspace settings event payload (workspace-scoped - every member inherits
// the default, so the broadcast falls through to the workspace room).
export interface WorkspaceSettingsUpdatedOutboxPayload extends WorkspaceScopedPayload {
  settings: WorkspaceSettings
}

// Persona config override event payload (workspace-scoped — every member
// inherits the built-in persona, so a config change falls through to the
// workspace room; carries the resolved light persona so display name/avatar
// caches update without a refetch).
export interface AgentConfigUpdatedOutboxPayload extends WorkspaceScopedPayload {
  agentId: string
  persona: PersonaListItem
}

// Feature flags event payload (user-scoped). Carries the user layer's raw
// overrides — the frontend patches its user layer and re-resolves. A resolved
// map cannot be broadcast because each recipient has their own workspace layer.
export interface FeatureFlagsUpdatedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  overrides: Record<string, string>
}

// Workspace-scope feature flags event payload (workspace-scoped — falls through
// to the workspace room). Carries the workspace layer's raw overrides; the
// frontend patches its workspace layer and re-resolves against its own user
// layer, which the server cannot do on its behalf.
export interface FeatureFlagsWorkspaceUpdatedOutboxPayload extends WorkspaceScopedPayload {
  overrides: Record<string, string>
}

export interface InvitationSentOutboxPayload extends WorkspaceScopedPayload {
  invitationId: string
  email: string
  role: WorkspaceInvitableRole
  inviterWorkosUserId?: string
}

export interface InvitationLinkCreatedOutboxPayload extends WorkspaceScopedPayload {
  invitationId: string
  tokenHash: string
  role: WorkspaceInvitableRole
  expiresAt: string
}

export interface InvitationLinkClaimedOutboxPayload extends WorkspaceScopedPayload {
  invitationId: string
  email: string
  role: WorkspaceInvitableRole
  inviterWorkosUserId?: string
}

export interface InvitationAcceptedOutboxPayload extends WorkspaceScopedPayload {
  invitationId: string
  email: string
  workosUserId: string
  userName: string
}

export interface InvitationRevokedOutboxPayload extends WorkspaceScopedPayload {
  invitationId: string
}

// User-scoped event payloads (delivered to a specific target user)
export interface ActivityCreatedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  /**
   * The target user's absolute unread counts for the activity's stream,
   * computed after the row was inserted (sync phase 2c). Clients set
   * counters from these — never increment — so replays converge.
   */
  counts: {
    mentionCount: number
    activityCount: number
  }
  activity: {
    id: string
    activityType: string
    /** Null only for saved_reminder rows fired by standalone (message-less) saved items. */
    streamId: string | null
    messageId: string | null
    actorId: string
    actorType: string
    context: Record<string, unknown>
    createdAt: string
    /**
     * Self rows represent the target user's own action. The push service must
     * not deliver notifications for these; the frontend must not increment
     * unread counts either.
     */
    isSelf: boolean
    /** Reaction emoji (null for non-reaction rows); lets the client drop the held row on reaction:removed. */
    emoji: string | null
  }
}

/**
 * A batch of the target user's activity rows flipped to read (per-row click,
 * stream open, or mark-all). A delta of the flipped ids — drops are idempotent
 * and commute on the client, so replays/duplicates converge. `streamIds` is the
 * distinct non-null streams of those rows: populated for stream/all-scope
 * clears (drives push-banner dismissal), empty for per-row reads, which must
 * not dismiss a grouped banner that may still represent sibling unread rows.
 */
export interface ActivityReadOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  activityIds: string[]
  streamIds: string[]
}

export interface SavedUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  saved: SavedMessageView
}

export interface SavedDeletedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  savedId: string
  /** Null for standalone (message-less) saved items. */
  messageId: string | null
}

export interface SavedReminderFiredOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  savedId: string
  /** Null for standalone (message-less) saved items. */
  messageId: string | null
  streamId: string | null
  saved: SavedMessageView
}

export interface SavedSuggestionUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  suggestion: SavedSuggestionView
}

export interface ScheduledMessageUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  scheduled: ScheduledMessageView
}

export interface ScheduledMessageSentOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  scheduledId: string
  sentMessageId: string
  streamId: string
  scheduled: ScheduledMessageView
}

export interface ScheduledMessageCancelledOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  scheduledId: string
}

// Draft event payloads. Drafts are private to their author, so both events are
// user-scoped (delivered to `user:{targetUserId}` only) — never timeline rows.
export interface DraftUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  draft: WireDraft
}

export interface DraftDeletedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  draftId: string
}

// Per-viewer board exclusions (board-view-design.md § "Hide & mute"). Both are
// user-scoped — a hide/mute is one viewer's private board state, delivered only
// to `user:{targetUserId}` for multi-device reconcile, never a timeline row.
export interface BoardConversationHideChangedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  conversationId: string
  /** true = hidden, false = un-hidden. */
  active: boolean
  /** The snooze watermark (ISO), present only when `active`. */
  hiddenAt?: string
}

export interface BoardStreamMuteChangedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  streamId: string
  /** true = muted, false = un-muted. */
  active: boolean
}

// Proactive owner re-wrap nudges. When an enclave turn can't be served because
// no live EIK holds the stream's SSK wrap, only the owner's unlocked device can
// re-wrap (INV-E7). `enclave:rewrap_needed` is user-scoped — it reaches the
// owner's online tab, which heals in place. `enclave:rewrap_nudge` is push-only
// (delivery-groups returns null, never broadcast): the push handler turns it
// into a web-push that pulls an offline owner back to the app. Both carry the
// root stream the heal targets — never any plaintext.
export interface EnclaveRewrapNeededOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  rootStreamId: string
}

export interface EnclaveRewrapNudgeOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  rootStreamId: string
}

/**
 * Internal-only (never broadcast to clients — resolveDeliveryGroups returns
 * null): a durable side effect committed in the same transaction as a GitHub
 * integration write so route (un)registration in the control plane can't be lost
 * to a crash between the local write and the CP HTTP call. `GithubRouteSyncHandler`
 * consumes it and calls `ControlPlaneClient.registerIntegrationRoute` /
 * `unregisterIntegrationRoute`. `installationId` is the plaintext GitHub
 * installation id (not a secret); `region` is this region's routing key.
 */
export interface GithubRouteRegisterOutboxPayload extends WorkspaceScopedPayload {
  installationId: string
  region: string
}

export interface GithubRouteUnregisterOutboxPayload extends WorkspaceScopedPayload {
  installationId: string
  region: string
}

/**
 * A DM call is ringing the invitee. User-scoped to the invitee (their user room,
 * cross-device by construction) and emitted in the same tx as the invitation
 * insert (INV-4). Carries everything the incoming-call overlay and the ring push
 * need without a follow-up fetch: `attemptId` is the invitation id (the
 * attempt-keyed handle M2 group-invites reuse), `expiresAt` bounds the ring so a
 * stale replay self-dismisses. `mode` is the call's media mode ("video" |
 * "audio_only").
 */
export interface CallInvitationCreatedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  attemptId: string
  callId: string
  streamId: string
  inviter: { id: string; name: string | null }
  mode: string
  expiresAt: string
}

/**
 * A ring reached a terminal state. User-scoped to the invitee so every one of
 * their devices clears the overlay (an accept on the phone silences the laptop)
 * and the ring push is cancelled. Emitted on every terminal CAS — join-accept,
 * decline, cancel, sweeper-expire. `settledBy` is an optional device hint.
 */
export interface CallInvitationSettledOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  attemptId: string
  callId: string
  outcome: "accepted" | "declined" | "cancelled" | "expired" | "superseded"
  settledBy?: string
  /**
   * Inviter display name, for the SW's offline "Call ended" fallback. Present so
   * a cancel that collapsed an unshown ring can still name the caller; null when
   * the inviter row is gone.
   */
  inviterName?: string | null
}

/**
 * Carries a `call_started` / `call_ended` timeline event (roadmap 1.4) to the
 * host stream's room. Same envelope shape as the delegation events: the full
 * stream event rides along so clients append it without a fetch (`call_started`
 * renders the live card; `call_ended` patches it with the end summary).
 *
 * These events ALSO drive the sidebar live-call dot, which must reach members not
 * currently in the stream room. `streamVisibility` + `memberUserIds` let
 * `resolveDeliveryGroups` fan them additionally to the whole workspace (public
 * channels) or to each member's user room (private/DM), mirroring the
 * public-channel-conversation precedent.
 */
export interface StreamCallStartedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
  callId: string
  streamVisibility: Visibility
  /** Host-stream member UserIds — the dot fan-out targets for a private/DM call. */
  memberUserIds: string[]
}

export interface StreamCallEndedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
  callId: string
  streamVisibility: Visibility
  memberUserIds: string[]
}

/**
 * A call's live roster changed (join/leave/remove/reap). Stream-scoped ONLY (no
 * timeline row, no EVENT_TYPES entry) — it refreshes the in-stream call card's
 * live avatars/count for clients already in the room. The sidebar dot rides the
 * `stream:call_started` / `stream:call_ended` presence events instead.
 */
export interface CallParticipantsChangedOutboxPayload extends StreamScopedPayload {
  callId: string
  participantCount: number
  participantUserIds: string[]
}

// Bot event payloads
export interface BotCreatedOutboxPayload extends WorkspaceScopedPayload {
  bot: WireBot
}

export interface BotUpdatedOutboxPayload extends WorkspaceScopedPayload {
  bot: WireBot
}

// Bot-runtime WebSocket pushes. All routed on the dedicated `/bot` namespace,
// keyed by botId rather than streamId/userId. Carry metadata only — never
// message content or anything the worker shouldn't see; the bot fetches the
// authoritative row via HTTP. See docs/bot-runtime-websocket-plan.md.
export interface BotInvocationAvailableOutboxPayload extends WorkspaceScopedPayload {
  botId: string
  invocationId: string
  requiredCapability: BotInvocationCapability
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  createdAt: string
}

export interface BotInvocationClaimedOutboxPayload extends WorkspaceScopedPayload {
  botId: string
  invocationId: string
  // Deliberately omits `claimedByInstanceId` — siblings only need "stop racing
  // this one", not the winning instance's identity.
}

export interface BotActiveActorChangedOutboxPayload extends WorkspaceScopedPayload {
  rootStreamId: string
  // `previous*` is nullable because a brand-new root stream has no prior actor
  // — the upsert in `setActiveActorInTransaction` runs the first time without
  // an existing row. `new*` always reflects the post-upsert row, which always
  // has a concrete actor, so the dispatcher and consumers never have to
  // null-check the right-hand side.
  previousActorType: "bot" | "persona" | null
  previousActorId: string | null
  newActorType: "bot" | "persona"
  newActorId: string
  // Routing fan-out: computed at insert time from previous + new actor IDs so
  // the dispatcher can stay pure routing without re-reading actor identity.
  affectedBotIds: string[]
}

export interface BotResyncOutboxPayload extends WorkspaceScopedPayload {
  // Most-specific target wins at routing time. Both null = workspace-wide.
  // `instanceId` requires `botId` (enforced at insert).
  botId: string | null
  instanceId: string | null
  reason: string
}

/**
 * The scratchpad a runtime session was linked to has been archived; the link is
 * already `ended` server-side. The runtime should wind itself down (the Claude
 * channel pushes its branch and kills its own tmux window on receipt).
 */
export interface BotSessionArchivedOutboxPayload extends WorkspaceScopedPayload {
  botId: string
  instanceId: string
  runtimeSessionId: string
  rootStreamId: string
}

/**
 * The unarchive counterpart of `bot:session_archived`: the scratchpad a runtime
 * session was linked to has been unarchived and the link is 'active' again
 * server-side. A live runtime cancels its wind-down and reattaches on receipt.
 */
export interface BotSessionRestoredOutboxPayload extends WorkspaceScopedPayload {
  botId: string
  instanceId: string
  runtimeSessionId: string
  rootStreamId: string
}

// Label event payloads. Labels are owner-scoped, so `targetUserId` is always the
// owning actor and the broadcast handler delivers to that actor's user room only.
export interface LabelUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  label: Label
}

export interface LabelDeletedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  labelId: string
}

// Assignment events are owner-scoped like the label itself: `targetUserId` is
// the actor who applied/removed the row, the only one who sees it. `assigned`
// carries the full row; `unassigned` carries only the key since the row is gone.
export interface LabelAssignedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  assignment: LabelAssignment
}

export interface LabelUnassignedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
  userId: string
}

// Link preview event payloads
export interface LinkPreviewReadyOutboxPayload extends StreamScopedPayload {
  messageId: string
  previews: import("@threa/types").LinkPreviewSummary[]
}

export interface LinkPreviewDismissedOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  messageId: string
  linkPreviewId: string
}

// Budget alert event payload
export interface BudgetAlertOutboxPayload extends WorkspaceScopedPayload {
  alertType: string
  thresholdPercent: number
  currentUsageUsd: number
  budgetUsd: number
  percentUsed: number
}

/**
 * Maps event types to their payload types for type-safe event handling.
 */
export interface DynamicNamingRequestedOutboxPayload {
  workspaceId: string
  targetKind: "stream" | "conversation"
  targetId: string
  deferred: boolean
}

export interface OutboxEventPayloadMap {
  "message:created": MessageCreatedOutboxPayload
  "message:edited": MessageEditedOutboxPayload
  "message:deleted": MessageDeletedOutboxPayload
  "messages:moved": MessagesMovedOutboxPayload
  "thread:updated": ThreadUpdatedOutboxPayload
  "reaction:added": ReactionOutboxPayload
  "reaction:removed": ReactionOutboxPayload
  "stream:created": StreamCreatedOutboxPayload
  "stream:updated": StreamUpdatedOutboxPayload
  "stream:archived": StreamArchivedOutboxPayload
  "stream:unarchived": StreamUnarchivedOutboxPayload
  "stream:display_name_updated": StreamDisplayNameUpdatedPayload
  "stream:member_joined": StreamMemberJoinedOutboxPayload
  "stream:member_added": StreamMemberAddedOutboxPayload
  "stream:member_removed": StreamMemberRemovedOutboxPayload
  "stream:memos_captured": StreamMemosCapturedOutboxPayload
  "stream:description_set": StreamDescriptionSetOutboxPayload
  "stream:agent_follow_up_scheduled": StreamAgentFollowUpScheduledOutboxPayload
  "stream:agent_follow_up_cancelled": StreamAgentFollowUpCancelledOutboxPayload
  "stream:brief_updated": StreamBriefUpdatedOutboxPayload
  "stream:delegation_created": StreamDelegationCreatedOutboxPayload
  "stream:delegation_status_changed": StreamDelegationStatusChangedOutboxPayload
  "stream:bot_access_requested": StreamBotAccessRequestedOutboxPayload
  "stream:bot_access_status_changed": StreamBotAccessStatusChangedOutboxPayload
  "stream:read": StreamReadOutboxPayload
  "stream:read_set": StreamReadSetOutboxPayload
  "stream:read_all": StreamsReadAllOutboxPayload
  "stream:read_messages": StreamReadMessagesOutboxPayload
  "stream:notification_level_updated": StreamNotificationLevelUpdatedOutboxPayload
  "stream:activity": StreamActivityOutboxPayload
  "attachment:uploaded": AttachmentUploadedOutboxPayload
  "workspace_user:added": WorkspaceUserAddedOutboxPayload
  "workspace_user:removed": WorkspaceUserRemovedOutboxPayload
  "workspace_user:updated": WorkspaceUserUpdatedOutboxPayload
  "conversation:created": ConversationCreatedOutboxPayload
  "conversation:updated": ConversationUpdatedOutboxPayload
  "conversation:message_assigned": ConversationMessageAssignedOutboxPayload
  "conversation:message_reassigned": ConversationMessageReassignedOutboxPayload
  "dynamic_naming:requested": DynamicNamingRequestedOutboxPayload
  "board:conversation_hide_changed": BoardConversationHideChangedOutboxPayload
  "board:stream_mute_changed": BoardStreamMuteChangedOutboxPayload
  "memo:created": MemoCreatedOutboxPayload
  "memo:updated": MemoUpdatedOutboxPayload
  "command:dispatched": CommandDispatchedOutboxPayload
  "command:completed": CommandCompletedOutboxPayload
  "command:failed": CommandFailedOutboxPayload
  "agent_session:started": AgentSessionStartedOutboxPayload
  "agent_session:completed": AgentSessionCompletedOutboxPayload
  "agent_session:failed": AgentSessionFailedOutboxPayload
  "agent_session:interrupted": AgentSessionInterruptedOutboxPayload
  "agent_session:deleted": AgentSessionDeletedOutboxPayload
  "user_preferences:updated": UserPreferencesUpdatedOutboxPayload
  "sidebar_config:updated": SidebarConfigUpdatedOutboxPayload
  "workspace_settings:updated": WorkspaceSettingsUpdatedOutboxPayload
  "feature_flags:updated": FeatureFlagsUpdatedOutboxPayload
  "feature_flags:workspace_updated": FeatureFlagsWorkspaceUpdatedOutboxPayload
  "agent_config:updated": AgentConfigUpdatedOutboxPayload
  "budget:alert": BudgetAlertOutboxPayload
  "invitation:sent": InvitationSentOutboxPayload
  "invitation:link-created": InvitationLinkCreatedOutboxPayload
  "invitation:link-claimed": InvitationLinkClaimedOutboxPayload
  "invitation:accepted": InvitationAcceptedOutboxPayload
  "invitation:revoked": InvitationRevokedOutboxPayload
  "activity:created": ActivityCreatedOutboxPayload
  "activity:read": ActivityReadOutboxPayload
  "saved:upserted": SavedUpsertedOutboxPayload
  "saved:deleted": SavedDeletedOutboxPayload
  "saved_reminder:fired": SavedReminderFiredOutboxPayload
  "saved_suggestion:upserted": SavedSuggestionUpsertedOutboxPayload
  "scheduled_message:upserted": ScheduledMessageUpsertedOutboxPayload
  "scheduled_message:sent": ScheduledMessageSentOutboxPayload
  "scheduled_message:cancelled": ScheduledMessageCancelledOutboxPayload
  "draft:upserted": DraftUpsertedOutboxPayload
  "draft:deleted": DraftDeletedOutboxPayload
  "bot:created": BotCreatedOutboxPayload
  "bot:updated": BotUpdatedOutboxPayload
  "link_preview:ready": LinkPreviewReadyOutboxPayload
  "link_preview:dismissed": LinkPreviewDismissedOutboxPayload
  "attachment:transcoded": AttachmentTranscodedOutboxPayload
  "attachment:thumbnailed": AttachmentThumbnailedOutboxPayload
  "attachment:upload_status_changed": AttachmentUploadStatusChangedOutboxPayload
  "attachment:extraction_completed": AttachmentExtractionCompletedOutboxPayload
  "bot_invocation:available": BotInvocationAvailableOutboxPayload
  "bot_invocation:claimed": BotInvocationClaimedOutboxPayload
  "bot:active_actor_changed": BotActiveActorChangedOutboxPayload
  "bot:resync": BotResyncOutboxPayload
  "bot:session_archived": BotSessionArchivedOutboxPayload
  "bot:session_restored": BotSessionRestoredOutboxPayload
  "label:created": LabelUpsertedOutboxPayload
  "label:updated": LabelUpsertedOutboxPayload
  "label:deleted": LabelDeletedOutboxPayload
  "label:assigned": LabelAssignedOutboxPayload
  "label:unassigned": LabelUnassignedOutboxPayload
  "enclave:rewrap_needed": EnclaveRewrapNeededOutboxPayload
  "enclave:rewrap_nudge": EnclaveRewrapNudgeOutboxPayload
  "github_route:register": GithubRouteRegisterOutboxPayload
  "github_route:unregister": GithubRouteUnregisterOutboxPayload
  "call:invitation_created": CallInvitationCreatedOutboxPayload
  "call:invitation_settled": CallInvitationSettledOutboxPayload
  "stream:call_started": StreamCallStartedOutboxPayload
  "stream:call_ended": StreamCallEndedOutboxPayload
  "call:participants_changed": CallParticipantsChangedOutboxPayload
}

export type OutboxEventPayload<T extends OutboxEventType> = OutboxEventPayloadMap[T]

export interface OutboxEvent<T extends OutboxEventType = OutboxEventType> {
  id: bigint
  eventType: T
  payload: OutboxEventPayloadMap[T]
  createdAt: Date
}

/**
 * Type guard to narrow an OutboxEvent to a specific event type.
 */
export function isOutboxEventType<T extends OutboxEventType>(
  event: OutboxEvent,
  eventType: T
): event is OutboxEvent<T> {
  return event.eventType === eventType
}

/**
 * Type guard to narrow an OutboxEvent to one of several event types.
 */
export function isOneOfOutboxEventType<T extends OutboxEventType>(
  event: OutboxEvent,
  eventTypes: T[]
): event is OutboxEvent<T> {
  return eventTypes.includes(event.eventType as T)
}

const STREAM_SCOPED_EVENTS: StreamScopedEventType[] = [
  // Routing is driven by THIS list, not by the payload extending
  // `StreamScopedPayload` — `resolveDeliveryGroups` only takes the stream
  // branch when `isStreamScopedEvent` finds the type here. Omitted, an event
  // falls through to the whole-workspace group, which for these two would hand
  // a memo's existence and card content to every member regardless of stream
  // access — the shape that shipped a leak on each of them in turn.
  "memo:created",
  "memo:updated",
  "message:created",
  "message:edited",
  "message:deleted",
  "messages:moved",
  "thread:updated",
  "reaction:added",
  "reaction:removed",
  "stream:display_name_updated",
  "stream:member_joined",
  "stream:member_added",
  "stream:member_removed",
  "stream:memos_captured",
  "stream:description_set",
  "stream:agent_follow_up_scheduled",
  "stream:agent_follow_up_cancelled",
  "stream:brief_updated",
  "stream:delegation_created",
  "stream:delegation_status_changed",
  "stream:bot_access_requested",
  "stream:bot_access_status_changed",
  "call:participants_changed",
  "stream:activity",
  "conversation:created",
  "conversation:updated",
  "conversation:message_assigned",
  "conversation:message_reassigned",
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
  "agent_session:interrupted",
  "agent_session:deleted",
  "link_preview:ready",
  "command:dispatched",
  "command:completed",
  "command:failed",
]

/**
 * Type guard to check if an event is stream-scoped (has streamId in payload).
 */
export function isStreamScopedEvent(event: OutboxEvent): event is OutboxEvent<StreamScopedEventType> {
  return STREAM_SCOPED_EVENTS.includes(event.eventType as StreamScopedEventType)
}

/** Events that are author-scoped (only visible to the author) */
export type AuthorScopedEventType =
  | "stream:read"
  | "stream:read_set"
  | "stream:read_all"
  | "stream:read_messages"
  | "stream:notification_level_updated"
  | "user_preferences:updated"
  | "sidebar_config:updated"
  | "link_preview:dismissed"

const AUTHOR_SCOPED_EVENTS: AuthorScopedEventType[] = [
  "stream:read",
  "stream:read_set",
  "stream:read_all",
  "stream:read_messages",
  "stream:notification_level_updated",
  "link_preview:dismissed",
  "user_preferences:updated",
  "sidebar_config:updated",
]

/**
 * Type guard to check if an event is author-scoped (only visible to the author).
 * These events are emitted only to sockets belonging to the author.
 */
export function isAuthorScopedEvent(event: OutboxEvent): event is OutboxEvent<AuthorScopedEventType> {
  return AUTHOR_SCOPED_EVENTS.includes(event.eventType as AuthorScopedEventType)
}

/** Events that are scoped to a specific target user (delivered to that user's sockets) */
export type UserScopedEventType =
  | "activity:created"
  | "activity:read"
  | "saved:upserted"
  | "saved:deleted"
  | "saved_reminder:fired"
  | "saved_suggestion:upserted"
  | "scheduled_message:upserted"
  | "scheduled_message:sent"
  | "scheduled_message:cancelled"
  | "draft:upserted"
  | "draft:deleted"
  | "board:conversation_hide_changed"
  | "board:stream_mute_changed"
  | "feature_flags:updated"
  | "enclave:rewrap_needed"
  | "call:invitation_created"
  | "call:invitation_settled"

const USER_SCOPED_EVENTS: UserScopedEventType[] = [
  "activity:created",
  "activity:read",
  "saved:upserted",
  "saved:deleted",
  "saved_reminder:fired",
  "saved_suggestion:upserted",
  "scheduled_message:upserted",
  "scheduled_message:sent",
  "scheduled_message:cancelled",
  "draft:upserted",
  "draft:deleted",
  "board:conversation_hide_changed",
  "board:stream_mute_changed",
  "feature_flags:updated",
  "enclave:rewrap_needed",
  "call:invitation_created",
  "call:invitation_settled",
]

/**
 * Type guard to check if an event is user-scoped (delivered to a specific target user).
 */
export function isUserScopedEvent(event: OutboxEvent): event is OutboxEvent<UserScopedEventType> {
  return USER_SCOPED_EVENTS.includes(event.eventType as UserScopedEventType)
}

/** Events routed on the dedicated `/bot` Socket.IO namespace, keyed by botId. */
export type BotScopedEventType =
  | "bot_invocation:available"
  | "bot_invocation:claimed"
  | "bot:active_actor_changed"
  | "bot:resync"
  | "bot:session_archived"
  | "bot:session_restored"

const BOT_SCOPED_EVENTS: BotScopedEventType[] = [
  "bot_invocation:available",
  "bot_invocation:claimed",
  "bot:active_actor_changed",
  "bot:resync",
  "bot:session_archived",
  "bot:session_restored",
]

/**
 * Type guard for bot-scoped events. BroadcastHandler routes these to the `/bot`
 * namespace and per-bot rooms instead of the default namespace.
 */
export function isBotScopedEvent(event: OutboxEvent): event is OutboxEvent<BotScopedEventType> {
  return BOT_SCOPED_EVENTS.includes(event.eventType as BotScopedEventType)
}

export { OUTBOX_CHANNEL } from "@threa/backend-common"
export type { DeleteRetainedOutboxEventsParams } from "@threa/backend-common"

/**
 * Type-safe wrapper around the generic OutboxRepository.
 * Narrows event types and payload maps to backend domain types.
 */
export const OutboxRepository = {
  insert: BaseOutboxRepository.insert as <T extends OutboxEventType>(
    client: Querier,
    eventType: T,
    payload: OutboxEventPayloadMap[T]
  ) => Promise<OutboxEvent<T>>,

  insertMany: BaseOutboxRepository.insertMany as <T extends OutboxEventType>(
    client: Querier,
    entries: Array<{ eventType: T; payload: OutboxEventPayloadMap[T] }>
  ) => Promise<OutboxEvent<T>[]>,

  fetchAfterId: BaseOutboxRepository.fetchAfterId as unknown as (
    client: Querier,
    afterId: bigint,
    limit?: number,
    excludeIds?: bigint[]
  ) => Promise<OutboxEvent[]>,

  getRetentionWatermark: BaseOutboxRepository.getRetentionWatermark,
  deleteRetainedEvents: BaseOutboxRepository.deleteRetainedEvents,
}
