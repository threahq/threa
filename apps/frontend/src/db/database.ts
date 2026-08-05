import Dexie, { type EntityTable, type PromiseExtended, type Table } from "dexie"
import type {
  Activity,
  AuthorType,
  BoardPost,
  BoardPostMessage,
  CompanionMode,
  ConversationDirective,
  E2eActor,
  EventType,
  ComposeTrace,
  FeatureFlagLayers,
  JSONContent,
  NotificationLevel,
  SidebarConfig,
  Slot,
  StreamContextBagPayload,
  StreamContextItem,
  StreamPurpose,
  StreamType,
  ThreaDocument,
  TitleSource,
  ToolPrivacyCategory,
  ToolPrivacyPolicy,
  WorkspaceRoleSlug,
} from "@threa/types"
import type { KdfParams } from "@/lib/crypto/passphrase"
import type { DraftContextRef } from "@/lib/context-bag/types"

const WORKSPACE_USERS_STORE = "workspaceUsers"
const LEGACY_WORKSPACE_USERS_STORE = "workspaceMembers"

export interface CachedWorkspace {
  id: string
  name: string
  slug: string
  createdAt: string
  updatedAt: string
  _cachedAt: number
}

export interface CachedWorkspaceUser {
  id: string // workspace user ID (legacy prefix: member_xxx)
  workspaceId: string
  workosUserId: string
  email: string
  role: WorkspaceRoleSlug
  slug: string
  name: string
  description: string | null
  avatarUrl: string | null
  timezone: string | null
  locale: string | null
  pronouns: string | null
  phone: string | null
  githubUsername: string | null
  // Cosmetic status. Structurally mirrors the wire `User` (this cache type is
  // assigned to `User` across the app). Rows cached before this feature lack
  // the columns at runtime (undefined); a bootstrap refetch backfills them, and
  // all readers normalize with `?? null`. Not indexed, so no schema bump.
  statusEmoji: string | null
  statusText: string | null
  statusExpiresAt: string | null
  // Do-not-disturb. Same caching note as the status fields above: rows cached
  // before the feature lack these at runtime; readers normalize with `?? null`
  // / `?? false`, and a bootstrap refetch backfills them.
  statusPausesNotifications: boolean
  notificationsPausedUntil: string | null
  notificationsPausedIndefinitely: boolean
  setupCompleted: boolean
  joinedAt: string
  _cachedAt: number
}

export interface CachedStream {
  id: string
  workspaceId: string
  type: StreamType
  displayName: string | null
  /** Title provenance/revision survive IDB so regeneration visibility and CAS merges are stable across reloads. */
  displayNameSource?: TitleSource | null
  displayNameRevision?: number
  displayNameUpdatedByUserId?: string | null
  slug: string | null
  description: string | null
  /**
   * Canonical rich-text description (ProseMirror). The editor seeds from this;
   * `description` markdown is only the wire/integrator projection + a legacy
   * fallback (rows cached before this field existed leave it undefined).
   */
  descriptionJson?: ThreaDocument | null
  visibility: "public" | "private"
  parentStreamId: string | null
  /**
   * Canonical id of the timeline item a thread anchors on: `msg_…` (message) or
   * `event_…` (card). The one anchor track (INV-2 prefix discriminates). Absent on
   * rows cached before this shipped — fall back to `parentMessageId`.
   */
  parentAnchorId?: string | null
  /**
   * Legacy message anchor. New writes no longer set it — but IDB rows persisted by
   * a PREVIOUS bundle still carry only this, and IDB survives deploys
   * indefinitely, so the cached-row read path keeps it as a fallback. Optional so
   * fresh writes omit it.
   */
  parentMessageId?: string | null
  rootStreamId: string | null
  /**
   * Live reply count on a thread stream (0 for non-threads). Absent on rows cached
   * before this shipped — treat missing as 0.
   */
  replyCount?: number
  /** Timestamp of the thread's most recent non-deleted reply, or null when none. */
  lastReplyAt?: string | null
  companionMode: "off" | "on"
  companionPersonaId: string | null
  memoryMode?: "auto" | "off"
  /**
   * System-purpose marker (e.g. "persona_test"). Listing surfaces filter these
   * via `isUtilityStream`; optional so older cached rows still parse.
   */
  purpose?: StreamPurpose | null
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  // Sidebar preview (from workspace bootstrap StreamWithPreview)
  lastMessagePreview?: { authorId: string; authorType: AuthorType; content: string; createdAt: string } | null
  // User-specific state (from membership)
  notificationLevel?: string | null
  /**
   * Persisted ContextBag attached to this stream. Mirrored into IDB by
   * `applyStreamBootstrap` so the timeline message-context badge can render
   * synchronously on first paint — no fetch, no layout shift. Always present
   * shape-wise (`{bag: null, refs: []}` for streams without an attached bag);
   * optional on the type so older cached records still parse.
   */
  contextBag?: StreamContextBagPayload
  /**
   * End-to-end encryption markers. Present iff this stream is in
   * `e2e_streams`. Drives the send-path encrypt branch and the inbound
   * decrypt branch. Both fields stay optional so existing cached rows from
   * older versions still parse — plaintext streams simply leave them
   * undefined.
   */
  e2eEnabled?: boolean
  e2eOwnerKeyId?: string | null
  /**
   * Non-human actors the owner invited into this E2E scratchpad. Optional so
   * older cached rows still parse; treated as an empty set when absent.
   */
  e2eActors?: E2eActor[]
  /**
   * The stream's display name sealed under the SSK (base64 ciphertext + its
   * `StreamEnvelope` framing). Persisting *ciphertext* at rest is safe — it
   * mirrors how message bodies keep ciphertext in `db.events.payload` and
   * decrypt only in memory. An unlocked client decrypts this and prefers it
   * over the plaintext `displayName`; the decrypted plaintext is held only in
   * the memory-only `stream-name-cache` and is never written back to IDB.
   * Both null until the stream is renamed (or auto-titled) while E2E.
   */
  sealedNameCiphertext?: string | null
  sealedNameEnvelope?: unknown | null
  _cachedAt: number
}

/**
 * Stream participation only — membership carries no read state. The read
 * frontier lives in {@link CachedStreamReadState} (membership ≠ access ≠ read
 * state). Old rows cached before the watermark fields were dropped may still
 * carry them; readers ignore them.
 */
export interface CachedStreamMembership {
  /** Composite key: `${workspaceId}:${streamId}` */
  id: string
  workspaceId: string
  streamId: string
  memberId: string
  notificationLevel: NotificationLevel | null
  joinedAt: string
  _cachedAt: number
}

export interface CachedDmPeer {
  /** Composite key: `${workspaceId}:${streamId}` */
  id: string
  workspaceId: string
  userId: string
  streamId: string
  _cachedAt: number
}

/**
 * The per-user read frontier — the sole read source (sourced from
 * `stream_read_state`). Row PRESENCE is authoritative: a null `lastReadEventId`
 * is an explicit "position before the first message" frontier, distinct from an
 * ABSENT row (never read). Seeded from the bootstrap's `streamReadState` map and
 * kept current by the read socket appliers. User-local: the database itself is
 * per account (`accountDbName`).
 */
export interface CachedStreamReadState {
  /** Composite key: `${workspaceId}:${streamId}` */
  id: string
  workspaceId: string
  streamId: string
  lastReadEventId: string | null
  lastReadSequence: string | null
  lastReadAt: string | null
  _cachedAt: number
}

export interface CachedEvent {
  id: string
  workspaceId: string
  streamId: string
  sequence: string // bigint as string
  /** Numeric mirror of sequence for IDB index ordering (string indexes sort lexicographically). */
  _sequenceNum: number
  /**
   * Dense per-stream position over viewer-visible timeline rows (INV-61),
   * mirrored from the wire. `null` for non-broadcast event types (own command
   * events, patch-style rows), `undefined` for rows cached before the field
   * existed — both are simply skipped by the contiguity chain.
   */
  broadcastSequence?: string | null
  eventType: EventType
  payload: unknown
  actorId: string | null
  actorType: AuthorType | null
  createdAt: string
  // Optimistic sending state (for message_created events)
  _clientId?: string
  _status?: "pending" | "sent" | "failed" | "editing"
  /** Persisted stream sequence visible when this optimistic row was created. */
  _anchorSequenceNum?: number
  _cachedAt: number
  /**
   * Client wall-clock (ms) of the most recent socket-driven payload patch
   * applied to this row by `updateMessageEvent`. Compared against the
   * bootstrap response's `snapshotAt` so a freshly-arrived patch (e.g. a
   * reaction added between the backend's snapshot and the client's apply)
   * isn't clobbered by a stale enrichment value carried in the bootstrap
   * payload. Distinct from `_cachedAt`, which is bumped on bootstrap apply
   * too — `_patchedAt` is bumped only by socket-handler patches.
   */
  _patchedAt?: number
}

