import { OutboxRepository as BaseOutboxRepository, type Querier } from "@threa/backend-common"
import type { Stream } from "../../features/streams"
import type { StreamEvent } from "../../features/streams"
import type { User } from "../../features/workspaces"
import type { ConversationWithStaleness } from "../../features/conversations"
import type {
  Memo as WireMemo,
  StreamEvent as WireStreamEvent,
  UserPreferences,
  SidebarConfig,
  LastMessagePreview,
  Bot as WireBot,
  BotInvocationCapability,
  Label,
  LabelMember,
  LabelAssignment,
  LabelableResourceType,
  SavedMessageView,
  ScheduledMessageView,
  WorkspaceInvitableRole,
} from "@threa/types"

/**
 * Outbox event types and their payloads.
 * Use the OutboxEventPayload type to get type-safe payload access.
 */
export type OutboxEventType =
  | "message:created"
  | "message:edited"
  | "message:deleted"
  | "messages:moved"
  | "message:updated"
  | "reaction:added"
  | "reaction:removed"
  | "stream:created"
  | "stream:updated"
  | "stream:archived"
  | "stream:unarchived"
  | "stream:display_name_updated"
  | "stream:read"
  | "stream:read_all"
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
  | "memo:created"
  | "command:dispatched"
  | "command:completed"
  | "command:failed"
  | "agent_session:started"
  | "agent_session:completed"
  | "agent_session:failed"
  | "agent_session:deleted"
  | "user_preferences:updated"
  | "sidebar_config:updated"
  | "budget:alert"
  | "stream:member_joined"
  | "stream:member_added"
  | "stream:member_removed"
  | "invitation:sent"
  | "invitation:link-created"
  | "invitation:link-claimed"
  | "invitation:accepted"
  | "invitation:revoked"
  | "activity:created"
  | "saved:upserted"
  | "saved:deleted"
  | "saved_reminder:fired"
  | "scheduled_message:upserted"
  | "scheduled_message:sent"
  | "scheduled_message:cancelled"
  | "bot:created"
  | "bot:updated"
  | "link_preview:ready"
  | "link_preview:dismissed"
  | "attachment:transcoded"
  | "attachment:thumbnailed"
  | "bot_invocation:available"
  | "bot_invocation:claimed"
  | "bot:active_actor_changed"
  | "bot:resync"
  | "label:created"
  | "label:updated"
  | "label:deleted"
  | "label:member_joined"
  | "label:member_left"
  | "label:assigned"
  | "label:unassigned"

/** Events that are scoped to a stream (have streamId) */
export type StreamScopedEventType =
  | "message:created"
  | "message:edited"
  | "message:deleted"
  | "messages:moved"
  | "message:updated"
  | "reaction:added"
  | "reaction:removed"
  | "stream:display_name_updated"
  | "stream:member_joined"
  | "stream:member_added"
  | "stream:member_removed"
  | "stream:activity"
  | "conversation:created"
  | "conversation:updated"
  | "conversation:message_assigned"
  | "conversation:message_reassigned"
  | "agent_session:started"
  | "agent_session:completed"
  | "agent_session:failed"
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

/**
 * Base fields for stream-scoped events.
 */
interface StreamScopedPayload {
  workspaceId: string
  streamId: string
}

/**
 * Base fields for workspace-scoped events.
 */
interface WorkspaceScopedPayload {
  workspaceId: string
}

// Stream-scoped event payloads
export interface MessageCreatedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface MessageEditedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
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
   * Authoritative `replyCount` for the drop-target message (the thread
   * parent), recomputed AFTER the move's `incrementReplyCountBy`. Frontend
   * sets this directly on the parent message in the source stream. Including
   * it in `messages:moved` makes this event self-sufficient: ThreadCard
   * surfaces with the right count even if the sibling `message:updated`
   * outbox event is delayed, dropped, or processed out of order.
   */
  parentReplyCount: number
  /**
   * Recomputed thread summary for the drop-target — same field shape
   * `message:updated` ships, included here so the card preview/participants
   * land alongside the move without waiting for a second event.
   */
  parentThreadSummary: import("@threa/types").ThreadSummary | null
}

export interface MessageUpdatedOutboxPayload extends StreamScopedPayload {
  messageId: string
  updateType: "reply_count" | "content"
  replyCount?: number
  content?: string
  /**
   * When `updateType === "reply_count"`, carries the recomputed thread summary
   * (or `null` when the last remaining reply was deleted). Lets the frontend
   * refresh ThreadCard content alongside `replyCount` instead of waiting for
   * the next bootstrap.
   */
  threadSummary?: import("@threa/types").ThreadSummary | null
}

