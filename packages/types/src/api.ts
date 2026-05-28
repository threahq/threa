/**
 * API request/response types.
 *
 * These types define the contracts between frontend and backend.
 */

import type {
  StreamType,
  Visibility,
  CompanionMode,
  SavedStatus,
  AuthorType,
  ScheduledMessageStatus,
} from "./constants"
import type { WorkspaceInvitableRole } from "./workspace-permissions"
import type { ContextBag, ContextIntent } from "./context-bag"
import type { UserId } from "./ids"
import type { JSONContent } from "./prosemirror"
import type {
  AttachmentSummary,
  Stream,
  StreamWithPreview,
  StreamEvent,
  StreamMember,
  Label,
  LabelMember,
  Workspace,
  User,
  WorkspaceInvitation,
  Persona,
  Bot,
} from "./domain"
import type { UserPreferences } from "./preferences"
import type { WorkspacePermissionSlug } from "./workspace-permissions"

// ============================================================================
// Streams API
// ============================================================================

interface CreateStreamInputBase {
  type: StreamType
  displayName?: string
  slug?: string
  description?: string
  visibility?: Visibility
  companionMode?: CompanionMode
  companionPersonaId?: string
  parentStreamId?: string
  parentMessageId?: string
  memberIds?: string[]
  /** Context bag attached to a new scratchpad (triggers summary pre-compute). */
  contextBag?: ContextBag
}

/**
 * Discriminated union on `e2eEnabled` so the compiler enforces that an E2E
 * scratchpad creation carries an owner key id, and a plaintext stream can't
 * smuggle one in. The backend forces `companionMode` off on the E2E branch
 * because Ariadne can't see ciphertext.
 */
export type CreateStreamInput =
  | (CreateStreamInputBase & {
      e2eEnabled: true
      /** Must reference the caller's active, non-revoked UIK. */
      e2eOwnerKeyId: string
    })
  | (CreateStreamInputBase & {
      e2eEnabled?: false
      e2eOwnerKeyId?: never
    })

export interface UpdateStreamInput {
  displayName?: string
  slug?: string
  description?: string
  visibility?: Visibility
  companionMode?: CompanionMode
  companionPersonaId?: string
}

export interface UpdateCompanionModeInput {
  companionMode: CompanionMode
  companionPersonaId?: string | null
}

/**
 * Per-ref source-stream metadata for a context-bag attachment. Lives next
 * to `StreamBootstrap.contextBag` so the timeline can render a message's
 * context-bag chip synchronously from the bootstrap payload — no separate
 * fetch, no layout shift on first render.
 */
export interface StreamContextRefSource {
  streamId: string
  displayName: string | null
  slug: string | null
  type: string
  itemCount: number
}

export interface StreamContextRef {
  kind: "thread"
  streamId: string
  fromMessageId: string | null
  toMessageId: string | null
  /** Cosmetic deep-link anchor; resolver ignores it. See `ContextRef.originMessageId`. */
  originMessageId: string | null
  source: StreamContextRefSource
}

export interface StreamContextBagPayload {
  bag: {
    id: string
    intent: ContextIntent
  } | null
  refs: StreamContextRef[]
}

export interface BotRuntimePresenceSummary {
  botId: string
  runtimeKind: string
  instanceId: string
  displayName: string | null
  status: "available" | "busy" | "offline" | "error"
  acceptingInvocations: boolean
  statusText: string | null
  lastSeenAt: string
}