/**
 * Convert a sequence string to a number for IDB indexing.
 * Sequences fit well within Number.MAX_SAFE_INTEGER for practical use.
 */
export function sequenceToNum(sequence: string): number {
  return Number(sequence)
}

/**
 * Generate a client-side draft id. Mirrors the backend `draft_` ULID prefix so
 * the same id can stand in until (Stage 3) the server confirms it. Lives here,
 * at the data layer, so both the Dexie upgrade and the draft hooks mint ids the
 * same way without the hooks→db layering inverting.
 */
export function generateLocalDraftId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `draft_${timestamp}${random}`
}

export interface CachedBot {
  id: string
  workspaceId: string
  type: "shared" | "personal"
  ownerUserId: string | null
  traits: string[]
  slug: string | null
  name: string
  description: string | null
  avatarEmoji: string | null
  avatarUrl: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  _cachedAt: number
}

export interface CachedPersona {
  id: string
  workspaceId: string | null
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  /** Base path of an uploaded custom-persona avatar image, or null (built-ins never carry one). */
  avatarUrl: string | null
  systemPrompt: string | null
  model: string
  temperature: number | null
  maxTokens: number | null
  enabledTools: string[] | null
  managedBy: "system" | "workspace" | "user"
  /**
   * Owning user for a personal (`managedBy: "user"`) persona; null otherwise. A
   * personal persona is visible only to its owner — the server already scopes
   * bootstrap/sync rows, so this rides along for kind/section placement
   * (user-scoped-personas).
   */
  ownerUserId: string | null
  status: "pending" | "active" | "disabled" | "archived"
  createdAt: string
  updatedAt: string
  _cachedAt: number
}

export interface PendingStreamCreation {
  type: StreamType
  displayName?: string
  companionMode?: CompanionMode
  /** Companion persona chosen on the draft; threaded into the create request. */
  companionPersonaId?: string
  parentStreamId?: string
  /** Canonical anchor id a thread draft is created on (`msg_…` or `event_…`). New
   *  writes set this; consumers read `parentAnchorId ?? parentMessageId`. */
  parentAnchorId?: string
  /** Legacy message anchor. Grace period only: ops enqueued by a previous bundle
   *  are persisted in IDB and carry this instead of `parentAnchorId`; keep reading
   *  it as a fallback until those drain. New writes leave it unset. */
  parentMessageId?: string
  /** At-creation tool policy carried from the draft; threaded into the create request. */
  allowedToolCategories?: ToolPrivacyPolicy
}

export interface PendingMessage {
  clientId: string // ULID generated client-side
  workspaceId: string
  streamId: string
  content: string
  contentFormat: "markdown" | "plaintext"
  /** ProseMirror JSON content for sending to the API */
  contentJson?: JSONContent
  /** Attachment IDs to include with the message */
  attachmentIds?: string[]
  /** Persist this message and dispatch `/steer` atomically on the server. */
  steer?: true
  createdAt: number // timestamp for ordering
  retryCount: number
  /** Timestamp before which this message should not be retried (exponential backoff) */
  retryAfter?: number
  /**
   * Queue-side status flags that gate retry behavior:
   * - `editing` — user is actively editing the message in the composer; the
   *   drain loop skips this entry until the user either sends or cancels.
   * - `blocked-privacy` — backend rejected with
   *   `SHARE_PRIVACY_CONFIRMATION_REQUIRED` on a share that crosses a
   *   privacy boundary. Not auto-retried — surfaces a toast so the user
   *   explicitly confirms or aborts. On confirm the toast clears
   *   `status` and sets `confirmedPrivacyWarning: true`.
   */
  status?: "editing" | "blocked-privacy"
  /** Permanent rejection: keep the failed row for manual Retry, but do not auto-replay it. */
  terminalFailure?: boolean
  /** Original queue state before entering editing mode; used to cancel stale edits on startup. */
  preEditStatus?: "pending" | "failed"
  /**
   * Set by the privacy-confirm toast after the user clicks "Share anyway".
   * Forwarded as `confirmedPrivacyWarning` on the next send attempt so the
   * backend's privacy-boundary check passes through to the share insert.
   */
  confirmedPrivacyWarning?: boolean
  /** When set, the queue creates this stream before sending the message */
  streamCreation?: PendingStreamCreation
  /**
   * Conversation directive forwarded on send so a board reply attaches to the
   * declared conversation synchronously (see {@link ConversationDirective}).
   * Omitted on ordinary stream sends, which let the async extractor infer.
   */
  conversation?: ConversationDirective
  /**
   * Compose-session provenance captured while the author wrote this message
   * (see {@link ComposeTrace}). Rides the durable queue row so a send that only
   * reaches the server after a reload still carries the horizon it was composed
   * against. Absent unless the workspace's `composeTraces` flag is on.
   */
  composeTrace?: ComposeTrace
  /** The draft ID to clean up after successful stream creation + message send */
  draftId?: string
  /** Set by the queue after stream creation succeeds — prevents duplicate creation on retry */
  promotedStreamId?: string
  /**
   * End-to-end-encrypted send payload. Populated at queue time (with the
   * sender's UIK held in memory) so the drain loop stays stateless about
   * user identity / private keys — it just forwards the precomputed
   * ciphertext + envelope on the E2E API variant. `contentMarkdown` /
   * `contentJson` still carry the original plaintext for the local
   * optimistic event so the user sees what they typed.
   */
  ciphertext?: string
  envelope?: unknown
  e2eVersion?: number
}

/**
 * A reserved background upload's durable job: the file bytes plus enough
 * metadata to resume the transfer after a reload or app reopen. Written when
 * the reservation lands (there is nothing durable to resume before an id
 * exists), deleted when the upload settles or is cancelled. For E2E streams
 * `blob` is ciphertext — plaintext never rests in IDB (E2EE-4); the real
 * filename/mime here are display metadata the composer chip needs.
 */
export interface CachedUploadJob {
  attachmentId: string
  workspaceId: string
  filename: string
  mimeType: string
  sizeBytes: number
  e2e: boolean
  blob: Blob
  status: "pending" | "failed"
  error?: string
  /** Network-class failure — the online auto-heal may retry it. Unindexed. */
  retryable?: boolean
  createdAt: number
}

/**
 * Generic offline operation queue for non-message writes (edits, deletes, reactions).
 * Operations are retried when back online, similar to PendingMessage for sends.
 */
export interface PendingOperation {
  id: string // ULID
  workspaceId: string
  type:
    | "edit_message"
    | "delete_message"
    | "add_reaction"
    | "remove_reaction"
    // Scheduled-message ops follow the offline-first pattern (mirrors
    // sendMessage's pendingMessages queue): the UI writes to IDB
    // immediately and the operation queue replays the API call when online.
    | "schedule_message"
    | "update_scheduled_message"
    | "cancel_scheduled_message"
    | "send_scheduled_now"
    | "dispatch_command"
    // Centralized-draft sync: mirror a local draft to the backend `drafts`
    // table. All retry silently with no error surface — a failed remote draft
    // save is invisible by design because the local copy stands. `upsert_draft`
    // reads the draft's current content fresh at drain time and pushes it with
    // `expectedVersion = baseVersion`; the server splits on a version mismatch.
    // `resolve_draft` (Stage 4) is the CAS clear-on-send: it removes the server
    // row only if `expectedVersion` still matches, so a drifted copy survives.
    // `delete_draft` is an unconditional, idempotent soft delete (the local row
    // is already gone before the op is enqueued).
    | "upsert_draft"
    | "resolve_draft"
    | "delete_draft"
  payload: Record<string, unknown>
  createdAt: number
  retryCount: number
  retryAfter?: number
  /**
   * Set by the queue right before the op's first execution attempt. An op that
   * ever started may have reached the server even if its result was lost, so a
   * coalescing replace must carry its idempotency lineage forward (see
   * `enqueueDraftUpsert`); an op that never started can be reused in place.
   */
  startedAt?: number
}

export interface SyncCursor {
  key: string // e.g., "workspace:xxx:streams" or "stream:xxx:events"
  cursor: string // Last synced ID/sequence
  updatedAt: number
}

export interface DraftScratchpad {
  id: string // draft_xxx format
  workspaceId: string
  displayName: string | null
  companionMode: "off" | "on"
  /**
   * Tool-privacy policy chosen before the scratchpad is server-created.
   * `undefined` = unrestricted; threaded into the create request when the
   * first message promotes the draft. Drafts are always plaintext, so the
   * enclave "not yet" gating never applies here.
   */
  allowedToolCategories?: ToolPrivacyPolicy
  /**
   * Companion persona chosen before the scratchpad is server-created.
   * `undefined` = default (Ariadne); threaded into the create request when the
   * first message promotes the draft.
   */
  companionPersonaId?: string
  createdAt: number
}

