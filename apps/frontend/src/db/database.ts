import Dexie, { type EntityTable } from "dexie"
import type {
  AuthorType,
  CompanionMode,
  E2eInvitedAgentKind,
  EventType,
  JSONContent,
  NotificationLevel,
  StreamContextBagPayload,
  StreamType,
  WorkspaceRoleSlug,
} from "@threa/types"
import type { KdfParams } from "@/lib/crypto/passphrase"
import type { DraftContextRef } from "@/lib/context-bag/types"

const WORKSPACE_USERS_STORE = "workspaceUsers"
const LEGACY_WORKSPACE_USERS_STORE = "workspaceMembers"

// Cached entity types - mirror backend domain types

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
  setupCompleted: boolean
  joinedAt: string
  _cachedAt: number
}

export interface CachedStream {
  id: string
  workspaceId: string
  type: StreamType
  displayName: string | null
  slug: string | null
  description: string | null
  visibility: "public" | "private"
  parentStreamId: string | null
  parentMessageId: string | null
  rootStreamId: string | null
  companionMode: "off" | "on"
  companionPersonaId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  // Sidebar preview (from workspace bootstrap StreamWithPreview)
  lastMessagePreview?: { authorId: string; authorType: AuthorType; content: string; createdAt: string } | null
  // User-specific state (from membership)
  pinned?: boolean
  notificationLevel?: string | null
  lastReadEventId?: string | null
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
   * Which agent (if any) the owner invited into this E2E stream. Mirrored
   * from `StreamWithPreview.e2eInvitedAgentKind` so the send path knows
   * whether to fan envelopes out to the live enclave EIK set. Stays
   * undefined on plaintext streams and on rows cached before 5a.2.
   */
  e2eInvitedAgentKind?: E2eInvitedAgentKind
  _cachedAt: number
}