export interface StreamBootstrap {
  stream: Stream
  events: StreamEvent[]
  members: StreamMember[]
  /** Bot IDs that have been granted access to this stream. */
  botMemberIds: string[]
  botRuntimePresence?: Record<string, BotRuntimePresenceSummary | null>
  /** Complete slash-command list effective for this stream. Live backend returns this. */
  commands?: CommandInfo[]
  membership: StreamMember | null
  latestSequence: string
  /**
   * Server wall-clock (ISO) captured immediately before the bootstrap's
   * parallel queries fire. The frontend uses it as a freshness watermark:
   * any IDB row patched by a socket handler after this instant is preserved
   * over the bootstrap's enrichment values, since the snapshot may have
   * read stale data for that row. Optional for backwards compatibility
   * with cached responses written before this field landed — when missing,
   * the merge path falls through to per-field overlay only.
   */
  snapshotAt?: string
  hasOlderEvents: boolean
  syncMode: "append" | "replace"
  unreadCount: number
  mentionCount: number
  activityCount: number
  /**
   * Hydrated payload for cross-stream share-message pointers, keyed by source
   * message id. Overlaid onto `ThreaSharedMessage` nodes at render time so
   * clients never have to read other streams' messages directly. See
   * docs/plans/message-sharing-streams.md D8.
   */
  sharedMessages?: Record<string, SharedMessageHydration>
  /**
   * Persisted ContextBag attached to this stream (if any). Optional on the
   * type so older bootstrap payloads cached in the workspace store don't
   * fail validation; the live backend always returns it as
   * `{bag: null, refs: []}` for streams without a bag.
   */
  contextBag?: StreamContextBagPayload
}

/**
 * Wire-format variants for an individual pointer's hydrated content.
 *
 * - `ok`: viewer has access; current source content is inlined.
 * - `deleted`: source row exists but is tombstoned.
 * - `missing`: source row never existed (or was hard-deleted in a way that
 *   leaves no tombstone — defended for, shouldn't normally occur).
 * - `private`: viewer has no read access to the source and no share-grant
 *   reaches them. Reveals only the source stream's `kind` + `visibility`,
 *   never the content/author/stream-name. See plan D8.
 * - `truncated`: hydration stopped at `MAX_HYDRATION_DEPTH` for an
 *   accessible chain; viewer can follow `streamId` to read in source.
 */
export type SharedMessageHydration =
  | {
      state: "ok"
      messageId: string
      streamId: string
      authorId: string
      authorType: string
      contentJson: unknown
      contentMarkdown: string
      editedAt: string | null
      createdAt: string
      attachments: AttachmentSummary[]
    }
  | { state: "deleted"; messageId: string; deletedAt: string }
  | { state: "missing"; messageId: string }
  | {
      state: "private"
      messageId: string
      sourceStreamKind: StreamType
      sourceVisibility: Visibility
    }
  | { state: "truncated"; messageId: string; streamId: string }

export interface EventsAroundResponse {
  events: StreamEvent[]
  hasOlder: boolean
  hasNewer: boolean
  sharedMessages?: Record<string, SharedMessageHydration>
}

// ============================================================================
// Messages API
// ============================================================================

/**
 * JSON input format - used by rich clients sending ProseMirror JSON directly.
 */
export interface CreateMessageInputJson {
  streamId: string
  /** ProseMirror JSON content from TipTap editor */
  contentJson: JSONContent
  /** Optional pre-computed markdown (backend derives if missing) */
  contentMarkdown?: string
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
  /**
   * Set to `true` after the user has acknowledged that a share node in
   * `contentJson` would expose its source to people outside the source
   * stream. Required by the backend for shares that cross a privacy
   * boundary; sends without it return 409 + code
   * `SHARE_PRIVACY_CONFIRMATION_REQUIRED`.
   */
  confirmedPrivacyWarning?: boolean
}

export interface CreateDmMessageInputJson {
  dmUserId: string
  /** ProseMirror JSON content from TipTap editor */
  contentJson: JSONContent
  /** Optional pre-computed markdown (backend derives if missing) */
  contentMarkdown?: string
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
  /** Same semantics as `CreateMessageInputJson.confirmedPrivacyWarning`. */
  confirmedPrivacyWarning?: boolean
}

/**
 * Markdown input format - used by AI agents, external integrators, CLI tools.
 */
export interface CreateMessageInputMarkdown {
  streamId: string
  /** Markdown text content */
  content: string
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
}

export interface CreateDmMessageInputMarkdown {
  dmUserId: string
  /** Markdown text content */
  content: string
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
}

/**
 * E2E input format - used by clients sending ciphertext into a stream
 * marked in `e2e_streams`. Backend verifies the stream is E2E (INV-E1)
 * and stores `ciphertext` / `envelope` on the projection while substituting
 * a placeholder for `contentJson` / `contentMarkdown`.
 */