/**
 * Attachment info stored in drafts. Subset of full Attachment - just display fields.
 */
export interface DraftAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

/**
 * A single composer payload — the unit that (from Stage 3 on) mirrors to the
 * backend `drafts` table. Folds the former `DraftMessage` (one ambient
 * auto-save per scope) and `StashedDraft` (many explicit saves per scope) into
 * one entity: every draft is a first-class row keyed by its own `draft_` id,
 * and a scope may hold any number of them. Which one (if any) is currently
 * checked out into the composer is tracked separately, and device-locally, by
 * `ComposerLoaded` — "loaded" is never a property of the draft itself.
 */
export interface CachedDraft {
  /** "draft_" prefixed id; client-generated until the first server confirm. */
  id: string
  workspaceId: string
  /** "stream:{streamId}" or "thread:{parentMessageId}". */
  scope: string
  /** ProseMirror JSON content */
  contentJson: JSONContent
  /** Attachments that have been uploaded and are ready to attach to the message */
  attachments: DraftAttachment[]
  /** Context refs attached to this draft (populated by "Discuss with Ariadne"). */
  contextRefs?: DraftContextRef[]
  /** Authoring-device clock (ms); drives recency ordering. */
  clientUpdatedAt: number
  /**
   * Server attachment ids for this draft (Stage 3 sync). The wire `Draft`
   * carries only attachment ids, not the `DraftAttachment` display metadata
   * (filename/mime/size), so a draft arriving from another device keeps its ids
   * here even when this device has no local `attachments` metadata for them —
   * preserving the references across a round-trip so a later edit-push from this
   * device never wipes them server-side. When this device authored the draft,
   * `attachments` is the source of truth and `attachmentIds` mirrors its ids.
   * Absent on rows written before Stage 3 (derive from `attachments` on push).
   */
  attachmentIds?: string[]
  /**
   * Last server-confirmed optimistic-lock version (Stage 3 sync). Sent as
   * `expectedVersion` on the next push; the server increments it on accept and
   * SPLITS on mismatch. Absent / `undefined` on a draft this client has never
   * pushed (treated as 0 → the first push inserts at version 1, or splits if the
   * id already exists server-side). Never decreases — a stale socket echo whose
   * version is `<= baseVersion` is ignored.
   */
  baseVersion?: number
  /**
   * E2E variant (Stage 4c). When present, this draft belongs to an encrypted
   * stream and `ciphertext` is the draft body sealed to the stream's SSK; the
   * plaintext `contentJson` at rest is the empty placeholder (no plaintext on
   * disk, E2EE-4) and the composer decrypts `ciphertext` into memory on load.
   * Absent on plaintext drafts. `envelope` carries the framing the open path
   * needs (key generation, IV, AAD); `e2eVersion` is the seal scheme version.
   */
  ciphertext?: string
  envelope?: unknown
  e2eVersion?: number
}

/**
 * Device-local pointer: which draft (if any) is checked out into the composer
 * for a scope. Persisted so a reload restores it, but never synced — a fresh
 * device opens the composer empty and the user picks a draft from the stash to
 * load it. One row per scope; `workspaceId` is carried for workspace-scoped
 * cache seeding, not because the pointer is shared.
 */
export interface ComposerLoaded {
  /** Primary key: "stream:{streamId}" or "thread:{parentMessageId}". */
  scope: string
  workspaceId: string
  draftId: string | null
}

/**
 * Device-local pointer: which draft scope a composer HOST currently points at.
 * `stream:<S>` (the timeline composer for stream S) → `board:reply:<C>` when the
 * user armed "Reply in conversation" there. Absent means the host composes its
 * own scope. Like `ComposerLoaded` this is device-local and never synced, and it
 * is deliberately NOT cleared on logout (see `clearAllCachedData`) — the arm is
 * part of the in-progress work the drafts themselves survive with.
 */
export interface ComposerTarget {
  /** Primary key: the host composer's own scope, e.g. "stream:{streamId}". */
  host: string
  workspaceId: string
  /** The draft scope this host composes into instead of `host`. */
  scope: string
}

export interface CachedUnreadState {
  id: string // workspaceId
  workspaceId: string
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  activityCounts: Record<string, number>
  unreadActivityCount: number
  /**
   * Held set of the viewer's unread activity rows — the source of truth the
   * badge/glow counts derive from. Optional because rows cached before the field
   * shipped lack it; readers normalize with `?? []`. See sync/unread-counters.ts.
   */
  unreadActivities?: Activity[]
  /**
   * Latest message ordinal per stream (sync phase 2c) — seeded from
   * bootstrap `messageCounts`, max-merged from `stream:activity`. The read
   * position is implicit: latestOrdinals[s] − unreadCounts[s]. Absent for
   * rows cached before the field shipped; see sync/unread-counters.ts.
   */
  latestOrdinals?: Record<string, number>
  /**
   * Sparse read overlay per stream (docs/sparse-read-overlay-design.md): message
   * ids read individually above each stream's watermark. Rides this singleton
   * row (no index). Effective unread stays `latestOrdinals[s] − read(s) −
   * |readMessageIds[s]|`. Absent for rows cached before the field shipped;
   * readers normalize with `?.`. See sync/unread-counters.ts.
   */
  readMessageIds?: Record<string, string[]>
  mutedStreamIds: string[]
  /**
   * Per-stream timestamp of the last local counter write (stamped by
   * `putCountersIdb` via `diffCounterStreams`, plus the optimistic read paths).
   * Bootstrap merges are per-stream: the server snapshot wins except for
   * streams touched during the fetch window (`mergeBootstrapUnreadFields`).
   * Pruned to the fetch window on every bootstrap. Absent for rows cached
   * before the field shipped.
   */
  counterTouchedAt?: Record<string, number>
  /**
   * Mute-membership sibling of `counterTouchedAt`, stamped by the
   * notification-level handler. Separate so a mute-only toggle doesn't make
   * the bootstrap merge prefer that stream's possibly-stale local counters.
   */
  mutedTouchedAt?: Record<string, number>
  _cachedAt: number
}

export interface CachedUserPreferences {
  id: string // workspaceId
  workspaceId: string
  userId: string
  theme: string
  sendMode: string
  [key: string]: unknown
  _cachedAt: number
}

export interface CachedSidebarConfig {
  id: string // workspaceId
  workspaceId: string
  config: SidebarConfig
  _cachedAt: number
}

/**
 * Persisted UI toggle state for a single collapsible markdown block inside
 * a message (code block, blockquote, or quote reply). Scoped per message so
 * collapsed/expanded state survives reloads.
 * Key format: `${messageId}:${kind}:${contentHash}` — see
 * `composeBlockCollapseKey` in `lib/markdown/markdown-block-context`.
 */
export interface CachedMarkdownBlockCollapse {
  id: string
  messageId: string
  /** Block kind — lets us clear collapse state scoped to a block type. Mirrors
   * `MarkdownBlockKind` (kept as a literal here to keep the db layer dependency-free). */
  kind: "code" | "blockquote" | "quote-reply" | "description" | "message" | "board-card"
  collapsed: boolean
  updatedAt: number
}

/**
 * Persisted per-user "Show more" state for a single link preview card.
 * By default every card clamps its body to a fixed height so mixed-content
 * messages line up; when a preview's natural content overflows the clamp,
 * users can expand it. That expanded/collapsed choice is persisted here so
 * it survives reloads without bleeding across messages.
 * Key format: `${messageId}:${previewId}`.
 */
export interface CachedLinkPreviewCollapse {
  id: string
  messageId: string
  previewId: string
  expanded: boolean
  updatedAt: number
}

/**
 * Cached saved-message row. Mirrors `SavedMessageView` on the wire — absolute
 * timestamps are ISO strings (same as the API payload) so socket handlers
 * can write straight through without re-serialising. `message` is the live
 * snapshot from the last sync; the service always resolves content live
 * server-side, so stale content here means the record was cached before
 * the latest edit — visible state is corrected on the next list fetch or
 * socket event.
 */