export interface ReactionOutboxPayload extends StreamScopedPayload {
  messageId: string
  emoji: string
  userId: string
}

export interface StreamDisplayNameUpdatedPayload extends StreamScopedPayload {
  displayName: string
  visibility: string
}

export interface StreamMemberJoinedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface StreamMemberAddedOutboxPayload extends StreamScopedPayload {
  memberId: string
  stream: Stream
  event: StreamEvent
}

export interface StreamMemberRemovedOutboxPayload extends StreamScopedPayload {
  memberId: string
  event: StreamEvent
}

// Workspace-scoped event payloads (no streamId)
// Note: StreamCreatedOutboxPayload includes streamId for routing:
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
}

export interface StreamUnarchivedOutboxPayload extends WorkspaceScopedPayload {
  streamId: string
  stream: Stream
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
  lastMessagePreview: LastMessagePreview
}

// Conversation event payloads
export interface ConversationCreatedOutboxPayload extends StreamScopedPayload {
  conversationId: string
  conversation: ConversationWithStaleness
  /** For thread conversations, the parent channel's stream ID (for discoverability) */
  parentStreamId?: string
}

export interface ConversationUpdatedOutboxPayload extends StreamScopedPayload {
  conversationId: string
  conversation: ConversationWithStaleness
  /** For thread conversations, the parent channel's stream ID (for discoverability) */
  parentStreamId?: string
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

// Memo event payloads
export interface MemoCreatedOutboxPayload extends WorkspaceScopedPayload {
  memoId: string
  memo: WireMemo
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

// Agent session event payloads (stream-scoped - visible to all stream members)
export interface AgentSessionStartedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface AgentSessionCompletedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface AgentSessionFailedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

export interface AgentSessionDeletedOutboxPayload extends StreamScopedPayload {
  event: StreamEvent
}

// Read state event payloads (author-scoped - only visible to the user marking as read)
export interface StreamReadOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamId: string
  lastReadEventId: string
}

export interface StreamsReadAllOutboxPayload extends WorkspaceScopedPayload {
  authorId: string
  streamIds: string[]
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

// Invitation event payloads
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
  activity: {
    id: string
    activityType: string
    streamId: string
    messageId: string
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
  }
}

export interface SavedUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  saved: SavedMessageView
}

export interface SavedDeletedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  savedId: string
  messageId: string
}

export interface SavedReminderFiredOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  savedId: string
  messageId: string
  streamId: string
  saved: SavedMessageView
}

// Scheduled message event payloads
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

// Label event payloads.
// `targetUserId` is non-null for private-label events (delivered to creator
// only) and null for public-label events (workspace-wide). The broadcast
// handler routes on this discriminator.
export interface LabelUpsertedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string | null
  label: Label
}

export interface LabelDeletedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string | null
  labelId: string
}

// Membership events are delivered to the affected member only (`targetUserId`),
// mirroring the viewer-scoped membership data shipped in bootstrap/list. `joined`
// carries the full row; `left` carries only identity since the row is gone.
export interface LabelMemberJoinedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  member: LabelMember
}

export interface LabelMemberLeftOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string
  labelId: string
  userId: string
}

// Assignment routing mirrors the label's visibility (like the upsert events
// above): `targetUserId` is the creator for a private-label row (delivered to
// their user room only) and null for a public-label row, which fans out to the
// resource's access scope — the stream room — so the shared pool reaches every
// member who can see the resource. `assigned` carries the full row; `unassigned`
// carries only the key since the row is gone.
export interface LabelAssignedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string | null
  assignment: LabelAssignment
}