export interface CreateMessageInputE2e {
  streamId: string
  /** Base64-encoded AES-GCM ciphertext from `encryptPayload`. */
  ciphertext: string
  /** Envelope shape returned by `encryptPayload` (recipients + IV + AAD). */
  envelope: unknown
  /** Envelope protocol version — backend rejects unknown values loudly. */
  e2eVersion: number
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
}

/**
 * Union type - API accepts either JSON, Markdown, or E2E ciphertext input.
 * Backend detects format by presence of `contentJson` / `content` /
 * `ciphertext` field and gates each against the stream's E2E flag.
 */
export type CreateMessageInput = CreateMessageInputJson | CreateMessageInputMarkdown | CreateMessageInputE2e
export type CreateDmMessageInput = CreateDmMessageInputJson | CreateDmMessageInputMarkdown

/**
 * JSON input format for updates.
 */
export interface UpdateMessageInputJson {
  contentJson: JSONContent
  contentMarkdown?: string
  /** See `CreateMessageInputJson.confirmedPrivacyWarning`. */
  confirmedPrivacyWarning?: boolean
}

/**
 * Markdown input format for updates.
 */
export interface UpdateMessageInputMarkdown {
  content: string
  /** See `CreateMessageInputJson.confirmedPrivacyWarning`. */
  confirmedPrivacyWarning?: boolean
}

/**
 * Union type - API accepts either JSON or Markdown for updates.
 */
export type UpdateMessageInput = UpdateMessageInputJson | UpdateMessageInputMarkdown

export interface MoveMessagesToThreadInput {
  sourceStreamId: string
  targetMessageId: string
  messageIds: string[]
  leaseKey: string
}

export interface MoveMessagesToThreadResponse {
  sourceStreamId: string
  destinationStreamId: string
  targetMessageId: string
  movedMessageIds: string[]
  thread: Stream
  events: StreamEvent[]
  removedEventIds: string[]
  /** Tombstone event inserted into the source stream that the source-side
   *  client appends to its cache so the move leaves a visible trace. */
  sourceTombstoneEvent: StreamEvent
}

/**
 * Per-message preview embedded in a `messages:moved` stream event payload.
 *
 * Carries enough to render a clickable summary in the move drill-in
 * drawer without an extra fetch. `contentMarkdown` is a capped raw
 * markdown excerpt — preview surfaces are exempt from INV-58 (canonical
 * content lives in `contentJson` on the actual message row); per INV-60
 * they ship as markdown and the frontend strips at render via
 * `stripMarkdownToInline`.
 */
export interface MovedMessagePreview {
  id: string
  authorId: string | null
  authorType: AuthorType | null
  contentMarkdown: string
  createdAt: string
}

/**
 * Payload for a `messages:moved` stream event. One row is inserted in the
 * source stream and one in the destination thread on every move; the
 * renderer collapses each row to "Actor moved N messages" and opens a
 * drill-in drawer when clicked. The same shape serves both sides — the
 * renderer infers role from whether `event.streamId === sourceStreamId`
 * (outbound) vs `=== destinationStreamId` (inbound).
 *
 * `event.actorId` carries the mover's user ID and `event.createdAt`
 * carries the move timestamp, so they aren't duplicated in the payload.
 *
 * Source/destination stream names are embedded so the tombstone can
 * render without an extra round-trip when the linked stream isn't
 * already cached. They're a snapshot — a later rename won't be reflected
 * on existing tombstones, which is acceptable since tombstones are
 * append-only history.
 */
export interface MessagesMovedEventPayload {
  sourceStreamId: string
  sourceStreamSlug: string | null
  sourceStreamDisplayName: string | null
  destinationStreamId: string
  destinationStreamSlug: string | null
  destinationStreamDisplayName: string | null
  /**
   * Per-message previews for the drill-in drawer.
   * `messages.length` is the canonical count.
   */
  messages: MovedMessagePreview[]
}

/**
 * Provenance stamped onto a relocated `message_created` event payload by
 * the move flow. Surfaces a per-message origin badge in the destination
 * timeline without a join. Re-moves overwrite earlier provenance — we
 * surface the most recent origin, not a chain.
 *
 * Source-stream metadata (slug + display name) is snapshotted alongside
 * the IDs so the badge can render the origin name without a separate
 * lookup. Like the tombstone payload, this snapshot is intentional —
 * later renames don't reflect on existing badges.
 */