export interface CachedSavedMessage {
  id: string
  workspaceId: string
  userId: string
  /**
   * Null for standalone (message-less) saved items. IndexedDB simply omits
   * null keys from the `messageId` index, so standalone rows never collide
   * with the by-message lookups.
   */
  messageId: string | null
  streamId: string | null
  /**
   * Conversation the message was saved from — deep-links the row into the
   * conversation panel. Null for stream-origin saves and standalone to-dos, and
   * for rows cached before this field shipped (not indexed, so no version bump).
   */
  conversationId: string | null
  status: string
  /** Display line for standalone items; null for message-anchored rows. */
  title: string | null
  note: string | null
  remindAt: string | null
  reminderSentAt: string | null
  savedAt: string
  statusChangedAt: string
  message: {
    authorId: string
    authorType: string
    contentJson: unknown
    contentMarkdown: string
    createdAt: string
    editedAt: string | null
    streamName: string | null
  } | null
  unavailableReason: "deleted" | "access_lost" | null
  /** Sort key — ms timestamp parsed from savedAt. Duplicated so Dexie can index. */
  _savedAtMs: number
  /** Sort key — ms timestamp parsed from statusChangedAt. */
  _statusChangedAtMs: number
  /**
   * 0 when no reminder has fired; otherwise ms timestamp of reminderSentAt.
   * Lets the sidebar badge count fired reminders via an index-backed range
   * query instead of a full-table filter.
   */
  _reminderFiredAtMs: number
  _cachedAt: number
}

/**
 * Scheduled-message row cached for offline-first rendering of the To send /
 * Sent / Failed tabs and the per-stream composer popover. Keys mirror the
 * server's wire shape (`ScheduledMessageView`); we don't denormalize a live
 * message snapshot like saved-messages does because the scheduled row IS the
 * draft — `contentJson` and `contentMarkdown` are canonical here until the
 * worker fires.
 *
 * Numeric `_scheduledForMs` and `_statusChangedAtMs` mirror drive sort order
 * since Dexie can't sort on ISO strings efficiently.
 *
 * `_cachedAt` is the watermark used by the persistence helpers so a slow list
 * fetch can't clobber a fresher socket-driven write.
 */
export interface CachedScheduledMessage {
  id: string
  workspaceId: string
  userId: string
  streamId: string
  parentMessageId: string | null
  contentJson: unknown
  contentMarkdown: string
  attachmentIds: string[]
  metadata: Record<string, string> | null
  scheduledFor: string
  status: string
  sentMessageId: string | null
  lastError: string | null
  /** Worker fence — present (and in the future) while any editor session is open. */
  editActiveUntil: string | null
  clientMessageId: string | null
  /** Optimistic-concurrency version. Sent back as `expectedVersion` on save. */
  version: number
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  /**
   * `true` for rows written optimistically before the schedule POST landed.
   * The id starts with `sched_local_`; once the server-issued row arrives we
   * delete the local placeholder and persist the real one. UI can hide
   * destructive controls (edit, send-now) on placeholder rows since the
   * server doesn't know about them yet.
   */
  _localOnly?: boolean
  _scheduledForMs: number
  _statusChangedAtMs: number
  _cachedAt: number
}

/**
 * Cached snapshot of the user's active E2E identity key (UIK). Holds the
 * passphrase-wrapped private bundle that the backend mirrors back to the
 * device — the unwrapped private key never lands here, it lives in the
 * in-memory `e2e-session-store` for the session only.
 *
 * Key: deterministic per workspace+user so the bootstrap hydrator can upsert
 * without needing to fetch first.
 */
export interface CachedE2eKey {
  id: string // `${workspaceId}:${userId}` — deterministic so bootstrap upserts cleanly
  workspaceId: string
  userId: string
  keyId: string
  publicKey: string // base64
  encryptedPrivateBundle: string // base64
  kdfSalt: string // base64
  kdfParams: KdfParams
  createdAt: string
  _cachedAt: number
}

/**
 * Cached label row. Mirrors `Label` on the wire. Every label is private to its
 * creating actor, so the store only ever holds the viewer's own labels. Bucket
 * by `creatorUserId` in queries.
 */
export interface CachedLabel {
  id: string
  workspaceId: string
  /**
   * Whether `creatorUserId` is a user or a bot (bots can own labels via the
   * public API). Optional so rows cached before this field existed still read;
   * absent is treated as `"user"`. Not indexed — viewer bucketing keys off the
   * id, which never collides across actor types.
   */
  creatorActorType?: "user" | "bot"
  creatorUserId: string
  name: string
  slug: string
  color: string
  emoji: string | null
  description: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  _cachedAt: number
}

/**
 * A label applied to a resource. Generic over `resourceType` (a stream today;
 * messages/users/attachments later) — the assignment store never special-cases
 * the resource. Owner-scoped: only the current actor's assignments are cached.
 * `[workspaceId+resourceType+resourceId]` answers "which labels are on this
 * resource"; `[workspaceId+labelId]` answers "which resources carry this
 * label". Composite key `${workspaceId}:${resourceType}:${resourceId}:${labelId}:${userId}`.
 */
export interface CachedLabelAssignment {
  id: string
  workspaceId: string
  labelId: string
  resourceType: string
  resourceId: string
  /** Whether `userId` is a user or a bot. Optional for back-compat; absent ⇒ `"user"`. */
  actorType?: "user" | "bot"
  userId: string
  assignedAt: string
  _cachedAt: number
}

/**
 * "Keep me unlocked on this device" record. Persists the UIK private key sealed
 * for at-rest storage so a cold start can resume the unlocked session without
 * the passphrase / Argon2id step.
 *
 * Security note: the private key is never stored in the clear. For the plain
 * (no PIN/biometric) case it's sealed under a NON-EXTRACTABLE AES-GCM device
 * key (see `device-wrap-key.ts`) — even an attacker with this IDB record cannot
 * recover the raw private bytes, because that AES key can't be exported. The
 * presence of a row here IS the "this device is trusted" state. `lock()` /
 * sign-out delete it. `keyId` is stored so a server-side key rotation can be
 * detected and the now-stale device key discarded.
 *
 * The X25519 private key is sealed under the AES key rather than stored as a
 * `CryptoKey` because some browsers (Android Chrome) drop newer X25519 keys
 * when IndexedDB is flushed to disk; AES-GCM keys round-trip reliably. See
 * `device-wrap-key.ts` for the full rationale.
 */
export interface CachedE2eDeviceKey {
  id: string // `${workspaceId}:${userId}` — deterministic, one trusted key per user
  workspaceId: string
  userId: string
  keyId: string
  publicKey: string // base64 — matched against the server key to detect rotation
  /**
   * Auto-resume material for plain "keep me unlocked": a non-extractable
   * AES-GCM `CryptoKey` (`deviceWrapKey`) plus the X25519 private key sealed
   * under it (`deviceWrappedPrivate`, base64 `iv || ciphertext`). Present only
   * when the device is trusted WITHOUT a PIN/biometric — a cold start unwraps
   * these and resumes `unlocked` directly. Mutually exclusive with the
   * `pin*` / `webauthn*` fields below.
   */
  deviceWrapKey?: CryptoKey
  deviceWrappedPrivate?: string
  /**
   * PIN-gated quick-unlock: the UIK private key wrapped under a PIN-derived KEK
   * (base64 `wrapPrivate` bundle) + its Argon2id salt/params, plus a local
   * failed-attempt counter for the lockout. Present only when a device PIN is
   * set; resuming requires the PIN (see `unlockWithPin`). A non-extractable
   * CryptoKey can't be re-wrapped, so PIN mode stores the sealed bytes instead
   * of `privateKey`. The PIN itself is never stored or sent anywhere.
   */
  pinWrappedPrivate?: string
  pinSalt?: string
  pinKdfParams?: KdfParams
  pinFailedAttempts?: number
  /**
   * Biometric (WebAuthn PRF) quick-unlock: the UIK private key wrapped under the
   * authenticator's PRF-derived secret, plus the credential id and PRF salt
   * needed to reproduce that secret via a biometric assertion. Present only when
   * biometric unlock is set; mutually exclusive with `privateKey`/`pin*`. The
   * secret itself is never stored — it's re-derived from the authenticator.
   */
  webauthnCredentialId?: string
  webauthnPrfSalt?: string
  webauthnWrappedPrivate?: string
  trustedAt: string
}

export interface CachedWorkspaceMetadata {
  id: string // workspaceId
  workspaceId: string
  emojis: Array<{
    shortcode: string
    emoji: string
    type: string
    group: string
    order: number
    aliases: string[]
    /** Absent on rows cached before search keywords shipped. */
    keywords?: string[]
  }>
  emojiWeights: Record<string, number>
  /**
   * Agent tool categories the workspace has tooling configured for (`web` +
   * `workspace` always, `github`/`linear` when connected). Drives the
   * at-creation scratchpad tool-policy picker. Optional for rows cached before
   * the field shipped — absent reads as "all gateable".
   */
  configuredToolCategories?: ToolPrivacyCategory[]
  /**
   * Raw feature-flag override layers (workspace + user), resolved through the
   * registry at read time. Persisted so a warm start paints the resolved value
   * instead of the registry default for a frame. Optional for rows cached
   * before the field shipped — absent reads as all defaults.
   */
  featureFlags?: FeatureFlagLayers
  /**
   * Commands surfaced in the slash-command menu. `kind` defaults to "server"
   * for backwards compatibility with older cached rows; "client-action" items
   * carry a `clientActionId` the frontend dispatches on locally.
   */
  commands: Array<{
    name: string
    description: string
    kind?: "server" | "client-action" | "bot-runtime"
    scope?: "workspace" | "stream"
    clientActionId?: string
    args?: Array<{
      name: string
      required?: boolean
      description?: string
      suggestions?: Array<{ value: string; label?: string; description?: string }>
    }>
  }>
  _cachedAt: number
}