export interface LabelUnassignedOutboxPayload extends WorkspaceScopedPayload {
  targetUserId: string | null
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
export interface OutboxEventPayloadMap {
  "message:created": MessageCreatedOutboxPayload
  "message:edited": MessageEditedOutboxPayload
  "message:deleted": MessageDeletedOutboxPayload
  "messages:moved": MessagesMovedOutboxPayload
  "message:updated": MessageUpdatedOutboxPayload
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
  "stream:read": StreamReadOutboxPayload
  "stream:read_all": StreamsReadAllOutboxPayload
  "stream:activity": StreamActivityOutboxPayload
  "attachment:uploaded": AttachmentUploadedOutboxPayload
  "workspace_user:added": WorkspaceUserAddedOutboxPayload
  "workspace_user:removed": WorkspaceUserRemovedOutboxPayload
  "workspace_user:updated": WorkspaceUserUpdatedOutboxPayload
  "conversation:created": ConversationCreatedOutboxPayload
  "conversation:updated": ConversationUpdatedOutboxPayload
  "conversation:message_assigned": ConversationMessageAssignedOutboxPayload
  "conversation:message_reassigned": ConversationMessageReassignedOutboxPayload
  "memo:created": MemoCreatedOutboxPayload
  "command:dispatched": CommandDispatchedOutboxPayload
  "command:completed": CommandCompletedOutboxPayload
  "command:failed": CommandFailedOutboxPayload
  "agent_session:started": AgentSessionStartedOutboxPayload
  "agent_session:completed": AgentSessionCompletedOutboxPayload
  "agent_session:failed": AgentSessionFailedOutboxPayload
  "agent_session:deleted": AgentSessionDeletedOutboxPayload
  "user_preferences:updated": UserPreferencesUpdatedOutboxPayload
  "sidebar_config:updated": SidebarConfigUpdatedOutboxPayload
  "budget:alert": BudgetAlertOutboxPayload
  "invitation:sent": InvitationSentOutboxPayload
  "invitation:link-created": InvitationLinkCreatedOutboxPayload
  "invitation:link-claimed": InvitationLinkClaimedOutboxPayload
  "invitation:accepted": InvitationAcceptedOutboxPayload
  "invitation:revoked": InvitationRevokedOutboxPayload
  "activity:created": ActivityCreatedOutboxPayload
  "saved:upserted": SavedUpsertedOutboxPayload
  "saved:deleted": SavedDeletedOutboxPayload
  "saved_reminder:fired": SavedReminderFiredOutboxPayload
  "scheduled_message:upserted": ScheduledMessageUpsertedOutboxPayload
  "scheduled_message:sent": ScheduledMessageSentOutboxPayload
  "scheduled_message:cancelled": ScheduledMessageCancelledOutboxPayload
  "bot:created": BotCreatedOutboxPayload
  "bot:updated": BotUpdatedOutboxPayload
  "link_preview:ready": LinkPreviewReadyOutboxPayload
  "link_preview:dismissed": LinkPreviewDismissedOutboxPayload
  "attachment:transcoded": AttachmentTranscodedOutboxPayload
  "attachment:thumbnailed": AttachmentThumbnailedOutboxPayload
  "attachment:extraction_completed": AttachmentExtractionCompletedOutboxPayload
  "bot_invocation:available": BotInvocationAvailableOutboxPayload
  "bot_invocation:claimed": BotInvocationClaimedOutboxPayload
  "bot:active_actor_changed": BotActiveActorChangedOutboxPayload
  "bot:resync": BotResyncOutboxPayload
  "label:created": LabelUpsertedOutboxPayload
  "label:updated": LabelUpsertedOutboxPayload
  "label:deleted": LabelDeletedOutboxPayload
  "label:member_joined": LabelMemberJoinedOutboxPayload
  "label:member_left": LabelMemberLeftOutboxPayload
  "label:assigned": LabelAssignedOutboxPayload
  "label:unassigned": LabelUnassignedOutboxPayload
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
  "message:created",
  "message:edited",
  "message:deleted",
  "messages:moved",
  "message:updated",
  "reaction:added",
  "reaction:removed",
  "stream:display_name_updated",
  "stream:member_joined",
  "stream:member_added",
  "stream:member_removed",
  "stream:activity",
  "conversation:created",
  "conversation:updated",
  "conversation:message_assigned",
  "conversation:message_reassigned",
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
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
  | "stream:read_all"
  | "user_preferences:updated"
  | "sidebar_config:updated"
  | "link_preview:dismissed"

const AUTHOR_SCOPED_EVENTS: AuthorScopedEventType[] = [
  "stream:read",
  "stream:read_all",
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
  | "saved:upserted"
  | "saved:deleted"
  | "saved_reminder:fired"
  | "scheduled_message:upserted"
  | "scheduled_message:sent"
  | "scheduled_message:cancelled"

const USER_SCOPED_EVENTS: UserScopedEventType[] = [
  "activity:created",
  "saved:upserted",
  "saved:deleted",
  "saved_reminder:fired",
  "scheduled_message:upserted",
  "scheduled_message:sent",
  "scheduled_message:cancelled",
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

const BOT_SCOPED_EVENTS: BotScopedEventType[] = [
  "bot_invocation:available",
  "bot_invocation:claimed",
  "bot:active_actor_changed",
  "bot:resync",
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