export interface MovedFromProvenance {
  sourceStreamId: string
  sourceStreamSlug: string | null
  sourceStreamDisplayName: string | null
  movedAt: string
  movedBy: UserId
  /**
   * Author type of `movedBy`. Today the move handler is gated to user
   * actors, so this is always `"user"` — but persisting the type alongside
   * the id avoids silently mislabelling bot/agent movers if the move flow
   * is ever reused.
   */
  movedByType: AuthorType
  /**
   * `event.id` of the destination-side `messages:moved` tombstone. The
   * destination doesn't render the tombstone inline — it shows a small
   * origin badge per message instead — so a per-message context-menu
   * action ("Show move details") looks the tombstone up by id from IDB
   * to populate the drill-in drawer.
   */
  moveTombstoneId: string
}

export interface ValidateMoveMessagesToThreadInput {
  sourceStreamId: string
  targetMessageId: string
  messageIds: string[]
}

export interface ValidateMoveMessagesToThreadResponse {
  leaseKey: string
  expiresAt: string
  destinationStreamId: string | null
  messageCount: number
}

// ============================================================================
// Workspaces API
// ============================================================================

export interface CreateWorkspaceInput {
  name: string
  slug?: string
  region?: string
}

export interface EmojiEntry {
  shortcode: string
  emoji: string
  type: "native" | "custom"
  group: string
  order: number
  /** All shortcodes including aliases (for search matching) */
  aliases: string[]
}

export const CommandKinds = {
  /** Server-executed: dispatched through POST /commands. */
  SERVER: "server",
  /**
   * Client-action: the frontend recognizes the `id` and performs a local
   * action (navigation, mutation) instead of round-tripping to the backend.
   */
  CLIENT_ACTION: "client-action",
  /** Bot-runtime command: dispatched as a targeted bot invocation. */
  BOT_RUNTIME: "bot-runtime",
} as const
export type CommandKind = (typeof CommandKinds)[keyof typeof CommandKinds]

export const CommandScopes = {
  WORKSPACE: "workspace",
  STREAM: "stream",
} as const
export type CommandScope = (typeof CommandScopes)[keyof typeof CommandScopes]

export interface CommandArgumentSuggestion {
  value: string
  label?: string
  description?: string
}

export interface CommandArgumentInfo {
  name: string
  required?: boolean
  description?: string
  suggestions?: CommandArgumentSuggestion[]
}

export interface CommandInfo {
  name: string
  description: string
  /** Omitted for backwards compat = "server" (previous behaviour). */
  kind?: CommandKind
  /** Workspace commands are globally known; stream commands depend on active stream context. */
  scope?: CommandScope
  /** For `kind: "client-action"`, the stable id the frontend dispatches on. */
  clientActionId?: string
  /** Optional first-pass argument metadata. UI can ignore this until argument autocomplete exists. */
  args?: CommandArgumentInfo[]
}

export interface WorkspaceBootstrap {
  workspace: Workspace
  users: User[]
  streams: StreamWithPreview[]
  streamMemberships: StreamMember[]
  dmPeers: Array<{ userId: string; streamId: string }>
  personas: Persona[]
  bots: Bot[]
  emojis: EmojiEntry[]
  emojiWeights: Record<string, number>
  commands: CommandInfo[]
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  activityCounts: Record<string, number>
  unreadActivityCount: number
  mutedStreamIds: string[]
  userPreferences: UserPreferences
  /**
   * Labels visible to the viewer: all of the viewer's own private labels +
   * every public label in the workspace (joined or not — the Discover tab
   * needs un-joined public labels too).
   */
  labels: Label[]
  /**
   * Viewer's `label_members` rows. Private labels are implicitly "joined" by
   * their creator and are NOT represented here — the viewer derives ownership
   * from `Label.creatorUserId` instead.
   */
  labelMemberships: LabelMember[]
  invitations?: WorkspaceInvitation[]
  /**
   * Effective workspace permissions for the viewer. Sourced from the WorkOS
   * session JWT when the rollout is active, with a role-derived fallback for
   * older tokens. Frontend uses this to gate UI affordances.
   */
  viewerPermissions: WorkspacePermissionSlug[]
}