/**
 * A board post (a conversation surfaced as a feed card) on the sync-engine
 * rails. Mirrors how messages live in `events`: seeded by the board bootstrap
 * fetch, then kept live by the gate-applied `conversation:*` workspace handlers
 * and optimistic local writes — so the board re-sorts the instant a row's
 * activity changes instead of refetching on open.
 *
 * `id` is the conversation id (one card per conversation). `_lastActivityMs`
 * mirrors `conversation.lastActivityAt` as the numeric the board orders on.
 * `_status: "pending"` marks an optimistic local write awaiting its
 * authoritative `conversation:*` echo, swapped in place on arrival.
 */
export interface CachedBoardPost extends BoardPost {
  id: string
  workspaceId: string
  _lastActivityMs: number
  _cachedAt: number
  _status?: "pending"
}

/**
 * One message of a conversation's server backfill (`GET /conversations/:id/
 * board-messages`), cached so the expanded card and the panel render it from IDB
 * instead of from a response body. Deliberately NOT `db.events`: row presence
 * there is the sync engine's window bookkeeping, and sparse insertion would
 * corrupt catch-up cursors.
 *
 * Replace-per-conversation on seed, patched in place by the live message/
 * reaction/link-preview handlers, so a backfilled row stays as current as a
 * railed one.
 */
export interface CachedConversationMessage extends BoardPostMessage {
  /** The message id — the primary key (`id` is inherited and identical; the
   *  explicit name keeps the key legible against the board post's `id`). */
  messageId: string
  conversationId: string
  workspaceId: string
  _cachedAt: number
}

/** A conversation the viewer hid from the board (board-view-design.md § "Hide & mute").
 *  `id` is the conversation id; `hiddenAt` (ms) is the snooze watermark. */
export interface CachedBoardHiddenConversation {
  id: string
  workspaceId: string
  hiddenAt: number
  _cachedAt: number
}

/** A stream the viewer muted from the board. `id` is the root stream id. */
export interface CachedBoardMutedStream {
  id: string
  workspaceId: string
  _cachedAt: number
}
/**
 * One "In this stream" context row — the client's copy of a
 * `stream_context_items` projection row (link, media, file, memo, delegation,
 * thread), and the panel's read authority once C5 cuts it over.
 *
 * Keyed by the wire `key` (`${category}:${refId}:${sourceMessageId}` — see
 * `streamContextItemKey`), never the server's ULID: the same key is derivable
 * locally from a timeline event, so a locally-derived row and the server row it
 * anticipates collapse to one row on `bulkPut` instead of double-rendering.
 *
 * `groupRef` is the compound-index carrier for occurrence lookups
 * (`${category}:${groupKey}`). `groupKey` is server-computed (the GitHub/Linear-
 * aware URL normalizer stays backend-only), so a locally-derived row leaves it
 * equal to `refId` and groups by the raw href until the server row overwrites
 * it under the same `key`.
 */
export interface CachedStreamContextItem extends StreamContextItem {
  workspaceId: string
  /** The stream's effective root — the scope the tree feed reads. */
  rootStreamId: string
  /** `${category}:${groupKey}`, indexed with `occurredAt` for occurrences. */
  groupRef: string
  _cachedAt: number
  /** Locally derived, not yet reconciled against a server row. */
  _status?: "pending"
}

/**
 * One hydrated slot value persisted for offline/cold-start pointer rendering
 * (Amendment A). Slots live here — NOT in the TanStack bootstrap cache: the
 * sync layer is the single write boundary, and render reads canonical rows via
 * `useStreamSlots`. Compound primary key `[streamId+slotKey]` (stream ids are
 * globally unique, so the slot key needs no wider scope); `workspaceId` records
 * ownership for workspace cleanup. `value` is the wire `Slot` (strings/dates).
 */
export interface CachedSlot {
  workspaceId: string
  streamId: string
  slotKey: string
  value: Slot
  _cachedAt: number
}

export class ThreaDatabase extends Dexie {
  workspaces!: EntityTable<CachedWorkspace, "id">
  workspaceUsers!: EntityTable<CachedWorkspaceUser, "id">
  streams!: EntityTable<CachedStream, "id">
  streamMemberships!: EntityTable<CachedStreamMembership, "id">
  streamReadState!: EntityTable<CachedStreamReadState, "id">
  dmPeers!: EntityTable<CachedDmPeer, "id">
  events!: EntityTable<CachedEvent, "id">
  personas!: EntityTable<CachedPersona, "id">
  bots!: EntityTable<CachedBot, "id">
  pendingMessages!: EntityTable<PendingMessage, "clientId">
  syncCursors!: EntityTable<SyncCursor, "key">
  draftScratchpads!: EntityTable<DraftScratchpad, "id">
  drafts!: EntityTable<CachedDraft, "id">
  composerLoaded!: EntityTable<ComposerLoaded, "scope">
  composerTarget!: EntityTable<ComposerTarget, "host">
  unreadState!: EntityTable<CachedUnreadState, "id">
  userPreferences!: EntityTable<CachedUserPreferences, "id">
  workspaceMetadata!: EntityTable<CachedWorkspaceMetadata, "id">
  pendingOperations!: EntityTable<PendingOperation, "id">
  markdownBlockCollapse!: EntityTable<CachedMarkdownBlockCollapse, "id">
  linkPreviewCollapse!: EntityTable<CachedLinkPreviewCollapse, "id">
  savedMessages!: EntityTable<CachedSavedMessage, "id">
  scheduledMessages!: EntityTable<CachedScheduledMessage, "id">
  e2eKeys!: EntityTable<CachedE2eKey, "id">
  labels!: EntityTable<CachedLabel, "id">
  labelAssignments!: EntityTable<CachedLabelAssignment, "id">
  e2eDeviceKeys!: EntityTable<CachedE2eDeviceKey, "id">
  sidebarConfigs!: EntityTable<CachedSidebarConfig, "id">
  conversations!: EntityTable<CachedBoardPost, "id">
  conversationMessages!: EntityTable<CachedConversationMessage, "messageId">
  boardHiddenConversations!: EntityTable<CachedBoardHiddenConversation, "id">
  boardMutedStreams!: EntityTable<CachedBoardMutedStream, "id">
  uploadJobs!: EntityTable<CachedUploadJob, "attachmentId">
  slots!: Table<CachedSlot, [string, string]>
  streamContextItems!: EntityTable<CachedStreamContextItem, "key">

  private upgradeRecoveryAvailable = true