export interface CachedStreamMembership {
  /** Composite key: `${workspaceId}:${streamId}` */
  id: string
  workspaceId: string
  streamId: string
  memberId: string
  pinned: boolean
  pinnedAt: string | null
  notificationLevel: NotificationLevel | null
  lastReadEventId: string | null
  lastReadAt: string | null
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

export interface CachedEvent {
  id: string
  workspaceId: string
  streamId: string
  sequence: string // bigint as string
  /** Numeric mirror of sequence for IDB index ordering (string indexes sort lexicographically). */
  _sequenceNum: number
  eventType: EventType
  payload: unknown
  actorId: string | null
  actorType: AuthorType | null
  createdAt: string
  // Optimistic sending state (for message_created events)
  _clientId?: string
  _status?: "pending" | "sent" | "failed" | "editing"
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
  systemPrompt: string | null
  model: string
  temperature: number | null
  maxTokens: number | null
  enabledTools: string[] | null
  managedBy: "system" | "workspace"
  status: "pending" | "active" | "disabled" | "archived"
  createdAt: string
  updatedAt: string
  _cachedAt: number
}

export interface PendingStreamCreation {
  type: StreamType
  displayName?: string
  companionMode?: CompanionMode
  parentStreamId?: string
  parentMessageId?: string
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
  payload: Record<string, unknown>
  createdAt: number
  retryCount: number
  retryAfter?: number
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

export interface DraftMessage {
  // Key format: "stream:{streamId}" or "thread:{parentMessageId}" for new threads
  id: string
  workspaceId: string
  /** ProseMirror JSON content */
  contentJson: JSONContent
  /** Attachments that have been uploaded and are ready to attach to the message */
  attachments?: DraftAttachment[]
  /** Context refs attached to this draft (populated by "Discuss with Ariadne"). */
  contextRefs?: DraftContextRef[]
  updatedAt: number
}

/**
 * An explicitly-stashed draft, created by the user pressing Cmd+S or the save
 * button in the composer. Unlike `DraftMessage` (one per scope, auto-saved as
 * the user types), any number of stashed drafts can coexist for the same scope
 * — they're a sidelined pile the user can restore later. Scope mirrors the
 * `DraftMessage` key format: "stream:{streamId}" or "thread:{parentMessageId}".
 */
export interface StashedDraft {
  /** ULID with "stash_" prefix. Distinct from "draft_" which is claimed by DraftScratchpad. */
  id: string
  workspaceId: string
  scope: string
  contentJson: JSONContent
  attachments?: DraftAttachment[]
  createdAt: number
}

export interface CachedUnreadState {
  id: string // workspaceId
  workspaceId: string
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  activityCounts: Record<string, number>
  unreadActivityCount: number
  mutedStreamIds: string[]
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
  /** Block kind — lets us clear collapse state scoped to a block type. */
  kind: "code" | "blockquote" | "quote-reply"
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
  messageId: string
  streamId: string
  status: string
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

export interface CachedWorkspaceMetadata {
  id: string // workspaceId
  workspaceId: string
  emojis: Array<{ shortcode: string; emoji: string; type: string; group: string; order: number; aliases: string[] }>
  emojiWeights: Record<string, number>
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

// Database class with typed tables
export class ThreaDatabase extends Dexie {
  workspaces!: EntityTable<CachedWorkspace, "id">
  workspaceUsers!: EntityTable<CachedWorkspaceUser, "id">
  streams!: EntityTable<CachedStream, "id">
  streamMemberships!: EntityTable<CachedStreamMembership, "id">
  dmPeers!: EntityTable<CachedDmPeer, "id">
  events!: EntityTable<CachedEvent, "id">
  personas!: EntityTable<CachedPersona, "id">
  bots!: EntityTable<CachedBot, "id">
  pendingMessages!: EntityTable<PendingMessage, "clientId">
  syncCursors!: EntityTable<SyncCursor, "key">
  draftScratchpads!: EntityTable<DraftScratchpad, "id">
  draftMessages!: EntityTable<DraftMessage, "id">
  stashedDrafts!: EntityTable<StashedDraft, "id">
  unreadState!: EntityTable<CachedUnreadState, "id">
  userPreferences!: EntityTable<CachedUserPreferences, "id">
  workspaceMetadata!: EntityTable<CachedWorkspaceMetadata, "id">
  pendingOperations!: EntityTable<PendingOperation, "id">
  markdownBlockCollapse!: EntityTable<CachedMarkdownBlockCollapse, "id">
  linkPreviewCollapse!: EntityTable<CachedLinkPreviewCollapse, "id">
  savedMessages!: EntityTable<CachedSavedMessage, "id">
  scheduledMessages!: EntityTable<CachedScheduledMessage, "id">
  e2eKeys!: EntityTable<CachedE2eKey, "id">

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

    this.workspaceUsers = this.table(WORKSPACE_USERS_STORE) as EntityTable<CachedWorkspaceUser, "id">
  }
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

// Helper to clear all cached data (useful for logout)
export async function clearAllCachedData(): Promise<void> {
  try {
    await Promise.all([
      db.workspaces.clear(),
      db.workspaceUsers.clear(),
      db.streams.clear(),
      db.streamMemberships.clear(),
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
      db.stashedDrafts.clear(),
      // Wrapped private bundles are tied to the logging-out identity — drop
      // them so the next account starts without inherited key material.
      db.e2eKeys.clear(),
      // Note: we keep pendingMessages to retry sending after re-login
    ])
  } finally {
    const [{ resetWorkspaceStoreCache }, { resetStreamStoreCache }, { resetDraftStoreCache }] = await Promise.all([
      import("@/stores/workspace-store"),
      import("@/stores/stream-store"),
      import("@/stores/draft-store"),
    ])
    resetWorkspaceStoreCache()
    resetStreamStoreCache()
    resetDraftStoreCache()
  }
}

// Helper to clear pending messages (useful when explicitly canceling)
export async function clearPendingMessages(): Promise<void> {
  await db.pendingMessages.clear()
}