// ============================================================================
// Invitations API
// ============================================================================

export interface PendingInvitation {
  id: string
  workspaceId: string
  workspaceName: string
  expiresAt: string
}

export interface SendInvitationsInput {
  emails: string[]
  role?: WorkspaceInvitableRole
}

export type InvitationSkipReason = "already_user" | "pending_invitation"

export interface SendInvitationsResponse {
  sent: WorkspaceInvitation[]
  skipped: Array<{ email: string; reason: InvitationSkipReason }>
}

// Link-based invitations

export interface CreateInvitationLinkInput {
  role: WorkspaceInvitableRole
  /** Admin-only memo, e.g. "for Simon — sent via Signal". Optional. */
  note?: string
}

export interface CreateInvitationLinkResponse {
  invitation: WorkspaceInvitation
  /** The plaintext claim token. Returned exactly once at create time; never retrievable again. */
  token: string
}

export interface InvitationLinkLookupResponse {
  workspaceName: string
  expiresAt: string
}

export interface ClaimInvitationLinkInput {
  token: string
  email: string
}

export interface ClaimInvitationLinkResponse {
  ok: true
  /** Set when the email already belongs to a workspace member; frontend can deep-link to login. */
  alreadyMember?: { workspaceId: string }
}

export interface CompleteUserSetupInput {
  name?: string
  slug?: string
  timezone: string
  locale: string
}

// ============================================================================
// Activity API
// ============================================================================

/** Wire format for activity items (dates as ISO strings) */
export interface Activity {
  id: string
  workspaceId: string
  userId: string
  activityType: string
  streamId: string
  messageId: string
  actorId: string
  actorType: string
  context: Record<string, unknown>
  readAt: string | null
  createdAt: string
  /**
   * True when this row represents the user's own action (e.g. a message they
   * sent or a reaction they added). Self rows appear in the feed but must not
   * inflate unread counts or trigger push notifications.
   */
  isSelf: boolean
  /** Populated for reaction activities; null otherwise. */
  emoji: string | null
}

/** Socket event payload for activity:created */
export interface ActivityCreatedPayload {
  workspaceId: string
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
    isSelf: boolean
  }
}

// ============================================================================
// Read State API
// ============================================================================

export interface MarkAsReadInput {
  lastEventId: string
}

export interface MarkAsReadResponse {
  membership: StreamMember
}

export interface MarkAllAsReadResponse {
  updatedStreamIds: string[]
}

// ============================================================================
// Commands API
// ============================================================================

export interface DispatchCommandInput {
  command: string
  streamId: string
}

export interface DispatchCommandResponse {
  success: true
  commandId: string
  command: string
  args: string
  event: StreamEvent
}

export interface DispatchCommandError {
  success: false
  error: string
  availableCommands?: string[]
}

export interface CommandDispatchedPayload {
  commandId: string
  name: string
  args: string
  status: "dispatched"
  /** Missing means legacy server command. */
  executionKind?: Extract<CommandKind, "server" | "bot-runtime">
}

export interface CommandCompletedPayload {
  commandId: string
  result?: unknown
}

export interface CommandFailedPayload {
  commandId: string
  error: string
}

// ============================================================================
// AI Usage API
// ============================================================================

export interface AIUsageSummary {
  totalCostUsd: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  recordCount: number
}

export type AIUsageOrigin = "system" | "user"