  constructor(name: string) {
    super(name)

    this.version(1).stores({
      workspaces: "id, slug, _cachedAt",
      [LEGACY_WORKSPACE_USERS_STORE]: "id, workspaceId, userId, _cachedAt",
      streams: "id, workspaceId, type, [workspaceId+type], _cachedAt",
      events: "id, streamId, sequence, [streamId+sequence], eventType, _clientId, _cachedAt",
      users: "id, email, _cachedAt",
      pendingMessages: "clientId, streamId, createdAt",
      syncCursors: "key, updatedAt",
    })

    this.version(2).stores({
      draftScratchpads: "id, workspaceId, createdAt",
    })

    this.version(3).stores({
      draftMessages: "id, workspaceId, updatedAt",
    })

    this.version(4).stores({
      personas: "id, workspaceId, slug, _cachedAt",
    })

    this.version(5).stores({
      users: "id, email, slug, _cachedAt",
    })

    // v6: DraftMessage now stores contentJson (JSONContent) instead of content (string)
    // Clear existing drafts since converting markdown → JSON requires complex dependencies
    this.version(6)
      .stores({})
      .upgrade((tx) => {
        return tx.table("draftMessages").clear()
      })

    // v7: Workspace user identity refactor — users now have their own ID, slug, timezone, locale.
    // Global users cache no longer has slug. Clear workspace user cache to re-fetch with new shape.
    this.version(7)
      .stores({
        [LEGACY_WORKSPACE_USERS_STORE]: "id, workspaceId, userId, slug, _cachedAt",
        users: "id, email, _cachedAt",
      })
      .upgrade((tx) => {
        return Promise.all([tx.table(LEGACY_WORKSPACE_USERS_STORE).clear(), tx.table("users").clear()])
      })

    // v8: Added setupCompleted to workspace users for invitation flow.
    // Clear workspace user cache to re-fetch with new shape.
    this.version(8)
      .stores({})
      .upgrade((tx) => {
        return tx.table(LEGACY_WORKSPACE_USERS_STORE).clear()
      })

    // v9: Added name to workspace users (workspace-scoped display name).
    // Clear workspace user cache to re-fetch with new shape.
    this.version(9)
      .stores({})
      .upgrade((tx) => {
        return tx.table(LEGACY_WORKSPACE_USERS_STORE).clear()
      })

    // v10: Added description and avatarUrl to workspace users (profile fields).
    // Clear workspace user cache to re-fetch with new shape.
    this.version(10)
      .stores({})
      .upgrade((tx) => {
        return tx.table(LEGACY_WORKSPACE_USERS_STORE).clear()
      })

    // v11: Remove cached global users table and move WorkOS identity/email onto workspace users.
    this.version(11)
      .stores({
        [LEGACY_WORKSPACE_USERS_STORE]: "id, workspaceId, workosUserId, email, slug, _cachedAt",
        users: null,
      })
      .upgrade((tx) => {
        return tx.table(LEGACY_WORKSPACE_USERS_STORE).clear()
      })

    // v12: Rename local cache store from workspaceMembers -> workspaceUsers.
    // We intentionally reset cache during this rename; bootstrap refetch repopulates it.
    this.version(12)
      .stores({
        [WORKSPACE_USERS_STORE]: "id, workspaceId, workosUserId, email, slug, _cachedAt",
        [LEGACY_WORKSPACE_USERS_STORE]: null,
      })
      .upgrade((tx) => tx.table(WORKSPACE_USERS_STORE).clear())

    // v13: Cache stream memberships and DM peers for offline seed.
    // Also adds parentStreamId/rootStreamId/archivedAt to CachedStream (already stored
    // via spread, but now typed and relied upon by cache-seed).
    this.version(13).stores({
      streamMemberships: "id, workspaceId, streamId, _cachedAt",
      dmPeers: "id, workspaceId, streamId, _cachedAt",
    })

    // v14: Add bots table for bot entity resolution on frontend.
    this.version(14).stores({
      bots: "id, workspaceId, _cachedAt",
    })

    // v15: Add unreadState and userPreferences tables for offline-first sync engine.
    // These tables hold workspace-scoped data that was previously only in TanStack Query
    // cache (embedded in WorkspaceBootstrap). Persisting them enables offline rendering.
    this.version(15).stores({
      unreadState: "id, workspaceId",
      userPreferences: "id, workspaceId",
    })

    // v16: Add workspaceId to events table for workspace-scoped cleanup and leak prevention.
    // Clear existing events since they lack workspaceId; bootstrap refetch repopulates.
    this.version(16)
      .stores({
        events: "id, workspaceId, streamId, sequence, [streamId+sequence], eventType, _clientId, _cachedAt",
      })
      .upgrade((tx) => tx.table("events").clear())

    // v17: Add workspaceMetadata table for emojis, emojiWeights, and commands.
    this.version(17).stores({
      workspaceMetadata: "id, workspaceId",
    })

    // v18: Add pendingOperations table for offline-queued writes (edits, deletes, reactions).
    this.version(18).stores({
      pendingOperations: "id, workspaceId, type, createdAt",
    })

    // v19: Add [streamId+eventType] compound index for scoped event lookups
    // (reactions, edits, deletes scan only message_created events instead of
    // all events in a stream). Add _status index so pending/failed message
    // hydration uses an index scan instead of a full table cursor.
    this.version(19).stores({
      events:
        "id, workspaceId, streamId, sequence, [streamId+sequence], eventType, [streamId+eventType], _clientId, _cachedAt, _status",
    })

    // v20: Add _sequenceNum (numeric mirror of sequence) and compound index
    // [streamId+_sequenceNum] so IDB can sort events numerically for efficient
    // "most recent N" queries. Clear events so bootstrap re-populates them
    // with the new field.
    this.version(20)
      .stores({
        events:
          "id, workspaceId, streamId, sequence, [streamId+sequence], [streamId+_sequenceNum], eventType, [streamId+eventType], _clientId, _cachedAt, _status",
      })
      .upgrade((tx) => tx.table("events").clear())

    // v21: Add codeBlockCollapse table for per-message, per-code-block collapse
    // toggle state. Indexed by messageId so we can bulk-clear a message's
    // state when it is deleted.
    this.version(21).stores({
      codeBlockCollapse: "id, messageId, updatedAt",
    })

    // v22: Generalize the collapse table to cover any collapsible markdown
    // block (code, blockquote, quote-reply). The key format gains a `kind`
    // segment, and existing code-block rows are carried over.
    this.version(22)
      .stores({
        markdownBlockCollapse: "id, messageId, kind, updatedAt",
        codeBlockCollapse: null,
      })
      .upgrade(async (tx) => {
        const oldRows = await tx.table("codeBlockCollapse").toArray()
        const migrated = oldRows.flatMap((row) => {
          // Old id was `${messageId}:${hash}`. ULIDs don't contain ':' so the
          // first colon separates the two parts. Skip any row missing either
          // segment rather than producing a corrupt key.
          const id = typeof row.id === "string" ? row.id : ""
          const separator = id.indexOf(":")
          if (separator <= 0 || separator === id.length - 1) return []
          const messageId = id.slice(0, separator)
          const hash = id.slice(separator + 1)
          return [
            {
              id: `${messageId}:code:${hash}`,
              messageId,
              kind: "code" as const,
              collapsed: Boolean(row.collapsed),
              updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
            },
          ]
        })
        if (migrated.length > 0) {
          await tx.table("markdownBlockCollapse").bulkPut(migrated)
        }
      })

    // v23: Add linkPreviewCollapse table for persisted per-preview expand state.
    // Every card clamps its body to a fixed height by default; users expand
    // tall ones (e.g. GitHub diffs, long READMEs) and that choice persists.
    this.version(23).stores({
      linkPreviewCollapse: "id, messageId, updatedAt",
    })

    // v24: Saved messages cache — first-page offline rendering and optimistic
    // UI. Indexed by (workspaceId, status) so each tab paginates its own
    // partial index; the numeric `_savedAtMs` / `_statusChangedAtMs` mirrors
    // drive sorting since Dexie can't sort on ISO strings efficiently.
    this.version(24).stores({
      savedMessages:
        "id, workspaceId, messageId, status, [workspaceId+status+_savedAtMs], [workspaceId+status+_statusChangedAtMs], _cachedAt",
    })

    // v25: Add `_reminderFiredAtMs` + compound index so the sidebar badge
    // can count fired reminders via a range query instead of a full scan.
    this.version(25)
      .stores({
        savedMessages:
          "id, workspaceId, messageId, status, [workspaceId+status+_savedAtMs], [workspaceId+status+_statusChangedAtMs], [workspaceId+status+_reminderFiredAtMs], _cachedAt",
      })
      .upgrade(async (tx) => {
        // Populate the new field for rows cached before v25 so the count
        // isn't silently 0 until the next list fetch rehydrates them.
        await tx
          .table("savedMessages")
          .toCollection()
          .modify((row: { reminderSentAt: string | null; _reminderFiredAtMs?: number }) => {
            row._reminderFiredAtMs = row.reminderSentAt ? Date.parse(row.reminderSentAt) : 0
          })
      })

    // v26: Stashed drafts — multiple explicitly-saved drafts per scope,
    // browsable via the composer picker. The compound [workspaceId+scope]
    // index lets the picker list drafts for the current stream/thread
    // without scanning the workspace. Keyed by ULID so the same scope can
    // hold many stashed snapshots.
    this.version(26).stores({
      stashedDrafts: "id, workspaceId, scope, [workspaceId+scope], createdAt",
    })

    // v27: Scheduled messages cache — first-page offline rendering and
    // optimistic UI for the To send / Sent / Failed tabs and the per-stream
    // composer popover. Indexes:
    //   [workspaceId+status+_scheduledForMs] — To send tab (ASC)
    //   [workspaceId+status+_statusChangedAtMs] — Sent / Failed tabs (DESC)
    //   [workspaceId+streamId+status+_scheduledForMs] — composer popover
    this.version(27).stores({
      scheduledMessages:
        "id, workspaceId, streamId, status, [workspaceId+status+_scheduledForMs], [workspaceId+status+_statusChangedAtMs], [workspaceId+streamId+status+_scheduledForMs], _cachedAt",
    })

    // v28: CachedBot gains required fields type/ownerUserId/traits (personal
    // bots foundation). Clear stale rows so pre-v28 entries without these
    // fields are removed; bootstrap rehydrates the table on next load.
    this.version(28)
      .stores({})
      .upgrade((tx) => tx.table("bots").clear())

    // v29: E2E identity key cache. Holds the passphrase-wrapped private bundle
    // so unlock works offline / on refresh without a roundtrip — the unwrapped
    // private key is never persisted here, only in the in-memory session store.
    this.version(29).stores({
      e2eKeys: "id, [workspaceId+userId], workspaceId, _cachedAt",
    })

    // v30: Labels + per-user label memberships for offline-first reads.
    // [workspaceId+visibility] lets the discovery tab pull all public labels
    // without scanning the workspace's private rows. labelMemberships' compound
    // [workspaceId+userId] surfaces the viewer's joined-public labels for the
    // "My labels" tab.
    this.version(30).stores({
      labels: "id, workspaceId, visibility, [workspaceId+visibility], creatorUserId, _cachedAt",
      labelMemberships: "id, workspaceId, labelId, userId, [workspaceId+userId], [workspaceId+labelId], _cachedAt",
    })

    // v31: "keep me unlocked on this device" store. Holds the UNWRAPPED but
    // NON-EXTRACTABLE private CryptoKey so a reload resumes the unlocked
    // session without re-deriving the KEK. Distinct from `e2eKeys` (the
    // wrapped bundle) because its lifecycle is device-trust, not key-cache.
    this.version(31).stores({
      e2eDeviceKeys: "id, [workspaceId+userId], workspaceId",
    })

    // v32: Generic resource-label assignments. Viewer-scoped rows (only the
    // current user's) so reads mirror private-label visibility. Per-resource
    // reads ("labels on this resource") go through the in-memory workspace
    // cache like every other workspace entity, not a Dexie query, so the only
    // indexes that earn their keep are `workspaceId` (reconcile + stale-sweep
    // scope) and `labelId` (drop a deleted label's assignments without a full
    // scan).
    this.version(32).stores({
      labelAssignments: "id, workspaceId, labelId, _cachedAt",
    })

    // v33: Per-(workspace, user) sidebar layout for offline-first reads. One row
    // per workspace (keyed by workspaceId), mirroring userPreferences.
    this.version(33).stores({
      sidebarConfigs: "id, workspaceId",
    })

    // v34: Centralized drafts — fold the two local draft tables into one.
    // `draftMessages` (one ambient auto-save per scope) and `stashedDrafts`
    // (many explicit Cmd+S saves per scope) become rows in a single `drafts`
    // store, each with its own `draft_` id and a `scope`. A device-local
    // `composerLoaded` pointer records which draft is checked out per scope.
    // The upgrade migrates every ambient draft to a draft + a loaded pointer,
    // and every stash to a (not-loaded) draft, then drops the old stores.
    // [workspaceId+scope] backs the per-scope stash picker; clientUpdatedAt
    // backs recency ordering.
    this.version(34)
      .stores({
        drafts: "id, workspaceId, scope, [workspaceId+scope], clientUpdatedAt",
        composerLoaded: "scope, workspaceId",
        draftMessages: null,
        stashedDrafts: null,
      })
      .upgrade(async (tx) => {
        const [messages, stashes] = await Promise.all([
          tx.table("draftMessages").toArray(),
          tx.table("stashedDrafts").toArray(),
        ])

        const draftRows: CachedDraft[] = []
        const loadedRows: ComposerLoaded[] = []

        // Ambient auto-saved drafts: one draft each, set as the loaded pointer
        // for their scope so the composer restores them exactly as before. The
        // old row's `id` IS the scope ("stream:…" / "thread:…").
        for (const message of messages) {
          const row = message as {
            id: string
            workspaceId: string
            contentJson: JSONContent
            attachments?: DraftAttachment[]
            contextRefs?: DraftContextRef[]
            updatedAt?: number
          }
          const id = generateLocalDraftId()
          draftRows.push({
            id,
            workspaceId: row.workspaceId,
            scope: row.id,
            contentJson: row.contentJson,
            attachments: row.attachments ?? [],
            contextRefs: row.contextRefs,
            clientUpdatedAt: row.updatedAt ?? Date.now(),
          })
          loadedRows.push({ scope: row.id, workspaceId: row.workspaceId, draftId: id })
        }

        // Stashed drafts: one draft each, left unloaded so they surface in the
        // stash list rather than the composer.
        for (const stash of stashes) {
          const row = stash as {
            workspaceId: string
            scope: string
            contentJson: JSONContent
            attachments?: DraftAttachment[]
            createdAt?: number
          }
          draftRows.push({
            id: generateLocalDraftId(),
            workspaceId: row.workspaceId,
            scope: row.scope,
            contentJson: row.contentJson,
            attachments: row.attachments ?? [],
            clientUpdatedAt: row.createdAt ?? Date.now(),
          })
        }

        if (draftRows.length > 0) await tx.table("drafts").bulkPut(draftRows)
        if (loadedRows.length > 0) await tx.table("composerLoaded").bulkPut(loadedRows)
      })

    // v35: Labels are private-only now. Drop the `labelMemberships` store (it
    // only modeled the public "join" concept) and re-index `labels` without the
    // removed `visibility` column. Clearing `labels` is safe — the bootstrap
    // refills it from the server on next load.
    this.version(35)
      .stores({
        labels: "id, workspaceId, creatorUserId, _cachedAt",
        labelMemberships: null,
      })
      .upgrade((tx) => {
        return tx.table("labels").clear()
      })

    // v36: conversations get their own store so the board rides the sync engine
    // (IDB + gate-applied events + optimistic writes) like the timeline, rather
    // than being a refetch-on-open React-Query list. Seeded from the board
    // bootstrap; never holds anything the server can't refill.
    this.version(36).stores({
      conversations: "id, workspaceId, [workspaceId+_lastActivityMs], _cachedAt",
    })

    // v37: sparse read overlay (docs/sparse-read-overlay-design.md). The overlay
    // (`unreadState.readMessageIds`) and the membership watermark sequence
    // (`streamMemberships.lastReadSequence`) are unindexed value fields on
    // existing rows, so the bump only guards the added shape — no schema delta.
    this.version(37).stores({})

    // v38: per-viewer board exclusions (board-view-design.md § "Hide & mute").
    // Keyed by the excluded id (conversationId / root streamId) so a reactive
    // read is a single get; `[workspaceId+hiddenAt]` lets the snooze-revival
    // check scan a viewer's hidden set without loading rows one by one.
    this.version(38).stores({
      boardHiddenConversations: "id, workspaceId, [workspaceId+hiddenAt]",
      boardMutedStreams: "id, workspaceId",
    })

    // v39: durable background-upload jobs (bytes + metadata) so in-flight
    // uploads survive a reload/app-reopen and resume. The blob itself is an
    // unindexed field.
    this.version(39).stores({
      uploadJobs: "attachmentId, workspaceId",
    })

    // v40: workspaceMetadata gains optional `featureFlags` (raw override layers)
    // for first-render correctness. An unindexed value field on existing rows,
    // so the bump only guards the added shape — no schema delta (see v37).
    this.version(40).stores({})

    // v41: optimistic events gain an unindexed persisted-sequence anchor for
    // clock-independent timeline ordering; existing rows need no migration.
    this.version(41).stores({})

    // v42: persisted slot store (Amendment A). Cross-stream pointer hydration
    // moves out of the TanStack bootstrap cache into its own table so the sync
    // layer is the single write boundary and render reads canonical rows. v41
    // persisted no hydration carrier, so there is nothing to transform — the
    // table starts empty and converges from bootstrap/socket/page writes.
    this.version(42)
      .stores({
        slots: "[streamId+slotKey], streamId, workspaceId, _cachedAt",
      })
      .upgrade(() => undefined)

    // v43: standalone read frontier store (read cutover). The watermark moves
    // off the membership mirror into its own row keyed by workspace+stream;
    // frontier readers prefer row presence (a null watermark is an explicit
    // frontier) and fall back to streamMemberships/db.streams while the rollout
    // dual-writes. Starts empty — seeded from the bootstrap's streamReadState
    // map and the read socket appliers.
    this.version(43).stores({
      streamReadState: "id, workspaceId, streamId, _cachedAt",
    })

    // v44: stream_read_state is the sole read frontier. The membership watermark
    // fields (`streamMemberships.lastReadEventId/lastReadSequence/lastReadAt`) and
    // the `streams.lastReadEventId` compat frontier stop being written. They were
    // unindexed value fields, so there is no schema delta and old rows are left
    // as-is — readers ignore the stale properties (Dexie can't drop them).
    this.version(44).stores({})

    // v45: "In this stream" context rows get their own store so the panel reads
    // from IDB like the timeline does, instead of re-deriving the whole view
    // from the loaded event window. Primary key is the wire `key` so a locally
    // derived row and its server counterpart reconcile in place. The three
    // compound indexes are the three reads: the tree feed, the single-stream
    // feed, and a group's occurrences — all ordered by `occurredAt` (ISO
    // timestamps sort lexically, so no numeric mirror is needed). Starts empty
    // and converges from the sync appliers and the read endpoint.
    this.version(45).stores({
      streamContextItems:
        "key, workspaceId, streamId, rootStreamId, [workspaceId+sourceMessageId], [rootStreamId+occurredAt], [streamId+occurredAt], [groupRef+occurredAt]",
    })

    // v46: the board-messages backfill gets its own store so an expanded card
    // and the panel render it from IDB (live-patched) instead of straight from
    // the response body. Keyed by message id; read per conversation, wiped per
    // workspace. Starts empty and fills from the backfill fetch.
    this.version(46).stores({
      conversationMessages: "messageId, conversationId, workspaceId",
    })

    // v47: `payload.messageId` becomes a sparse dotted-key-path index so a
    // message patch (reaction, edit, delete, move, link-preview resolve, thread
    // heal) is a direct lookup instead of a cursor over the whole
    // [streamId+"message_created"] range. No `.upgrade()` — the engine builds
    // the index over existing rows; no row is rewritten.
    // One-way door: once a client has opened at v47, code declaring only v46
    // cannot open the database (IndexedDB refuses a version downgrade), so a
    // revert of this bump is not available — reverting means a v48. The
    // *lookup* that uses the index is flag-gated (`indexedMessagePatch`)
    // instead, and that is what a rollback turns off.
    this.version(47).stores({
      events:
        "id, workspaceId, streamId, sequence, [streamId+sequence], [streamId+_sequenceNum], eventType, [streamId+eventType], _clientId, _cachedAt, _status, payload.messageId",
    })

    // v48: the durable composer target (which scope a host composes into),
    // beside `composerLoaded` — device-local, unsynced, kept across logout like
    // the drafts it points at. Plus a multiEntry index over a conversation's
    // message ids: resolving which conversation hosts a fork/anchor message was
    // a full workspace scan of `conversations`, which an always-mounted composer
    // re-ran on every write. Both start from existing rows — Dexie builds the
    // index during the upgrade, so no `.upgrade()`.
    this.version(48).stores({
      composerTarget: "host, workspaceId",
      conversations: "id, workspaceId, [workspaceId+_lastActivityMs], _cachedAt, *conversation.messageIds",
    })

    this.workspaceUsers = this.table(WORKSPACE_USERS_STORE) as EntityTable<CachedWorkspaceUser, "id">

    // Another tab upgraded the shared per-account database. Dexie closes this
    // connection but leaves auto-open on, so the next operation would reopen
    // with the older schema against the newer physical DB and throw
    // VersionError for the rest of the tab's life.
    this.on("versionchange", () => {
      this.close()
      if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload()
      return false
    })
  }