export interface AIUsageByOrigin {
  origin: AIUsageOrigin
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

export interface AIUsageByUser {
  userId: string | null
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

export interface AIUsageRecord {
  id: string
  functionId: string
  model: string
  provider: string
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  costUsd: number
  userId: string | null
  sessionId: string | null
  createdAt: string
}

export interface AIUsageResponse {
  period: {
    start: string
    end: string
  }
  total: AIUsageSummary
  byOrigin: AIUsageByOrigin[]
  byUser: AIUsageByUser[]
}

export interface AIRecentUsageResponse {
  records: AIUsageRecord[]
}

export interface AIBudgetConfig {
  monthlyBudgetUsd: number
  alertThreshold50: boolean
  alertThreshold80: boolean
  alertThreshold100: boolean
  degradationEnabled: boolean
  hardLimitEnabled: boolean
  hardLimitPercent: number
}

export interface AIBudgetResponse {
  budget: AIBudgetConfig | null
  currentUsage: AIUsageSummary
  percentUsed: number
  nextReset: string
}

export interface UpdateAIBudgetInput {
  monthlyBudgetUsd?: number
  alertThreshold50?: boolean
  alertThreshold80?: boolean
  alertThreshold100?: boolean
  degradationEnabled?: boolean
  hardLimitEnabled?: boolean
  hardLimitPercent?: number
}

// ============================================================================
// Push Notifications API
// ============================================================================

/**
 * Length of the hex-encoded device key prefix used to correlate push subscriptions with sessions.
 *
 * Algorithm contract (must match in both frontend and backend implementations):
 *   1. Input: navigator.userAgent string
 *   2. Hash: SHA-256
 *   3. Encode: hex
 *   4. Slice: first DEVICE_KEY_LENGTH characters
 *
 * Implementations: frontend `getDeviceKey` (use-push-notifications.ts), backend `deriveDeviceKey` (socket.ts).
 */
export const DEVICE_KEY_LENGTH = 16

// ============================================================================
// Saved Messages API
// ============================================================================

/**
 * Wire shape for a saved-message row. Absolute timestamps are ISO strings; the
 * live-resolved message snapshot is null when the underlying message has been
 * deleted or the owner has lost access to the stream.
 */
export interface SavedMessageView {
  id: string
  workspaceId: string
  userId: string
  messageId: string
  streamId: string
  status: SavedStatus
  remindAt: string | null
  reminderSentAt: string | null
  savedAt: string
  statusChangedAt: string
  message: SavedMessageSnapshot | null
  unavailableReason: "deleted" | "access_lost" | null
}

export interface SavedMessageSnapshot {
  authorId: string
  authorType: AuthorType
  contentJson: JSONContent
  contentMarkdown: string
  createdAt: string
  editedAt: string | null
  streamName: string | null
}

export interface SaveMessageInput {
  messageId: string
  remindAt?: string | null
}

export interface UpdateSavedMessageInput {
  status?: SavedStatus
  remindAt?: string | null
}

export interface SavedMessageListResponse {
  saved: SavedMessageView[]
  nextCursor: string | null
}

/** Wire payload broadcast on `saved:upserted` socket events. */
export interface SavedUpsertedPayload {
  workspaceId: string
  targetUserId: string
  saved: SavedMessageView
}

/** Wire payload broadcast on `saved:deleted` socket events. */
export interface SavedDeletedPayload {
  workspaceId: string
  targetUserId: string
  savedId: string
  messageId: string
}

/** Wire payload broadcast on `saved_reminder:fired` socket events. */
export interface SavedReminderFiredPayload {
  workspaceId: string
  targetUserId: string
  savedId: string
  messageId: string
  streamId: string
  saved: SavedMessageView
}

// ============================================================================
// Scheduled Messages API
// ============================================================================

/**
 * Wire shape for a scheduled-message row. Mirrors the table columns minus the
 * lock fields the user doesn't care about; lock state is exposed only on the
 * `/claim` response.
 */
export interface ScheduledMessageView {
  id: string
  workspaceId: string
  userId: string
  streamId: string
  parentMessageId: string | null
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds: string[]
  metadata: Record<string, string> | null
  scheduledFor: string
  status: ScheduledMessageStatus
  sentMessageId: string | null
  lastError: string | null
  /**
   * Worker fence — the worker won't fire while this is in the future. Bumped
   * by `claim` / heartbeat. Anonymous: any editor session keeps the worker
   * out; first save still wins via the `updatedAt` optimistic CAS, not via
   * this fence. ISO string; null when no editor session is active.
   */
  editActiveUntil: string | null
  /**
   * Idempotency key the original `POST /scheduled` carried. Echoed back so
   * the frontend can match a server-issued row against an optimistic
   * placeholder waiting in IDB and swap them in one transaction.
   */
  clientMessageId: string | null
  /**
   * Optimistic-concurrency version. Starts at 1; every state-changing
   * server-side UPDATE increments it. The client sends this back as
   * `expectedVersion` on PATCH; mismatch → 409 STALE_VERSION.
   */
  version: number
  createdAt: string
  updatedAt: string
  statusChangedAt: string
}

export interface ScheduleMessageInput {
  streamId: string
  parentMessageId?: string | null
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds?: string[]
  metadata?: Record<string, string>
  scheduledFor: string
  /** Idempotency key for optimistic create retries (mirrors message create). */
  clientMessageId?: string
}

/**
 * Optimistic-concurrency update payload. The client sends `expectedVersion`
 * — the `version` integer it last saw on the row — and the server CAS rejects
 * with 409 STALE_VERSION when the row has moved on (someone else saved, the
 * worker fired, etc). Any number of editors can coexist; first save wins.
 */
export interface UpdateScheduledMessageInput {
  contentJson?: JSONContent
  contentMarkdown?: string
  attachmentIds?: string[]
  metadata?: Record<string, string> | null
  scheduledFor?: string
  /** Row's `version` integer at the time the editor opened. */
  expectedVersion: number
}

/**
 * Response from `POST /scheduled/:id/lock`. The caller pauses the worker
 * from sending while the user has the edit dialog open. Anonymous fence —
 * no per-device owner, multiple devices/tabs can hold it concurrently.
 *
 * Echoes the current row so the dialog can refresh `expectedVersion` from
 * an authoritative source, even when the IDB-cached row that triggered
 * the open was stale (e.g. created before the version migration shipped).
 */
export interface LockScheduledMessageResponse {
  scheduled: ScheduledMessageView
  /** ISO of when the worker fence expires. Generous TTL; no heartbeat. */
  editActiveUntil: string
}

export interface ScheduledMessageListResponse {
  scheduled: ScheduledMessageView[]
  nextCursor: string | null
}

/** Wire payload broadcast on `scheduled_message:upserted` socket events. */
export interface ScheduledMessageUpsertedPayload {
  workspaceId: string
  targetUserId: string
  scheduled: ScheduledMessageView
}

/** Wire payload broadcast on `scheduled_message:sent` socket events. */
export interface ScheduledMessageSentPayload {
  workspaceId: string
  targetUserId: string
  scheduledId: string
  sentMessageId: string
  streamId: string
  scheduled: ScheduledMessageView
}

/** Wire payload broadcast on `scheduled_message:cancelled` socket events. */
export interface ScheduledMessageCancelledPayload {
  workspaceId: string
  targetUserId: string
  scheduledId: string
}

// ============================================================================
// Labels API
// ============================================================================

/**
 * Wire body for `POST /labels`. Slug is server-derived from `name` (validated
 * for uniqueness via partial unique indexes scoped to visibility); `color` is
 * required so frontend doesn't have to invent defaults for new public labels
 * other workspace users will see.
 */
export interface CreateLabelInput {
  name: string
  visibility: Visibility
  color: string
  emoji?: string | null
  description?: string | null
}

/** Wire body for `PATCH /labels/:labelId`. All fields optional. */
export interface UpdateLabelInput {
  name?: string
  color?: string
  emoji?: string | null
  description?: string | null
}

/**
 * Wire payload for `label:created` / `label:updated`. Visibility tells the
 * dispatcher how to scope routing (private → creator only, public → workspace).
 */
export interface LabelUpsertedPayload {
  workspaceId: string
  /** Set when private — the creator who should receive this event. */
  targetUserId: string | null
  label: Label
}

/** Wire payload for `label:deleted` (soft-archive). */
export interface LabelDeletedPayload {
  workspaceId: string
  targetUserId: string | null
  labelId: string
}

/**
 * Wire payload for `label:member_joined`. Delivered to the affected member only
 * (`targetUserId`), matching the viewer-scoped memberships shipped in bootstrap.
 */
export interface LabelMemberJoinedPayload {
  workspaceId: string
  targetUserId: string
  member: LabelMember
}

/**
 * Wire payload for `label:member_left`. The membership row is gone, so only the
 * identity is carried. Delivered to the affected member only (`targetUserId`).
 */
export interface LabelMemberLeftPayload {
  workspaceId: string
  targetUserId: string
  labelId: string
  userId: string
}