  // Auto-open routes through here too (Dexie calls `db.open()` on first use),
  // so this is the one seam every open failure crosses.
  override open(): PromiseExtended<Dexie> {
    return super.open().catch((error: unknown) => {
      if (!this.upgradeRecoveryAvailable || !isRecoverableOpenFailure(error)) throw error
      this.upgradeRecoveryAvailable = false
      console.error(`[db] upgrade failed for ${this.name}; deleting the cache and reopening cold`, error)
      this.close()
      return Dexie.delete(this.name).then(() => this.open()) as PromiseExtended<Dexie>
    })
  }
}

const RECOVERABLE_OPEN_FAILURE_NAMES: ReadonlySet<string> = new Set([
  "QuotaExceededError",
  "AbortError",
  "UpgradeError",
])

/**
 * A failed version upgrade (quota abort mid index build) is retried on every
 * open, so the app never reaches a working state. Everything in this database
 * is a server-derived cache, so deleting it recovers to a cold start; the loud
 * console.error plus the one-shot guard keep this a reported failure with a
 * recovery, not a silent fallback (INV-11).
 */
function isRecoverableOpenFailure(error: unknown): boolean {
  let current = error
  for (let depth = 0; current && depth < 5; depth++) {
    const name = (current as { name?: unknown }).name
    if (typeof name === "string" && RECOVERABLE_OPEN_FAILURE_NAMES.has(name)) return true
    current = (current as { inner?: unknown }).inner
  }
  return false
}

// The active account's database. AccountScope owns this pointer and is its
// only writer (see auth/account-scope.tsx). It is a deliberate, single-owner
// scope bridge — NOT hidden mutable state (INV-9): every `import { db }`
// consumer reads through the proxy below, so swapping the active account is a
// single synchronous pointer move done before the keyed subtree mounts,
// avoiding a ~30-file importer rewrite. Defaults to the "threa" handle so the
// pre-React collapse-cache hydration in main.tsx (and login/loading routes,
// which have no account yet) keep working unchanged.
let activeDb: ThreaDatabase = new ThreaDatabase("threa")

// Single source of truth for the per-account database name (INV-33). The main
// thread (AccountScope) and the service worker's push prefetch open the same
// IndexedDB independently — they only meet if they derive the name from the
// same place. The argument is the WorkOS user id (the auth identity), which is
// also what push payloads carry as `workosUserId`.
export function accountDbName(workosUserId: string): string {
  return `threa_${workosUserId}`
}

/** AccountScope-only: point the shared `db` proxy at an account's instance. */
export function setActiveDb(instance: ThreaDatabase): void {
  activeDb = instance
}

// Shared handle every feature imports as `import { db } from "@/db"`. Every
// access resolves against the *current* active instance, so an account switch
// (a `setActiveDb` call + keyed remount) atomically redirects all reads/writes
// with zero churn in consumer modules.
export const db: ThreaDatabase = new Proxy(Object.create(null) as ThreaDatabase, {
  get(_t, prop) {
    const value = Reflect.get(activeDb, prop, activeDb)
    return typeof value === "function" ? value.bind(activeDb) : value
  },
  set(_t, prop, value) {
    return Reflect.set(activeDb, prop, value, activeDb)
  },
  has(_t, prop) {
    return Reflect.has(activeDb, prop)
  },
})

export async function clearAllCachedData(): Promise<void> {
  try {
    await Promise.all([
      db.workspaces.clear(),
      db.workspaceUsers.clear(),
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.streamReadState.clear(),
      db.dmPeers.clear(),
      db.events.clear(),
      db.personas.clear(),
      db.bots.clear(),
      db.syncCursors.clear(),
      db.unreadState.clear(),
      db.userPreferences.clear(),
      db.workspaceMetadata.clear(),
      db.pendingOperations.clear(),
      db.markdownBlockCollapse.clear(),
      db.linkPreviewCollapse.clear(),
      db.savedMessages.clear(),
      db.scheduledMessages.clear(),
      // Drafts (the unified `drafts` store) and the device-local
      // `composerLoaded` / `composerTarget` pointers are intentionally NOT cleared on logout —
      // mirroring the pre-unification behavior where ambient drafts survived a
      // sign-out so in-progress work isn't lost across a re-login. They are
      // workspace+user scoped within this account's database.
      // Wrapped private bundles are tied to the logging-out identity — drop
      // them so the next account starts without inherited key material.
      db.e2eKeys.clear(),
      db.labels.clear(),
      db.labelAssignments.clear(),
      db.sidebarConfigs.clear(),
      db.conversations.clear(),
      db.conversationMessages.clear(),
      db.streamContextItems.clear(),
      db.slots.clear(),
      // The persisted device key seals this identity's private key for
      // auto-resume — sign-out must drop it so the next account can't resume
      // this identity's unlocked session.
      db.e2eDeviceKeys.clear(),
      // Note: we keep pendingMessages to retry sending after re-login, and
      // uploadJobs for the same reason — a queued message's attachment bytes
      // must survive the re-login to heal the send.
    ])
  } finally {
    const [
      { resetWorkspaceStoreCache },
      { resetStreamStoreCache },
      { resetDraftStoreCache },
      { resetUploadManager },
      { resetRowConfirmations },
    ] = await Promise.all([
      import("@/stores/workspace-store"),
      import("@/stores/stream-store"),
      import("@/stores/draft-store"),
      import("@/lib/uploads/upload-manager"),
      import("@/sync/bootstrap-diff"),
    ])
    resetWorkspaceStoreCache()
    resetStreamStoreCache()
    resetDraftStoreCache()
    resetUploadManager()
    resetRowConfirmations()
  }
}

export async function clearPendingMessages(): Promise<void> {
  await db.pendingMessages.clear()
}
