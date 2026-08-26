/**
 * API request/response types.
 *
 * These types define the contracts between frontend and backend.
 */

import type {
  StreamType,
  Visibility,
  LabelableResourceType,
  CompanionMode,
  MemoryMode,
  SavedStatus,
  SavedSuggestionStatus,
  AuthorType,
  ScheduledMessageStatus,
  E2eKeyWrapRecipientKind,
  AgentStepType,
  KnowledgeType,
  DelegationStatus,
  DelegationReopenReason,
} from "./constants"
import type { WorkspaceInvitableRole } from "./workspace-permissions"
import type { ContextBag, ContextIntent, ContextRefKind } from "./context-bag"
import type { SharedMessageSlot, SlotMap } from "./slots"
import type { UserId } from "./ids"
import type { JSONContent } from "./prosemirror"
import type {
  Stream,
  StreamWithPreview,
  StreamEvent,
  StreamMember,
  Label,
  LabelAssignment,
  Workspace,
  User,
  WorkspaceInvitation,
  Persona,
  Bot,
  BoardView,
  ThreadSummary,
} from "./domain"
import type { UserPreferences } from "./preferences"
import type { WorkspaceSettings } from "./workspace-settings"
import type { FeatureFlagLayers } from "./feature-flags"
import type { SidebarConfig } from "./sidebar"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "./tool-privacy"
import type { WorkspacePermissionSlug } from "./workspace-permissions"

/** Maximum quoted phrase filters accepted by message search. */
export const MAX_SEARCH_PHRASES = 5

interface CreateStreamInputBase {
  type: StreamType
  displayName?: string
  slug?: string
  /** Rich-text description (ProseMirror); backend derives the markdown projection. */
  descriptionJson?: JSONContent
  /** Markdown description (external/wire); backend parses it to `descriptionJson`. */
  description?: string
  visibility?: Visibility
  companionMode?: CompanionMode
  companionPersonaId?: string
  parentStreamId?: string
  /**
   * Canonical id of the timeline item to anchor a thread on: `msg_…` (message)
   * or `event_…` (card). The one anchor track. Required for `type: "thread"`.
   */
  parentAnchorId?: string
  /**
   * Aside only: the conversation it was opened from (board card / conversation
   * panel). Must belong to `parentStreamId`.
   */
  conversationId?: string
  memberIds?: string[]
  /** Context bag attached to a new scratchpad (triggers summary pre-compute). */
  contextBag?: ContextBag
  /**
   * Tool-privacy policy to apply at creation (scratchpads only). Omitted =
   * unrestricted; an array (incl. `[]`) restricts the agent to those
   * categories. Persisted to `stream_policies` in the create transaction.
   */
  allowedToolCategories?: ToolPrivacyPolicy
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
  /**
   * Rich-text description as a ProseMirror document (canonical, INV-58). Internal
   * clients send this; the backend derives the markdown projection. An empty doc
   * clears the description. Prefer this over `description` from app code.
   */
  descriptionJson?: JSONContent
  /**
   * Markdown description. The external/public-API wire format — the backend
   * parses it to `descriptionJson`. Internal clients should send `descriptionJson`.
   */
  description?: string
  visibility?: Visibility
  companionMode?: CompanionMode
  companionPersonaId?: string
  memoryMode?: MemoryMode
  /**
   * Encrypted display name for an E2E stream — base64 ciphertext + its
   * `StreamEnvelope` framing (typed `unknown` to keep this package crypto-free).
   * Sent alongside the plaintext `displayName` on rename. Both halves travel
   * together (set), both `null` together (clear the sealed name when a rename
   * can't produce a fresh seal), or both omitted.
   */
  sealedNameCiphertext?: string | null
  sealedNameEnvelope?: unknown
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
  kind: ContextRefKind
  streamId: string
  /**
   * The conversation this ref points at, for `kind: "conversation"`. Null for
   * thread refs. Carried so the composer chip can key/label a conversation ref
   * distinctly from a thread ref on the same root stream.
   */
  conversationId: string | null
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
  /**
   * For a thread whose root stream is archived: the root's `archivedAt`
   * (ISO). Absent for non-threads and for threads whose root is active.
   * Archiving marks only the root row, so the thread itself stays "active"
   * and the client can't tell from the thread's own `archivedAt` that it
   * is sealed. The composer uses this to hide and the sidebar's workspace
   * bootstrap already excludes these threads (listWithPreviews), but a
   * deep link loads the thread via per-stream bootstrap — this field is
   * the reliable signal there, since the archived root is not in the
   * client's stream cache.
   */
  rootArchivedAt?: string | null
  botRuntimePresence?: Record<string, BotRuntimePresenceSummary | null>
  /** Complete slash-command list effective for this stream. Live backend returns this. */
  commands?: CommandInfo[]
  membership: StreamMember | null
  /**
   * The viewer's read frontier on this stream: the same data the workspace
   * bootstrap's `streamReadState` map carries for member streams, served
   * per-stream so access-without-membership viewers (INV-62 thread legs, public
   * roots never joined) resolve their frontier on open — the workspace bootstrap
   * stays member-keyed. `null` = no row (never read: frontier before the first
   * message, distinct from a row whose `lastReadEventId` is null — an explicit
   * mark-unread-to-zero). Optional: payloads cached before this field shipped
   * lack it.
   */
  readState?: StreamReadFrontier | null
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
  /**
   * Present on append-mode responses only: current thread state for every
   * thread parented in this stream. An append response carries only events
   * past the client's cursor, but thread patches (`thread:updated`) mutate
   * parent rows BEHIND the cursor and carry no broadcast sequence — a patch
   * missed live is invisible to gap detection and never re-fetched, so opening
   * the stream applies this map to heal stale thread cards. `threadSummary:
   * null` = thread exists but has no non-deleted replies.
   */
  threadStates?: Array<{
    /**
     * Canonical id of the timeline item the thread anchors on: `msg_…` for a
     * message, `event_…` for a card. The one anchor track — healing locates the
     * row to patch by this id (INV-2 prefix is the discriminator).
     */
    anchorId: string
    threadId: string
    replyCount: number
    threadSummary: ThreadSummary | null
  }>
  unreadCount: number
  /** Total message ordinal used with unreadCount to seed the per-stream counter model. */
  messageCount?: number
  mentionCount: number
  activityCount: number
  /**
   * Canonical slot envelope for cross-stream share-message pointers, keyed by
   * namespaced slot key (`shared:<messageId>`). Overlaid onto `ThreaSharedMessage`
   * nodes at render time so clients never read other streams' messages directly.
   */
  slots?: SlotMap
  /**
   * TEMPORARY legacy carrier (deploy-skew window): the same hydration values
   * keyed by bare source message id, for old clients that predate `slots`.
   * Removed with the D8 cleanup — do not add new readers.
   */
  sharedMessages?: Record<string, SharedMessageSlot>
  /**
   * Persisted ContextBag attached to this stream (if any). Optional on the
   * type so older bootstrap payloads cached in the workspace store don't
   * fail validation; the live backend always returns it as
   * `{bag: null, refs: []}` for streams without a bag.
   */
  contextBag?: StreamContextBagPayload
  /**
   * The scratchpad's tool-privacy policy: the tool categories its agent may use
   * (`null` = no restriction). Only populated for scratchpads — the only
   * surface that can set one; other stream types omit it. Drives the owner's
   * tool-policy control in stream settings. Optional so older cached bootstrap
   * payloads still validate.
   */
  allowedToolCategories?: ToolPrivacyPolicy
  /**
   * Which tool categories the owner's policy picker should offer for this
   * scratchpad: `web` and `workspace` are always present; `github` / `linear`
   * appear only when that integration is connected for the workspace. Scratchpad
   * bootstraps only; absent elsewhere (and on older cached payloads).
   */
  configuredToolCategories?: ToolPrivacyCategory[]
  /**
   * The one live call on this stream, if any (roadmap 1.4) — the INV-53 pair for
   * the timeline call card's live state and the reload rejoin bar. Absent when no
   * call is live; re-read on reconnect. Optional for older cached payloads.
   */
  activeCall?: StreamActiveCall | null
}

export interface EventsAroundResponse {
  events: StreamEvent[]
  hasOlder: boolean
  hasNewer: boolean
  /** Canonical slot envelope — see `StreamBootstrap.slots`. */
  slots?: SlotMap
  /** TEMPORARY legacy carrier (deploy-skew window) — see `StreamBootstrap.sharedMessages`. */
  sharedMessages?: Record<string, SharedMessageSlot>
}

/**
 * Response for jump-to-date (`?date=`). Same window shape as
 * `EventsAroundResponse` plus the message the client should scroll to: the
 * first message at or after the requested calendar instant. `null` when the
 * date is past the stream's last message (the client falls back to the live
 * tail).
 */
export interface EventsAroundDateResponse extends EventsAroundResponse {
  anchorMessageId: string | null
}

// Sync log catch-up — GET /api/workspaces/:workspaceId/sync

/**
 * One sync-log entry. `payload` is the exact outbox payload the live socket
 * emits for `eventType` — applying a catch-up entry reuses the same handler
 * the live event uses. `syncId` is a stringified BIGINT, like stream
 * sequences on the wire.
 */
export interface SyncCatchUpEntry {
  syncId: string
  eventType: string
  payload: unknown
  createdAt: string
}

/**
 * Catch-up page. Clients advance their cursor only by applied entries and
 * page until a fetch comes back empty — `head` is a workspace-global
 * freshness hint, NOT a cursor target: the per-user filtered view can sit
 * permanently below it. (Shadow mode, which applies nothing, deliberately
 * advances by fetched entries instead — see SyncEngine.performShadowCatchUp.)
 */
export interface SyncCatchUpResponse {
  entries: SyncCatchUpEntry[]
  head: string
  /**
   * Set when the client's `after` cursor is below the workspace's retained
   * sync-log floor (entries it would need have been pruned by retention).
   * The log can no longer heal the gap;
   * `entries` is empty and the client must fall back to a full bootstrap (the
   * authority for everything <= `head`). Absent/false on every in-window
   * request, so older clients that ignore the field simply never see it.
   */
  requiresBootstrap?: boolean
}

/**
 * Periodic `sync:heartbeat` socket payload: the workspace-global sync-log
 * head, broadcast to the workspace room so clients can detect a dropped emit
 * without waiting for a reconnect/resume trigger. Same head semantics as the
 * catch-up response: a freshness hint to compare against, never a cursor
 * target.
 */
export interface SyncHeartbeatPayload {
  workspaceId: string
  head: string
}

/**
 * Optional conversation directive on a message send. Omitted → the async
 * boundary-extractor infers the conversation (default). Present → the sender
 * declares it, and the send assigns it synchronously in the message's
 * transaction: `new` mints a fresh conversation seeded with the message;
 * `existing` attaches to `conversationId`; `threadFromMessage` attaches this
 * message (a thread's first reply) to the SAME `sourceConversationId` as a
 * cross-stream member, so one conversation spans the root opener + the thread
 * reply and the board card renders in place with no swap; `newSubtopic` mints a
 * fresh child conversation anchored to the message's (thread) stream — the
 * declared branch gesture from the board — attaching to the conversation already
 * anchored there when two users branch the same message concurrently. The id is a
 * sibling of the discriminant (not folded into one field) so a missing/garbage id
 * on `existing`/`threadFromMessage` is a validation error, distinct from `new`
 * and `newSubtopic`.
 *
 * `new` may carry a client-minted `conversationId`: the sender mints the id up
 * front (a `conv_` ULID, INV-2) so it can slot the board card the instant the
 * composer clears — rather than waiting for the send response to learn the
 * server-minted id — and the card reconciles by the SAME id when the echo lands.
 * Idempotent like `clientMessageId`: the send dedupes on that key before the
 * assigner runs, so a retried send inserts the conversation exactly once. Omit to
 * let the backend mint one (every non-board `new` caller does).
 */
export type ConversationDirective =
  | { intent: "new"; conversationId?: string }
  | { intent: "existing"; conversationId: string }
  | { intent: "threadFromMessage"; sourceConversationId: string }
  | { intent: "newSubtopic" }

/**
 * The causal horizon of one compose session: what the author could already have
 * seen when they started writing, and how far the stream had moved by the time
 * they sent. Carried as weighted signal for later classification — never read as
 * ground truth, and absent from every send by an old client, an API caller, a
 * scheduled send, or a flag-off workspace. Absence is normal, never an error.
 *
 * Sequences are `horizonStreamId`'s newest locally-synced global sequence at
 * each moment, `null` when the client had nothing synced yet.
 */
export interface ComposeTrace {
  /**
   * The stream both sequences were measured against — the surface the author was
   * reading. Sequences are per-stream, and a send can land somewhere else (a
   * board reply routed to another stream, a not-yet-created thread), so the
   * numbering is only interpretable against this id, never the message's stream.
   */
  horizonStreamId: string
  /** ISO timestamp of the moment the composer session started (focus while idle). */
  openedAt: string
  openedAtSequence: number | null
  sentAtSequence: number | null
  /** The composer already held non-empty draft content when the session started. */
  resumedDraft: boolean
}

/**
 * JSON input format - used by rich clients sending ProseMirror JSON directly.
 */
export interface CreateMessageInputJson {
  streamId: string
  /** ProseMirror JSON content from TipTap editor */
  contentJson: JSONContent
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** Persist this message first, then dispatch `/steer` in the same transaction. */
  steer?: true
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
  /** Declare the message's conversation (see {@link ConversationDirective}); omit to let the extractor infer. */
  conversation?: ConversationDirective
  /**
   * Set to `true` after the user has acknowledged that a share node in
   * `contentJson` would expose its source to people outside the source
   * stream. Required by the backend for shares that cross a privacy
   * boundary; sends without it return 409 + code
   * `SHARE_PRIVACY_CONFIRMATION_REQUIRED`.
   */
  confirmedPrivacyWarning?: boolean
  /** Compose-session provenance for this send (see {@link ComposeTrace}); omitted by clients that don't capture it. */
  composeTrace?: ComposeTrace
}

export interface CreateDmMessageInputJson {
  dmUserId: string
  /** ProseMirror JSON content from TipTap editor */
  contentJson: JSONContent
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
  /** Declare the message's conversation (see {@link ConversationDirective}); omit to let the extractor infer. */
  conversation?: ConversationDirective
  /** Same semantics as `CreateMessageInputJson.confirmedPrivacyWarning`. */
  confirmedPrivacyWarning?: boolean
  /** Compose-session provenance for this send (see {@link ComposeTrace}); omitted by clients that don't capture it. */
  composeTrace?: ComposeTrace
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
  /** Persist this message first, then dispatch `/steer` in the same transaction. */
  steer?: true
  /** External references as a flat string->string map. Keys under `threa.*` are reserved. */
  metadata?: Record<string, string>
  /** Compose-session provenance for this send (see {@link ComposeTrace}); omitted by clients that don't capture it. */
  composeTrace?: ComposeTrace
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
  /** Compose-session provenance for this send (see {@link ComposeTrace}); omitted by clients that don't capture it. */
  composeTrace?: ComposeTrace
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
  /**
   * E2E attachment ids to bind to this message. The bytes are opaque ciphertext
   * (`e2e_only` rows); their per-file keys + real metadata ride sealed inside
   * the message payload, never here. Omitted when the message has no files.
   */
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** Persist this message first, then dispatch `/steer` in the same transaction. */
  steer?: true
  /** Compose-session provenance for this send (see {@link ComposeTrace}); omitted by clients that don't capture it. */
  composeTrace?: ComposeTrace
}

/**
 * Union type - API accepts either JSON, Markdown, or E2E ciphertext input.
 * Backend detects format by presence of `contentJson` / `content` /
 * `ciphertext` field and gates each against the stream's E2E flag.
 */
export type CreateMessageInput = CreateMessageInputJson | CreateMessageInputMarkdown | CreateMessageInputE2e

/**
 * One HPKE wrap of a stream's per-stream symmetric key (SSK) to a single
 * recipient's long-term public key, for a given `keyGeneration`. The SSK
 * never leaves the client in plaintext; the server stores these opaque wrap
 * bytes (base64) and hands them back so a recipient can recover the SSK with
 * its private key. See @threa/crypto `wrapStreamKey` / `unwrapStreamKey`.
 */
export interface E2eKeyWrap {
  keyGeneration: number
  recipientKeyId: string
  recipientKind: E2eKeyWrapRecipientKind
  /** Base64 HPKE encapsulation (`StreamKeyWrap.enc`). */
  wrapEnc: string
  /** Base64 HPKE-wrapped SSK bytes (`StreamKeyWrap.ct`). */
  wrapCt: string
}

/**
 * The owner's initial SSK wrap (generation 0), POSTed right after E2E stream
 * creation. Its AAD binds to the server-minted stream id, which the client
 * only learns from the create response — so it can't ride along in the create
 * body. The recipient slot is the creator's UIK (`e2eOwnerKeyId`), derived
 * server-side, so only the opaque wrap bytes are needed on the wire.
 */
export interface E2eOwnerKeyWrapInput {
  wrapEnc: string
  wrapCt: string
}

/** Response for fetching a stream's SSK wraps (a device recovering the SSK). */
export interface E2eKeyWrapsResponse {
  /** Generation new messages currently seal under (`e2e_streams.current_key_generation`). */
  currentKeyGeneration: number
  /** All wrap rows for the stream. The caller selects the one matching its
   *  own `recipientKeyId` and the message's `keyGeneration`. */
  wraps: E2eKeyWrap[]
  /** The stream's E2E owner — only this user may revive actor wraps. */
  ownerUserId: string
  /**
   * Invited actors' currently-live keys (same shape an invite's key roll
   * carries). A live key with no `wraps` row at `currentKeyGeneration` is
   * stale — e.g. the enclave restarted with a fresh EIK after the invite —
   * and the owner's unlocked client heals it by re-wrapping the current SSK
   * to that key (`POST …/e2e/actor-key-wraps`).
   */
  liveActorRecipients: E2eKeyRollRecipient[]
}

/**
 * One recipient the client must HPKE-wrap the next SSK generation to during a
 * key roll: the owner's UIK is implicit (the client adds itself from session),
 * so this list carries the invited actors' currently-live keys — a bot's BIKs
 * and/or every live enclave EIK. `publicKey` is the raw X25519 key (base64).
 */
export interface E2eKeyRollRecipient {
  recipientKeyId: string
  recipientKind: E2eKeyWrapRecipientKind
  /** Raw X25519 public key, base64. */
  publicKey: string
}

/**
 * Instructions for rolling a stream's SSK forward after a recipient-set change.
 * The client mints a fresh SSK at `nextGeneration`, wraps it to itself plus
 * every `recipients` entry, and POSTs the batch (see `E2eKeyRollInput`). Null
 * on an invite when there is no live actor key to wrap to yet — the actor is
 * recorded and re-keyed once a key appears.
 */
export interface E2eKeyRoll {
  nextGeneration: number
  recipients: E2eKeyRollRecipient[]
}

/** Response to inviting an actor: the updated stream plus the roll the client must perform. */
export interface InviteActorResponse {
  stream: Stream
  keyRoll: E2eKeyRoll | null
}

/** One SSK wrap the client supplies during a roll. Bytes are opaque base64. */
export interface E2eKeyWrapInput {
  recipientKeyId: string
  recipientKind: E2eKeyWrapRecipientKind
  wrapEnc: string
  wrapCt: string
}

/**
 * Body for `POST …/e2e/key-generations`: the new generation plus a wrap of the
 * fresh SSK to every authorized recipient. The server stores the batch and
 * bumps `current_key_generation` to `keyGeneration` in one transaction, after
 * validating the generation is exactly `current + 1`, the owner's own wrap is
 * present (no self-lockout), and no wrap addresses an unauthorized key id.
 */
export interface E2eKeyRollInput {
  keyGeneration: number
  wraps: E2eKeyWrapInput[]
}

/**
 * Body for `POST …/e2e/actor-key-wraps`: re-wraps of already-granted SSK
 * generations to invited actors' live keys that are missing their wrap —
 * the revive path for an actor whose key changed after the invite (an
 * enclave restart mints a fresh EIK, orphaning every stream wrapped to the
 * old one). Unlike a key roll, no fresh SSK is minted and the generation
 * does not advance: the actor was already granted these generations, so
 * re-addressing the same keys to its new instance preserves exactly the
 * prior access — and keeps a pending turn decryptable, which a roll would
 * strand. The top-level `keyGeneration` must equal the stream's current
 * generation (the client's freshness assertion); each wrap defaults to it.
 * A wrap may name an older generation only for the enclave actor (a
 * singleton, so any prior enclave wrap at that generation proves the actor
 * held it) — re-wrapping every generation the owner can open is what
 * un-strands a parked turn, sealed history, and turn digests after an
 * enclave restart that follows a key roll (E2EE-7). Recipients must be
 * live keys of currently-invited actors (never `user` wraps).
 */
export interface E2eActorRewrapInput {
  keyGeneration: number
  wraps: (E2eKeyWrapInput & { keyGeneration?: number })[]
}

// ============================================================================
// Enclave turn contract (enclave pulls assignments via the claim endpoint and
// reports back over the session callbacks)
// ============================================================================

/**
 * Message framing for SSK-sealed content on the enclave wire. Deliberately a
 * field-for-field mirror of `@threa/crypto`'s `StreamEnvelope` (`v`,
 * `keyGeneration`, `iv`, `aad`): `@threa/types` stays dependency-free, so it
 * doesn't pull `@threa/crypto` (and `@hpke/core`) into every consumer
 * (frontend, control-plane, …) just to share four fields. The two are bridged
 * by structural typing where the enclave hands these to `openMessage`/
 * `sealMessage`; if `StreamEnvelope` ever gains a required field, that handoff
 * fails to compile in `invoke.ts` (CI-caught) rather than diverging silently.
 */
export interface EnclaveStreamEnvelope {
  v: number
  keyGeneration: number
  iv: string
  aad: string
}

/** One SSK-sealed message: base64 ciphertext + its envelope. */
export interface EnclaveSealedMessage {
  ciphertext: string
  envelope: EnclaveStreamEnvelope
}

/** An SSK wrap addressed to the enclave's EIK, so it can recover that generation's key. */
export interface EnclaveSskWrap {
  keyGeneration: number
  wrapEnc: string
  wrapCt: string
}

/**
 * One sealed reply a sealed-capable agent driver produced this turn — the
 * enclave today, any owner-granted sealed actor later — streamed back to
 * `POST .../sessions/:id/messages` the moment the agent loop sends it (so an
 * interim "I'll look into it" lands before the final answer, not batched at the
 * end). Part of the shared sealed vocabulary, not enclave-owned: nothing in the
 * shape is enclave-specific, and consumers must never branch on "is this the
 * enclave" — the stream is the axis. The producer mints each reply's id (a
 * `msg_…` ULID) and binds it into the seal AAD (`streamId|messageId|senderId`);
 * the backend stores the ciphertext under that same id. Citation sources ride
 * INSIDE the ciphertext (the sealed payload wrapper, `@threa/crypto`'s
 * `serializeSealedPayload`) — they reveal what was researched, so they must
 * never appear as a cleartext column or wire field (E2EE-9).
 */
export interface SealedReply {
  messageId: string
  ciphertext: string
  envelope: EnclaveStreamEnvelope
}

/**
 * The sealed turn completion an owner-granted bot harness POSTs to
 * `POST .../bot-invocations/:invocationId/sealed-complete` — the external sibling
 * of the enclave's `/complete` and the sealed variant of the plaintext bot
 * complete. Carries the turn's final sealed reply (ciphertext the server can't
 * read, INV-E7) or `noResponse` when the turn produced none. Unlike the enclave —
 * which streams each reply to `/messages` and sends `/complete` as a bare ack —
 * the bot path delivers its single reply inline here, mirroring the plaintext
 * bot complete. Auth is the bot API key + the per-claim callback token in
 * `X-Threa-Callback-Token`, never body claim fields.
 */
export interface SealedComplete {
  reply?: SealedReply
  noResponse?: boolean
}

/**
 * The sealed rolling conversation summary (C-2) the enclave folded at turn end,
 * POSTed to `POST .../sessions/:id/sealed-summary`. The server can't read message
 * content, so it can't summarize an encrypted scratchpad — the enclave (which
 * sees plaintext) folds the messages that overflowed the verbatim window into the
 * prior summary, seals the result under the stream SSK bound by AAD to
 * `streamId|summary|generation` (`buildSummaryAad` — a slot disjoint from the
 * sealed name `…|name|…` and the message body `streamId|messageId|senderId`, so a
 * malicious server can't relocate a summary onto another stream or swap it for a
 * name/message), and the backend stores the ciphertext on
 * `agent_conversation_summaries`. No `messageId`: a summary is a single
 * per-(stream, persona) slot, not a message. `lastSummarizedSequence` is the
 * advanced cursor as a base-10 string — non-secret metadata (a message sequence)
 * that gates the row's monotonic update so concurrent/redelivered folds can't
 * regress it.
 */
export interface EnclaveSealedSummary {
  ciphertext: string
  envelope: EnclaveStreamEnvelope
  lastSummarizedSequence: string
}

/**
 * One sealed trace step a sealed-capable agent driver produced this turn — the
 * enclave today, any owner-granted sealed actor later — POSTed to
 * `POST .../sessions/:id/steps` the moment the agent loop emits it (the LLM's
 * reasoning, each reply it sends, …). Part of the shared sealed vocabulary,
 * not enclave-owned. Only the step's *type*, optional reply link, and timing
 * travel in clear; the step's content (reasoning text, message body, and —
 * when tools land — their args/output) is sealed under the reply SSK, bound by
 * AAD to `streamId|stepId|senderId`, so the backend persists ciphertext it
 * can't read (INV-E7). A step's citation sources ride INSIDE the ciphertext
 * (the sealed payload wrapper, `@threa/crypto`'s `serializeSealedPayload`) —
 * they reveal what was researched, so they must never appear as a cleartext
 * column or wire field (E2EE-14). The producer mints each step's id (a
 * `step_…` ULID) and the backend stores the ciphertext under it; the browser
 * decrypts it with the stream key, exactly as it does message ciphertext.
 */
export interface SealedStep {
  stepId: string
  stepType: AgentStepType
  /**
   * For message_sent/message_edited steps: the reply id this step describes.
   * Clear — it's already a `sent_message_ids` entry and only links the trace
   * step to its message row (the message body itself is sealed separately).
   */
  messageId?: string
  ciphertext: string
  envelope: EnclaveStreamEnvelope
  /** Wall-clock the step took, so the backend derives started/completed without a second round-trip. */
  durationMs?: number
}

/**
 * One sealed trace step *start* — emitted the moment the agent loop opens a step
 * (the LLM's reasoning, a tool call, a reply), mirroring the unencrypted runtime's
 * `tool:start`/`startStep`. It lets an open trace dialog render the in-flight step
 * (and hang its live substeps under it) before completion, exactly as it does for
 * non-E2E personas. `stepType` + `stepId` travel in clear; content is sealed under
 * the reply SSK when it's already known (reasoning/reply text) and absent for tools
 * whose result isn't known yet. A matching `SealedStep` finalizes the same
 * `stepId` in place when the step completes.
 */
export interface SealedStepStart {
  stepId: string
  stepType: AgentStepType
  /** For message_sent steps: the reply id this step describes (clear, same as the finalize). */
  messageId?: string
  /** Sealed content when known at start (reasoning/reply); absent for tools (no result yet). */
  ciphertext?: string
  envelope?: EnclaveStreamEnvelope
}

/**
 * One sealed *substep* — the ephemeral mid-run phase text a tool emits (e.g. the
 * research sub-agent's "Searching the web: …" / "Reading …"). Because that text
 * is derived from the user's encrypted prompt it is sealed under the SSK exactly
 * like a step; the backend relays the ciphertext and the owner's browser
 * decrypts it. Never persisted — it drives the live "Ariadne is …" indicator.
 */
export interface EnclaveSealedSubstep {
  /** The step type this substep belongs to (clear metadata, same as steps). */
  stepType: AgentStepType
  /** The single new phase text, sealed — drives the live "Ariadne is …" indicator (ephemeral). */
  ciphertext: string
  envelope: EnclaveStreamEnvelope
  /**
   * The in-flight step this substep belongs to. Present once the step has been
   * opened (tool:start); lets the backend persist the running snapshot onto that
   * row so a refresh / opening the trace mid-run replays the phases so far —
   * mirroring the unencrypted `ActiveStep.updateSubsteps`.
   */
  stepId?: string
  /**
   * The running `{ substeps: [{ text, at }] }` snapshot, sealed as a JSON string
   * exactly like a step's content. Persisted (not just broadcast) onto the step
   * row so the trace recovers the full phase timeline on refresh; the owner's
   * browser decrypts it the same way it decrypts step content (INV-E7).
   */
  snapshotCiphertext?: string
  snapshotEnvelope?: EnclaveStreamEnvelope
}

/**
 * The work the backend hands a live enclave as the body of a winning claim
 * (`POST /internal/enclave-runtimes/claims`, 200). The backend never decrypts:
 * it ships ciphertext + the wraps addressed to the claiming EIK plus the
 * `sessionId` it created the `agent_sessions` row under. The enclave runs the
 * agent loop asynchronously after the claim — unwrapping, opening, sealing each
 * reply — and reports progress/completion back over the session callbacks
 * (heartbeat, complete/fail). `system` is the persona's (non-secret) prompt;
 * `reply` carries the generation each reply is sealed under + Ariadne's sender
 * id the replies are bound to.
 */
export interface EnclaveSessionAssignment {
  sessionId: string
  streamId: string
  /**
   * Claim-minted secret binding this session's callbacks to the runner that
   * claimed the turn (Phase 2.4b, E2EE-21; §2.7 transfers it onto the claim).
   * Delivered only inside this claim response and echoed on every session
   * callback (`ENCLAVE_CALLBACK_TOKEN_HEADER`); the backend rejects a
   * mismatch or an absent token, so the field is required — an assignment
   * without it could never complete a single callback.
   */
  callbackToken: string
  wraps: EnclaveSskWrap[]
  /**
   * Prior turns, oldest→newest. `sequence` is the message's stream sequence as a
   * base-10 string — non-secret metadata (the interjection pull already ships it
   * in clear) the enclave needs to advance the rolling summary's
   * `last_summarized_sequence` cursor over the messages that overflow the
   * verbatim window (C-2). `role` tells the model who spoke.
   */
  history: (EnclaveSealedMessage & { role: "user" | "assistant"; sequence: string })[]
  prompt: EnclaveSealedMessage
  /**
   * The stable half of Ariadne's system prompt — everything that holds for the
   * conversation's lifetime. This is what the enclave's prompt-cache breakpoint
   * covers, so it must not carry per-turn content.
   */
  system: string
  /**
   * The per-turn half of the prompt as the BACKEND derives it — temporal
   * grounding and invocation purpose. Kept separate so it lands after the cache
   * breakpoint: inside it, the cached prefix would change every turn and
   * nothing would be reused. Absent when a turn has no per-turn content.
   *
   * The enclave appends its own per-turn sections (rolling conversation
   * summary, prior-turn digests) to this half locally; they are never shipped
   * here, since only the enclave can decrypt them.
   */
  systemVolatile?: string
  model: string
  temperature?: number
  maxTokens?: number
  reply: { keyGeneration: number; senderId: string }
  /**
   * Non-secret metadata about the triggering message, so the enclave can emit the
   * same "Triggered by" CONTEXT trace step the in-process orchestration layer does
   * (`persona-agent` → CONTEXT_RECEIVED). The step's *content* is the message body
   * — the decrypted prompt — which the enclave seals under the SSK like any step;
   * only this id/author/time metadata travels in the clear. Omitted → no context
   * step (e.g. a turn with no resolvable trigger author).
   */
  trigger?: { messageId: string; authorName: string; authorType: AuthorType; createdAt: string }
  /**
   * Per-stream tool-privacy policy: the tool categories the enclave may use this
   * turn. Omitted means no restriction (today's behavior). Present (even `[]`)
   * restricts the agent to exactly those categories — the enclave currently only
   * builds web tools, so in practice this gates whether web egress is allowed at
   * all. `messaging` (replies) is always allowed regardless.
   */
  allowedToolCategories?: ToolPrivacyCategory[]
  /**
   * Opaque ciphertext for the conversation's attachments (the trigger's plus
   * recent history's, budget-bounded newest-first), shipped INLINE so the
   * enclave can read files without widening its egress to S3 (it stays pinned
   * to the backend + OpenRouter). The backend can't read the per-file keys —
   * they're sealed inside the messages — so it ships every E2E attachment row
   * bound to those messages; the enclave matches `attachmentId` to the
   * decrypted `attachmentRefs`, decrypts with the sealed key/iv, and feeds the
   * trigger's files to the (vision/PDF-capable) model eagerly while history
   * files load on demand via its `read_attachment` tool. Omitted when there
   * are none.
   */
  attachmentCiphertexts?: { attachmentId: string; ciphertext: string }[]
  /**
   * Revision-fenced dynamic naming work reserved for this exact session. Opaque
   * title bytes are opened only in the enclave; the backend never sees plaintext.
   */
  naming?: import("./enclave-naming").EnclaveNamingInstruction
  /**
   * Sealed `turn_digest` step contents from this stream's recent completed
   * sessions, oldest→newest (C-1: carry tool work forward). The backend ships
   * the opaque ciphertext it already persisted via `/steps`; the enclave — which
   * holds the SSK wraps — opens each digest it can (skipping generations it has
   * no wrap for), and folds them into the turn's system context so follow-ups
   * don't force a re-search. `completedAt` is clear timing metadata (the step
   * row already exposes it), so the model can judge staleness; the digest body
   * never leaves ciphertext on the backend (INV-E7).
   */
  recentDigests?: (EnclaveSealedMessage & { completedAt: string })[]
  /**
   * Char budget for the verbatim conversation window (C-2; the companion's
   * `ContextWindowPolicy.maxChars`, default 80k). The enclave fills its decrypted
   * history newest-first up to this budget; messages that overflow are folded
   * into the rolling summary. Omitted → the enclave keeps its whole shipped
   * window verbatim (no fold), today's behavior.
   */
  maxChars?: number
  /**
   * The stream's prior sealed rolling summary (C-2), if one exists — the opaque
   * ciphertext the enclave sealed on an earlier turn. The enclave opens it with
   * the SSK wrap for its generation (skipped if it has none, like history), folds
   * the newly-overflowed messages into it, and re-seals the result. The backend
   * never reads it (INV-E7). Omitted → start a fresh summary.
   */
  priorSummary?: EnclaveSealedMessage
  /**
   * The prior summary's `last_summarized_sequence` cursor, base-10 — the highest
   * message sequence already folded into `priorSummary`. The enclave only folds
   * history newer than this, so a message is never summarized twice; it advances
   * the cursor and reports the new value on the sealed-summary callback. Absent
   * when there is no prior summary (fold from the start of the shipped window).
   */
  summaryCursor?: string
}

/**
 * The sealed work handed to an owner-granted *external* sealed runner (a
 * third-party / self-hosted bot harness) as the body of a winning claim, when
 * the delivery verdict resolves to `sealed` (`resolveDeliveryVerdict`). It is the
 * external sibling of {@link EnclaveSessionAssignment} and §2.6's `SealedTurnContext`:
 * the shared shape any sealed-capable driver consumes, deliberately NOT
 * enclave-named so the bot path reuses it without re-prefixing the vocabulary.
 *
 * It is **leaner than the enclave assignment on purpose**: an external harness
 * runs its OWN agent loop (its own model, system prompt, sampling), so the
 * server ships only the material the bot can't derive — the SSK `wraps` addressed
 * to the claiming bot's BIK, the sealed `history`/`prompt` ciphertext, the
 * `reply` generation + sender id each seal binds to, and the per-claim
 * `callbackToken` (model A) that authorizes the sealed callbacks. It omits the
 * enclave's `system`/`model`/`temperature`/`maxTokens` (the bot owns those) and,
 * for now, the C-1/C-2 continuity fields (`recentDigests`, `priorSummary`, …) and
 * attachments — additive later, kept out per INV-36 until the harness consumes them.
 *
 * The backend never decrypts: it ships ciphertext the owner sealed under the
 * stream SSK and the wraps for the claiming BIK. The bot unwraps the SSK with its
 * identity private key, opens history/prompt, runs its turn, and seals each
 * reply/step back under the same SSK — exactly as the enclave does.
 */
export interface SealedTurnContext {
  /**
   * Per-claim secret binding this turn's sealed callbacks to the bot instance
   * that won the claim (model A, mirroring {@link EnclaveSessionAssignment.callbackToken}).
   * Delivered only inside this claim response and echoed on every sealed
   * `/steps`/`/complete` callback; the backend rejects a mismatch or absent
   * token. A sealed turn carries the owner's plaintext, so this is what stops a
   * leaked workspace bot key alone from hijacking another in-flight session's
   * callbacks (the E2EE-21/22 class).
   */
  callbackToken: string
  /**
   * SSK wraps addressed to the claiming bot's BIK, covering the reply (current)
   * and trigger generations — the same pair the claim predicate verified, so the
   * bot can open both the history it's handed and seal its reply under the
   * current generation.
   */
  wraps: EnclaveSskWrap[]
  /** Prior turns, oldest→newest; `role` tells the model who spoke, `sequence` is clear metadata. */
  history: (EnclaveSealedMessage & { role: "user" | "assistant"; sequence: string })[]
  /** The sealed trigger message — the bot opens it to get its instructions. */
  prompt: EnclaveSealedMessage
  /** The generation every reply/step must seal under, plus the bot's sender id (bound into the seal AAD). */
  reply: { keyGeneration: number; senderId: string }
  /**
   * Non-secret trigger metadata, so the bot can emit the same "Triggered by"
   * context step the enclave does. The body (decrypted prompt) is sealed
   * separately as the step content; only id/author/time travel in clear.
   * Omitted when there is no resolvable trigger author.
   */
  trigger?: { messageId: string; authorName: string; authorType: AuthorType; createdAt: string }
}

/**
 * The completion ack, posted to `POST .../sessions/:id/complete` after the loop
 * finishes. The replies themselves were already streamed via `.../messages`, so
 * this carries only the ids the enclave sent (oldest→newest, for the session's
 * `sent_message_ids`) plus non-secret model metadata. Usage is summed across
 * every model call the loop made.
 *
 * `usage` is aggregate accounting (token counts + the provider's billed `cost`
 * in USD) — never message content — so it travels as plain JSON like the model
 * id, and the backend records it against the workspace/user at completion.
 */
export interface EnclaveSessionResult {
  messageIds: string[]
  model: string
  usage?: { promptTokens?: number; completionTokens?: number; cost?: number }
  /**
   * The highest stream sequence the turn's loop incorporated, as a base-10
   * bigint string (UX-12 interjection poll). The loop seeds its boundary at the
   * trigger and advances it each time the mid-turn pull (`GET .../messages`)
   * hands it a newer message; reporting the final value lets the backend's
   * post-completion catch-up skip a message the reply already addressed instead
   * of re-triggering a redundant turn for it. Omitted (or ≤ the trigger's
   * sequence) means the turn incorporated nothing past its trigger — the catch-up
   * then falls back to the trigger boundary, exactly as before the poll existed.
   */
  lastProcessedSequence?: string
}

/**
 * The failure ack, posted to `POST .../sessions/:id/fail` when the enclave's turn
 * loop throws. Carries only a scrubbed error *classification* — never plaintext
 * content. The loop runs after the prompt/history are decrypted, so the raw error
 * could carry payload bytes; the enclave sends just the thrown error's class name
 * (e.g. `"AbortError"`). The backend maps it onto the session's failure lifecycle
 * (`failSessionWithLifecycle`), terminating the session promptly instead of
 * waiting for orphan-cleanup's stale-heartbeat backstop.
 */
export interface EnclaveSessionFailure {
  errorName: string
}

/**
 * Response of `POST /internal/enclave-runtimes/claims` when a turn was won
 * (the no-work case is a bodyless 204). The enclave presents its EIK key id;
 * the backend claims the oldest invocation that key can actually serve (its
 * wraps cover the prompt's and the reply's key generations), builds the
 * assignment for it, and hands it over. Possession of the embedded
 * `callbackToken` is what authorizes the session callbacks — the claim is
 * the handoff.
 */
export interface EnclaveClaimResponse {
  assignment: EnclaveSessionAssignment
}

/**
 * Response of the per-session heartbeat callback. Cancellation rides the
 * pull channel: `abort: true` means a user requested "Stop research" for
 * this session, and the enclave should trip the turn's AbortController (the
 * graceful research abort — partial findings, the turn still replies). The
 * enclave has no inbound routes, so this piggybacked flag replaces the old
 * `POST /sessions/:id/cancel` push.
 */
export interface EnclaveSessionHeartbeatResponse {
  abort: boolean
}

/**
 * One message that landed mid-turn, handed back over the enclave's interjection
 * pull (`GET .../sessions/:id/messages?after=<seq>`, UX-12). The body is sealed —
 * ciphertext + envelope, opened with the SSK the enclave already holds from the
 * assignment's wraps, so no new key machinery is involved; only the routing
 * metadata travels in clear. The sequence is a base-10 bigint string (per-stream
 * sequences are bigints), so the enclave's loop can advance its "seen up to here"
 * boundary and report the final value at `/complete`. The author's display name
 * is non-secret (it already rides the assignment's trigger metadata), and lets
 * the enclave render the same "new context arrived" trace the in-process
 * companion does. Only newly created messages are reported — a mid-turn edit or
 * delete of an older row isn't an interjection, and the next turn re-reads the
 * settled history anyway.
 */
export interface EnclaveMidTurnMessage {
  messageId: string
  sequence: string
  authorId: string
  authorType: AuthorType
  authorName: string
  createdAt: string
  ciphertext: string
  envelope: EnclaveStreamEnvelope
}

/**
 * Response of the enclave's interjection pull (`GET .../sessions/:id/messages`):
 * the sealed messages that arrived after the requested sequence, oldest→newest,
 * with the session's own persona replies excluded (the enclave must not re-inject
 * its own output). An empty array means nothing landed since the last poll.
 */
export interface EnclaveMidTurnMessagesResponse {
  messages: EnclaveMidTurnMessage[]
}

export type CreateDmMessageInput = CreateDmMessageInputJson | CreateDmMessageInputMarkdown

/**
 * JSON input format for updates.
 */
export interface UpdateMessageInputJson {
  contentJson: JSONContent
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
  /**
   * Present only on the SOURCE-side tombstone: the `broadcastSequence`
   * values the relocated events vacated in the source stream. Moving is the
   * one operation that removes rows from a stream's otherwise-dense
   * broadcast chain (INV-61); the tombstone — whose own broadcastSequence is
   * always above every vacated slot, so any window that can see the hole
   * also contains the tombstone — declares those slots accounted-for so
   * clients don't mistake them for missed messages and render phantom
   * loading placeholders.
   */
  vacatedBroadcastSequences?: string[]
}

/**
 * One memo's worth of provenance inside a `memos:captured` event — enough
 * to render the capture row and deep-link without fetching the memo.
 */
export interface CapturedMemoSummary {
  memoId: string
  title: string
  knowledgeType: KnowledgeType
  /** The exact messages this memo was derived from. */
  sourceMessageIds: string[]
}

/**
 * Payload for `memos:captured` timeline events (INV-69): appended to the
 * source stream when GAM extracts memos from one of its conversations, in
 * the same transaction as the memo rows. The event lands at the broadcast
 * position where extraction completed — per-stream debouncing means that is
 * normally just after the conversation that produced it — and carries the
 * source conversation/message ids so the row can point back at the messages
 * the knowledge came from.
 *
 * `conversationId` is omitted for an agent-authored memo (`save_memo`, roadmap
 * 6.2): that capture is message-sourced with no owning conversation, so the row
 * links back through `memos[].sourceMessageIds` alone. The board's
 * source-conversation grouping already treats it as optional.
 */
export interface MemosCapturedEventPayload {
  conversationId?: string
  memos: CapturedMemoSummary[]
}

/**
 * Payload for `agent:follow_up_scheduled` timeline events (roadmap 1.3):
 * appended to a stream when a persona schedules a follow-up, in the same
 * transaction as the `agent_follow_ups` row insert (INV-4/7). The card renders
 * the note + fire time and offers a Cancel action without fetching the row, so
 * scheduled agent work is never invisible state. `scheduledFor` is the ISO
 * instant the follow-up fires; the UI renders it in the viewer's local time.
 */
export interface AgentFollowUpScheduledEventPayload {
  followUpId: string
  note: string
  scheduledFor: string
  /** The topic the follow-up is anchored to, when the trigger had one. */
  sourceConversationId: string | null
}

/**
 * Payload for `agent:follow_up_cancelled` events (roadmap 1.3): appended when a
 * pending follow-up is cancelled — by the persona via `cancel_follow_up`, or by
 * a stream member via the card's Cancel button — in the same transaction as the
 * CAS. This is a patch, not a visible row: it carries only the `followUpId` so
 * the matching `agent:follow_up_scheduled` card flips to "Cancelled" (see
 * `collectCancelledFollowUpIds`). The event's `actorId`/`actorType` record who
 * cancelled.
 */
export interface AgentFollowUpCancelledEventPayload {
  followUpId: string
}

/**
 * Payload for `delegation:created` timeline events (roadmap 5.1): appended when
 * an agent (or, later, a person) compiles a hand-off for the user's local agent,
 * in the same transaction as the `delegated_tasks` row insert (INV-4/7). The
 * card renders — and "Copy prompt" assembles — entirely from this payload, so
 * the day-one zero-tooling hand-off needs no extra fetch. `title`/`brief`/
 * `contextRefs` are snapshots: a delegation's content is immutable after
 * creation (only its status moves), so they cannot go stale.
 */
export interface DelegationCreatedEventPayload {
  delegationId: string
  title: string
  /** The compiled, self-contained hand-off prompt (markdown). */
  brief: string
  /** Pointer URLs (`shared-message:`/`memo:`/`attachment:`) into the workspace. */
  contextRefs: string[]
  /** The topic the delegation is anchored to, when the trigger had one. */
  sourceConversationId: string | null
}

/**
 * Payload for `delegation:status_changed` events (roadmap 5.1): appended in the
 * same transaction as every status CAS so the card can never sit on stale state.
 * This is a patch, not a visible row: the matching `delegation:created` card
 * advances to `status`. One payload type carries every transition; the optional
 * fields are populated when the transition supplies them (`claimedByLabel` on
 * claim, `resultMessageId` on completion, `statusNote` on running/failed). The
 * event's `actorId`/`actorType` record who drove the transition.
 */
export interface DelegationStatusChangedEventPayload {
  delegationId: string
  status: DelegationStatus
  /** Why a delegation became open again. */
  reason?: DelegationReopenReason
  /** Free-text label for the claiming agent, e.g. "Kris's MacBook / Claude Code". */
  claimedByLabel?: string | null
  /** The stream message the completing agent posted its result as. */
  resultMessageId?: string | null
  /**
   * The thread stream the completing agent's result was posted into, anchored
   * on the delegation card itself. Present on completions that carried a result
   * (the card opens this thread for "View result", zero-fetch). Absent on
   * legacy completions, whose `resultMessageId` points at a synthetic anchor
   * message the card deep-links via `?m=` instead.
   */
  threadStreamId?: string | null
  /** Free-text progress/error note from the executing agent. */
  statusNote?: string | null
}

/**
 * Payload for `call_started` timeline events (roadmap 1.4): appended in the same
 * transaction as the call row insert (INV-4/7) when a call is first created on a
 * stream. Renders the live call card. Liveness DEFAULTS DEAD — the card only
 * renders live when the client's active-calls cache confirms a live call with
 * this `callId` (a stale live card with a Join button on a dead call is an
 * interactive lie); the ticking duration derives from `startedAt`.
 */
export interface CallStartedEventPayload {
  callId: string
  mode: "video" | "audio_only"
  /** UserId of the participant who started the call. */
  startedBy: string
  /** ISO start instant, for the self-ticking duration leaf while live. */
  startedAt: string
}

/**
 * Payload for `call_ended` events (roadmap 1.4): appended in the same transaction
 * as the `active|empty_grace → ended` transition. A patch, not a visible row: it
 * carries the whole end SUMMARY so the matching `call_started` card renders its
 * historical state with zero fetch (the delegation-pattern point). `endedReason`
 * distinguishes a normal hang-up (`completed`) from a lease-reap (`reaped`).
 */
export interface CallEndedEventPayload {
  callId: string
  durationMs: number
  /** Distinct UserIds of everyone who was ever a participant, for the ended card's avatars. */
  participantUserIds: string[]
  endedReason: "completed" | "reaped"
}

/**
 * Payload for `bot_access:requested` timeline events (F3): appended when a bot
 * runtime that received the workspace-wide `delegation:available` nudge but lacks
 * stream access files a request, in the same transaction as the
 * `bot_access_requests` row insert (INV-4/7). The card renders entirely from this
 * payload: `botName`/`delegationTitle` are SNAPSHOTS because a non-member
 * approver cannot resolve an ungranted personal bot (bot visibility is
 * grant-based), so the card must not depend on the roster.
 */
export interface BotAccessRequestedEventPayload {
  requestId: string
  botId: string
  /** Bot display name, snapshot at request time (roster-independent). */
  botName: string
  /** The delegation the bot is trying to claim, when the request carries one. */
  delegationId?: string
  /** Delegation title, snapshot at request time. */
  delegationTitle?: string
  /** The runner's human-readable label, e.g. "Kris's MacBook". */
  requestedByLabel?: string
}

/**
 * Payload for `bot_access:status_changed` events (F3): appended in the same
 * transaction as the approve/deny CAS so the request card can never sit on stale
 * state. This is a patch, not a visible row: the matching `bot_access:requested`
 * card advances to `status`. `delegationId`/`delegationTitle` are duplicated from
 * the request so the broadcast-handler re-nudge branch (approved + delegation →
 * re-emit `delegation:available`) needs no DB read.
 */
export interface BotAccessStatusChangedEventPayload {
  requestId: string
  status: "approved" | "denied"
  /** The user who approved or denied. */
  resolvedBy?: string
  delegationId?: string
  delegationTitle?: string
}

/**
 * A member-facing snapshot of a delegation for list surfaces (the "In this
 * stream" panel). Statuses live in `delegation:status_changed` patch events, so
 * a view derived from the loaded timeline window would freeze out-of-window
 * delegations on stale status — this shape is served by the authoritative
 * `GET /delegations?streamId=` read instead. Excludes the brief (the card
 * carries it) and everything claim-related beyond the display label.
 */
export interface DelegationSummary {
  id: string
  streamId: string
  title: string
  status: DelegationStatus
  claimedByLabel: string | null
  resultMessageId: string | null
  statusNote: string | null
  /** The `delegation:created` timeline event, for deep-linking the card row. */
  createdEventId: string | null
  createdAt: string
  statusChangedAt: string
}

export interface ListDelegationsResponse {
  delegations: DelegationSummary[]
}

/**
 * Payload for `description_set` timeline events: appended to a stream when an
 * actor sets, changes, or clears its description, in the same transaction as the
 * description write. Carries the markdown snapshot at the time it was set so the
 * row renders the body with the normal message-markdown pipeline without a fetch
 * (a point-in-time snapshot, like `message_created` carries the message body).
 * The acting user is the event's `actorId`/`actorType`. `null` means the
 * description was cleared ("X cleared the description").
 */
export interface DescriptionSetEventPayload {
  descriptionMarkdown: string | null
}

/**
 * Payload for `brief_updated` timeline events (roadmap 4.2): appended when a
 * stream's durable brief is written — by a persona via `update_stream_brief`, or
 * by a member via the settings editor — in the same transaction as the brief
 * write (INV-4/7). Brief changes are never silent (INV-69 spirit): the row names
 * who changed it (the event's `actorId`/`actorType`), the resulting `version`,
 * and, for a persona write, the `reason` it gave. `version === 1` marks the
 * brief's creation ("created" vs "updated"); `reason` is `null` for member edits
 * (the editor collects no reason). The current content is one fetch away via the
 * brief endpoint, so it is deliberately not snapshotted onto every event.
 */
export interface BriefUpdatedEventPayload {
  briefId: string
  version: number
  reason: string | null
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

export interface CreateWorkspaceInput {
  name: string
  slug?: string
  region?: string
  /**
   * The creator's IANA timezone, used to seed the workspace's `billingTimezone`
   * — the boundary its AI spend month is cut on. Optional: a caller that cannot
   * report one (control-plane provisioning) leaves the workspace on the "UTC"
   * default until an admin sets it.
   */
  timezone?: string
}

export interface EmojiEntry {
  shortcode: string
  emoji: string
  type: "native" | "custom"
  group: string
  order: number
  /** All shortcodes including aliases (for search matching) */
  aliases: string[]
  /**
   * Search-only synonyms (CLDR annotation tags — "sad", "unhappy", "tear").
   * Unlike aliases these are shared across emoji, so they never resolve a
   * `:shortcode:`. Optional on the wire: a client reading a cached emoji list
   * written before keywords shipped sees entries without it.
   */
  keywords?: string[]
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
  /** Omitted defaults to "server" (backwards compat). */
  kind?: CommandKind
  /** Workspace commands are globally known; stream commands depend on active stream context. */
  scope?: CommandScope
  /** For `kind: "client-action"`, the stable id the frontend dispatches on. */
  clientActionId?: string
  /** Optional first-pass argument metadata. UI can ignore this until argument autocomplete exists. */
  args?: CommandArgumentInfo[]
}

// ── Giphy ───────────────────────────────────────────────────────────────
// Contract for the `/giphy` picker. The backend proxies Giphy so the API key
// stays server-side; these shapes are the wire format between the two.

export interface GiphyGif {
  /** Giphy's stable id; the byte proxy re-resolves the canonical media URL from it server-side. */
  id: string
  title: string
  /** Preview rendition rendered in the picker grid (served directly from Giphy's CDN). */
  previewUrl: string
  /** Intrinsic pixel size of the preview rendition, so the masonry grid lays out without reflow. */
  width: number
  height: number
}

export interface GiphySearchResponse {
  items: GiphyGif[]
  /** Offset to request for the next page, or null when the result set is exhausted. */
  nextOffset: number | null
}

export interface GiphyConfigResponse {
  /** True when the backend has a Giphy API key configured (feature stays dark otherwise). */
  enabled: boolean
}

/**
 * The viewer's read frontier for one stream (sourced from `stream_read_state`).
 * Row PRESENCE is authoritative — a null `lastReadEventId` is an explicit
 * "position before the first message" frontier, distinct from an absent entry
 * (never read).
 */
export interface StreamReadFrontier {
  lastReadEventId: string | null
  /** The watermark event's per-stream sequence (stringified bigint); null when the watermark is unset or dangling. */
  lastReadSequence: string | null
  lastReadAt: string | null
}

/**
 * The canonical post-write read frontier for one stream, carried additively by
 * mark-all-read (both the HTTP response and the `stream:read_all` outbox
 * payload). Extends the bootstrap `StreamReadFrontier` with the stream id and
 * the absolute message ordinal so a client can advance its standalone watermark
 * AND its counter from one snapshot. Sourced from the post-write standalone
 * read state — never a membership fallback.
 */
export interface StreamReadFrontierSnapshot extends StreamReadFrontier {
  streamId: string
  /** Absolute message ordinal of the frontier — mark-all pins it to the stream's total message count. */
  lastReadOrdinal: number
}

export interface WorkspaceBootstrap {
  workspace: Workspace
  users: User[]
  streams: StreamWithPreview[]
  streamMemberships: StreamMember[]
  /**
   * The viewer's read frontier per member stream — the sole read source
   * (membership carries no watermark). Every member stream has an entry, so a
   * null `lastReadEventId` reads as an authoritative explicit frontier, not
   * "no data". Optional: payloads cached before this field shipped lack it.
   */
  streamReadState?: Record<string, StreamReadFrontier>
  dmPeers: Array<{ userId: string; streamId: string }>
  personas: Persona[]
  bots: Bot[]
  emojis: EmojiEntry[]
  emojiWeights: Record<string, number>
  commands: CommandInfo[]
  unreadCounts: Record<string, number>
  /**
   * Per-stream total message count (message ordinal) at snapshot time —
   * the baseline for deriving unread from absolute counter payloads
   * (sync phase 2c): lastReadOrdinal = messageCounts - unreadCounts.
   * Optional during rollout: snapshots cached before the field shipped lack it.
   */
  messageCounts?: Record<string, number>
  /**
   * Per-stream sparse read overlay at snapshot time: message ids the viewer
   * read individually (via a conversation surface) ABOVE that stream's
   * watermark. `unreadCounts` is already effective (watermark + overlay
   * subtracted); this set lets the client keep the invariant
   * `unread = latest − read − |overlay|` as live events fold in, and lets the
   * timeline render overlay-read rows as read. Streams with an empty overlay
   * are omitted. Optional: snapshots cached before the field shipped lack it
   * (absent reads as empty). See docs/sparse-read-overlay-design.md.
   */
  readMessageIds?: Record<string, string[]>
  mentionCounts: Record<string, number>
  activityCounts: Record<string, number>
  unreadActivityCount: number
  /**
   * The viewer's unread activity rows (`read_at IS NULL AND is_self = FALSE`),
   * newest-first and capped, at snapshot time. This is the held set the Activity
   * badge and per-stream glow derive from, so a count can never outrun the feed.
   * Optional: snapshots cached before the field shipped lack it (absent reads as
   * empty).
   */
  unreadActivities?: Activity[]
  mutedStreamIds: string[]
  userPreferences: UserPreferences
  /** Viewer's persisted sidebar layout for this workspace (defaults to the Smart preset). */
  sidebarConfig: SidebarConfig
  /**
   * Viewer's saved board lenses, so the lens picker paints populated instead of
   * fetching on board mount (board-view-design.md § "Lenses"). Seeds the
   * `board-views` React-Query cache. Optional: snapshots cached before the field
   * shipped lack it (absent → the board falls back to its own fetch).
   */
  boardViews?: BoardView[]
  /** The viewer's own labels (every label is private to its creator). */
  labels: Label[]
  /**
   * Viewer's label→resource assignments across the workspace (all resource
   * types). Viewer-scoped: only the assignments this user created. Resolve
   * each `labelId` against `labels` to render; orphans (label archived) are
   * skipped.
   */
  labelAssignments: LabelAssignment[]
  invitations?: WorkspaceInvitation[]
  /**
   * Effective workspace permissions for the viewer. Sourced from the WorkOS
   * session JWT when the rollout is active, with a role-derived fallback for
   * older tokens. Frontend uses this to gate UI affordances.
   */
  viewerPermissions: WorkspacePermissionSlug[]
  /** Workspace-wide settings (e.g. the default working schedule members inherit). */
  workspaceSettings: WorkspaceSettings
  /**
   * The viewer's raw feature-flag layers (workspace + user overrides); the
   * client resolves them against the code registry, so a flag means the same
   * thing here as on the backend. Kept live by the `feature_flags:updated`
   * (user layer) and `feature_flags:workspace_updated` (workspace layer) socket
   * events. Optional per the post-v1 bootstrap convention — absent reads as all
   * registry defaults.
   */
  featureFlags?: FeatureFlagLayers
  /**
   * True when the viewer holds a control-plane platform-admin grant (synced
   * to the regional `platform_admin_access` mirror). Gates UI links into the
   * backoffice. Optional because bootstraps cached before this field shipped
   * lack it — absent reads as false. No live broadcast: grants are rare
   * operator actions and take effect on the next bootstrap.
   */
  viewerIsPlatformAdmin?: boolean
  /**
   * Agent tool categories the workspace has tooling configured for: `web` and
   * `workspace` always, `github`/`linear` only when connected. Drives the
   * scratchpad tool-policy picker — chiefly the at-creation control, which has
   * no per-stream bootstrap to read from yet. Optional for older cached
   * payloads (absent reads as "all gateable").
   */
  configuredToolCategories?: ToolPrivacyCategory[]
  /**
   * Workspace-global sync-log head (`MAX(sync_id)`) read just before this
   * snapshot was assembled, so the snapshot reflects everything `<= syncHead`
   * (read-before-stamp). On the first socket connect the client seeds its sync
   * cursor here: the connect bootstrap is the authority for everything
   * `<= head`, so catch-up starts at head and never collapses into a second
   * full bootstrap. Stringified BIGINT, matching `SyncCatchUpResponse.head`.
   * Optional: payloads cached before this field shipped (and the catch-up-driven
   * reconnect bootstraps that reuse this shape) omit it.
   */
  syncHead?: string
  /**
   * Agent sessions currently RUNNING in streams the viewer can access. The
   * sidebar keys indicators by the session's exact `streamId`; `rootStreamId`
   * remains the access boundary (INV-62: access-filtered server-side; a session in
   * a stream the viewer can't see is omitted). Live starts/ends ride the
   * `agent_session:*` room events; this seeds the store and, on reconnect,
   * re-seeds it as the authoritative running set (INV-53). Optional: payloads
   * cached before this field shipped omit it (absent reads as empty).
   */
  activeAgentSessions?: ActiveAgentSession[]
  /**
   * Archived root streams visible to the viewer, as slim `Stream` rows (no
   * previews). Archived roots are pruned from `streams`, but the client must
   * retain knowledge of archival across reloads: drafts filters hide
   * archived-stream drafts, and Saved/Activity resolve stream names from this
   * set once the active list no longer carries the row. Access-scoped and
   * workspace-scoped like `streams`. Optional: payloads cached before this
   * field shipped omit it (absent reads as empty).
   */
  archivedStreams?: Stream[]
  /**
   * Live calls in streams the viewer can access (roadmap 1.4), for the sidebar
   * call dot. Seeds the active-calls store cold and, on reconnect, re-seeds it as
   * the authoritative live set (INV-53). Optional: payloads cached before this
   * field shipped omit it (absent reads as empty).
   */
  activeCalls?: ActiveCall[]
}

/**
 * One running agent session, projected for the sidebar activity indicator.
 * `streamId` is the session's own stream (a channel/scratchpad/DM root, or a
 * thread) whose sidebar row lights up; `rootStreamId` is its non-thread ancestor
 * used for access filtering (`COALESCE(streams.root_stream_id, streams.id)`).
 * `personaName` is the persona or bot display name driving the session.
 *
 * `stepCount` / `messageCount` / `substep` are live progress, folded in from the
 * `agent_session:progress` and `agent_session:substep` room events; the bootstrap
 * projection omits them, so they read 0 / null until the first tick.
 */
export interface ActiveAgentSession {
  sessionId: string
  streamId: string
  rootStreamId: string
  personaName: string
  startedAt: string
  stepCount?: number
  messageCount?: number
  substep?: string | null
}

/**
 * One live call, projected for the sidebar dot (roadmap 1.4). Seeded from the
 * workspace bootstrap (`activeCalls`) and kept fresh by the `stream:call_started`
 * / `stream:call_ended` fan-out (public channels via the workspace room,
 * private/DM via member user rooms). `rootStreamId` is the non-thread ancestor
 * whose sidebar row lights up (calls only exist on channels/DMs today, so this
 * equals `streamId`, but the field mirrors `ActiveAgentSession` for the shared
 * dot lookup). Live-call presence drives the "call dot wins over the agent dot"
 * precedence at the sidebar decoration slot.
 */
export interface ActiveCall {
  callId: string
  streamId: string
  rootStreamId: string
  mode: "video" | "audio_only"
  participantCount: number
}

/**
 * The one live call on a stream, if any — the INV-53 pair for the timeline call
 * card's live state and the reload rejoin bar. Served on {@link StreamBootstrap}
 * and re-read on reconnect. `selfLiveParticipant` is true when the viewer holds a
 * `joined` participant row with a live (unlapsed) endpoint — the rejoin-bar
 * trigger after a fresh page load.
 */
export interface StreamActiveCall {
  callId: string
  mode: "video" | "audio_only"
  participantCount: number
  /** Distinct UserIds of the currently-joined participants (roster avatars). */
  participantUserIds: string[]
  /** True when the viewer is still `joined` with a live endpoint — drives the rejoin bar. */
  selfLiveParticipant: boolean
}

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

/** Wire format for activity items (dates as ISO strings) */
export interface Activity {
  id: string
  workspaceId: string
  userId: string
  activityType: string
  /** Null only for saved_reminder rows fired by standalone (message-less) saved items. */
  streamId: string | null
  messageId: string | null
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
  /**
   * The target user's absolute unread counts for the activity's stream
   * (sync phase 2c). Clients set counters from these — never increment —
   * so replayed/duplicated events converge. Optional: sync-log entries
   * persisted before the field shipped lack it; consumers must fall back to
   * legacy increment-or-skip handling for those.
   */
  counts?: {
    mentionCount: number
    activityCount: number
  }
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
    /** Reaction emoji (null for non-reaction rows); lets the client drop the held row on reaction:removed. */
    emoji: string | null
  }
}

/** Socket event payload for activity:read */
export interface ActivityReadPayload {
  workspaceId: string
  targetUserId: string
  /**
   * Delta: ids of the rows that flipped to read. Drops are idempotent and
   * commute, so replays/duplicates converge.
   */
  activityIds: string[]
  /**
   * Distinct non-null streams of the flipped rows. Populated for stream/all
   * clears (drives push-banner dismissal on other devices); empty for per-row
   * reads, which must not dismiss a grouped banner that may still represent
   * sibling unread rows.
   */
  streamIds: string[]
}

export interface MarkAsReadInput {
  lastEventId: string
}

export interface MarkAsReadResponse {
  /** Null when the viewer has access but no membership row (INV-62: non-member thread leg, unjoined public channel) — an activity-only read. */
  membership: StreamMember | null
  /**
   * The canonical post-write read frontier. `null` means the request was a
   * no-op — the event id resolved to no row in this stream, so nothing moved
   * and the client must write nothing locally. Absent only on responses from
   * before the field shipped.
   */
  readState?: StreamReadFrontier | null
  /** Absolute message ordinal of the post-write frontier — the counter's authoritative read position. Null on the no-op path. */
  lastReadOrdinal?: number | null
  /** The post-write sparse read overlay (message ids above the watermark). Null on the no-op path. */
  readMessageIds?: string[] | null
}

export interface MarkAllAsReadResponse {
  updatedStreamIds: string[]
  /**
   * The canonical post-write frontier per updated stream (additive). Clients
   * advance their standalone watermark from this. Empty when nothing advanced;
   * absent only on responses from before the field shipped (legacy clients keep
   * counter behavior and reconcile on the next bootstrap).
   */
  frontiers?: StreamReadFrontierSnapshot[]
}

export interface DispatchCommandInput {
  command: string
  streamId: string
  clientCommandId?: string
  /** The conversation the dispatching composer writes into, when it has one. */
  conversationId?: string
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
  clientCommandId?: string
  name: string
  args: string
  status: "dispatched"
  /**
   * The conversation the dispatching composer was writing into, when there is
   * one. Stamped only by the board/panel composers — a stream-level dispatch
   * (the timeline composer) carries none and stays off the cards. The lifecycle
   * events that follow are refless; they join by `commandId`.
   */
  conversationId?: string
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

/**
 * Payload for `aside:anchored` timeline events: the creator-only row an aside
 * leaves in its host stream, appended in the aside-creation transaction
 * (INV-4). Author-scoped like command events — no broadcast slot (INV-61),
 * never delivered to other members. Immutable by design: it names the aside
 * and its anchor only; title and state are a client join against the aside
 * stream row. `anchorId` is the host message/card it was opened from, or null
 * for a composer/palette aside (the row then sits at creation position).
 * `conversationId` is set when opened from a conversation surface so the
 * board/panel projection places the row on that card.
 */
export interface AsideAnchoredEventPayload {
  asideId: string
  anchorId: string | null
  conversationId?: string
}

export interface AIUsageSummary {
  totalCostUsd: number
  promptTokens: number
  /** Prompt tokens the provider served from its cache — a subset of promptTokens. */
  cachedPromptTokens: number
  completionTokens: number
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

export const AI_USAGE_CATEGORIES = ["memory", "conversation", "agents", "attachments", "other"] as const

export type AIUsageCategory = (typeof AI_USAGE_CATEGORIES)[number]

export interface AIUsageByFunction {
  functionId: string
  category: AIUsageCategory
  totalCostUsd: number
  totalTokens: number
  promptTokens: number
  cachedPromptTokens: number
  recordCount: number
}

export interface AIUsageByModel {
  model: string
  totalCostUsd: number
  totalTokens: number
  promptTokens: number
  cachedPromptTokens: number
  recordCount: number
}

export interface AIUsageByDay {
  date: string
  category: AIUsageCategory
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
  byFunction: AIUsageByFunction[]
  byModel: AIUsageByModel[]
  byDay: AIUsageByDay[]
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

/**
 * Wire shape for a saved-item row. Items are either anchored to a message
 * (`messageId`/`streamId` set, the original bookmark flow) or standalone
 * to-dos (`messageId`/`streamId` null, `title` set). Absolute timestamps are
 * ISO strings; the live-resolved message snapshot is null when the item is
 * standalone, the underlying message has been deleted, or the owner has lost
 * access to the stream — `unavailableReason` distinguishes the latter two.
 */
export interface SavedMessageView {
  id: string
  workspaceId: string
  userId: string
  messageId: string | null
  streamId: string | null
  /**
   * The conversation this message was saved from (board card / conversation
   * panel). When set, the Saved list and reminder surfaces deep-link into the
   * conversation panel (`?panel=conv:<id>&m=<msgId>`) instead of the stream
   * permalink. Null for stream-origin saves and standalone to-dos.
   */
  conversationId: string | null
  status: SavedStatus
  /** Display line for standalone items; null for message-anchored rows. */
  title: string | null
  /** Optional free-text context, editable on both variants. */
  note: string | null
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

/**
 * Create input: exactly one of `messageId` (save a message) or `title`
 * (standalone to-do). `note` is accepted only with `title` — message saves
 * start without a note; it's added later via update.
 */
export interface SaveMessageInput {
  messageId?: string
  /**
   * Conversation this message is being saved from — set only by the conversation
   * surfaces (board card / conversation panel) so the saved row remembers its
   * origin. Validated server-side (workspace-scoped, root must match the
   * message's access root); accepted only alongside `messageId`.
   */
  conversationId?: string
  title?: string
  note?: string
  remindAt?: string | null
}

/**
 * Update input: exactly one mutation group per request — `status`, `remindAt`,
 * or content (`title` and/or `note`) — so each PATCH is one transaction and
 * one socket event. `note: null` clears the note; titles can't be cleared.
 */
export interface UpdateSavedMessageInput {
  status?: SavedStatus
  remindAt?: string | null
  title?: string
  note?: string | null
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

/** Wire payload on `board:conversation_hide_changed` (board-view-design.md § "Hide & mute"). */
export interface BoardConversationHideChangedPayload {
  workspaceId: string
  targetUserId: string
  conversationId: string
  /** true = hidden, false = un-hidden. */
  active: boolean
  /** Snooze watermark (ISO), present only when `active`. */
  hiddenAt?: string
}

/** Wire payload on `board:stream_mute_changed`. */
export interface BoardStreamMuteChangedPayload {
  workspaceId: string
  targetUserId: string
  streamId: string
  /** true = muted, false = un-muted. */
  active: boolean
}

/** Wire payload broadcast on `saved:deleted` socket events. */
export interface SavedDeletedPayload {
  workspaceId: string
  targetUserId: string
  savedId: string
  /** Null for standalone (message-less) saved items. */
  messageId: string | null
}

/** Wire payload broadcast on `saved_reminder:fired` socket events. */
export interface SavedReminderFiredPayload {
  workspaceId: string
  targetUserId: string
  savedId: string
  /** Null for standalone (message-less) saved items. */
  messageId: string | null
  streamId: string | null
  saved: SavedMessageView
}

/**
 * Wire shape for a passively-collected to-do suggestion. Suggestions are
 * per-user (the resolved assignee) and never enter the saved list on their
 * own — accepting one creates a saved item anchored at the suggestion's
 * primary source message with the extracted context as its note.
 */
export interface SavedSuggestionView {
  id: string
  workspaceId: string
  /** The resolved assignee — the only user who sees this suggestion. */
  userId: string
  streamId: string
  conversationId: string
  title: string
  /** Extracted context (the why/what); becomes the saved item's note on accept. */
  context: string | null
  sourceMessageIds: string[]
  dueAt: string | null
  status: SavedSuggestionStatus
  /** Saved item created by accepting this suggestion; null until accepted. */
  savedMessageId: string | null
  createdAt: string
  statusChangedAt: string
}

export interface SavedSuggestionListResponse {
  suggestions: SavedSuggestionView[]
  nextCursor: string | null
}

/** Response for POST /saved/suggestions/:id/accept. */
export interface AcceptSavedSuggestionResponse {
  suggestion: SavedSuggestionView
  saved: SavedMessageView
}

/** Wire payload broadcast on `saved_suggestion:upserted` socket events. */
export interface SavedSuggestionUpsertedPayload {
  workspaceId: string
  targetUserId: string
  suggestion: SavedSuggestionView
}

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
  attachmentIds?: string[]
  metadata?: Record<string, string>
  scheduledFor: string
  /** Idempotency key for optimistic create retries (mirrors message create). */
  clientMessageId?: string
  /**
   * Declare the delivered message's conversation (see {@link ConversationDirective}),
   * stored on the row and forwarded to the send at fire time. Set by the composer's
   * "Reply in conversation" arm; omit to let the extractor infer at fire time.
   */
  conversation?: ConversationDirective
}

/**
 * Optimistic-concurrency update payload. The client sends `expectedVersion`
 * — the `version` integer it last saw on the row — and the server CAS rejects
 * with 409 STALE_VERSION when the row has moved on (someone else saved, the
 * worker fired, etc). Any number of editors can coexist; first save wins.
 */
export interface UpdateScheduledMessageInput {
  contentJson?: JSONContent
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

/**
 * Where a draft belongs. Either a stream (`stream:{streamId}`) or a not-yet-
 * threaded parent message (`thread:{parentMessageId}`) — the latter only while
 * the reply target has no thread stream of its own yet. A scope may hold many
 * drafts (the loaded one plus stash entries plus split-offs); identity is the
 * `draft_` id, not the scope. Stored as a plain string so re-scoping (thread
 * conversion) is a single column UPDATE.
 */
export type DraftScope = string

/**
 * Build the `stream:{streamId}` draft scope. Single source of truth (INV-33) for
 * the scope string, shared by the composer (which keys drafts by scope) and the
 * backend thread re-pointing / promotion paths that re-scope drafts onto a real
 * stream. Keeping the format in one place is what lets a re-scope on either side
 * line up with the other's stored rows.
 */
export function draftStreamScope(streamId: string): DraftScope {
  return `stream:${streamId}`
}

/**
 * Build the `thread:{anchorId}` draft scope (reply to a timeline item that has no
 * thread stream of its own yet). `anchorId` is the item's canonical id — `msg_…`
 * for a message, `event_…` for a card (INV-2 prefix is the discriminator); the
 * scope string is the one anchor track, byte-identical to before for messages.
 */
export function draftThreadScope(anchorId: string): DraftScope {
  return `thread:${anchorId}`
}

/**
 * Draft scopes inside an aside: `aside:{asideId}:{draftId}`. An aside holds
 * several living drafts at once and a scope holds exactly one draft, so the
 * draft id is part of the scope rather than a column beside it.
 *
 * Shared rather than client-only (INV-33): the aside's agent reads the drafts
 * open beside it, which means the server has to recognise the grammar it was
 * once free to treat as opaque. The client still mints the ids.
 */
const ASIDE_DRAFT_SCOPE_PREFIX = "aside:"

export interface AsideDraftScope {
  asideId: string
  draftId: string
}

export function asideDraftScope(asideId: string, draftId: string): DraftScope {
  return `${ASIDE_DRAFT_SCOPE_PREFIX}${asideId}:${draftId}`
}

/** The scope prefix every draft of `asideId` starts with — the server's list key. */
export function asideDraftScopePrefix(asideId: string): string {
  return `${ASIDE_DRAFT_SCOPE_PREFIX}${asideId}:`
}

export function parseAsideDraftScope(scope: string): AsideDraftScope | null {
  if (!scope.startsWith(ASIDE_DRAFT_SCOPE_PREFIX)) return null
  const [asideId, draftId, ...rest] = scope.slice(ASIDE_DRAFT_SCOPE_PREFIX.length).split(":")
  if (!asideId || !draftId || rest.length > 0) return null
  return { asideId, draftId }
}

export function isAsideDraftScope(scope: string): boolean {
  return parseAsideDraftScope(scope) !== null
}

/** Slash-command draft payload (mirrors the composer's `ExtractedCommand`). */
export interface DraftCommand {
  name: string
  clientActionId: string | null
}

/**
 * A draft: one composer payload that syncs across the author's devices. There
 * is only one kind of draft — what the frontend calls a "stash entry" and what
 * is "loaded into the composer" are the same row; "loaded" is device-local
 * state that never reaches the wire.
 *
 * Content is one of two shapes. Plaintext streams carry `contentJson` /
 * `contentMarkdown`; E2E streams carry `ciphertext` / `envelope` / `e2eVersion`
 * with the plaintext fields null (the draft is sealed to the stream key before
 * it ever leaves the device, honoring E2EE-4).
 */
export interface Draft {
  id: string
  workspaceId: string
  userId: string
  scope: DraftScope
  rootStreamId: string | null
  contentJson: JSONContent | null
  contentMarkdown: string | null
  attachmentIds: string[]
  command: DraftCommand | null
  /** Opaque to the backend — the composer owns the shape, round-tripped as-is. */
  contextRefs: Record<string, unknown>[] | null
  // E2E variant
  ciphertext: string | null
  envelope: unknown | null
  e2eVersion: number | null
  /**
   * Optimistic-concurrency version. Starts at 1; every accepted server-side
   * write increments it. The client sends the version its edit was based on as
   * `expectedVersion`; on mismatch the server SPLITS (keeps the existing row,
   * inserts a new draft for the incoming content) rather than rejecting.
   */
  version: number
  /** Authoring device's wall clock for the last edit; drives recency ordering. */
  clientUpdatedAt: string
  /**
   * Set while the draft is stashed ("put away"): no surface on any device may
   * advertise or auto-restore it — it lives in piles and the drafts explorer
   * until the user restores it, which clears the flag. Null = active.
   */
  stashedAt: string | null
  /** Last accepted write id; lets the authoring device suppress its own sent-write echoes. */
  lastClientWriteId?: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Wire body for `PUT /drafts/:id`. `expectedVersion` is the version the edit
 * was based on (0 when the client has never seen a server confirmation for
 * this id). `writeId` is a per-push idempotency key reused across retries of
 * the same op, so a lost ack never causes a spurious split.
 *
 * Exactly one content shape must be present: `contentJson` (plaintext) or the
 * `ciphertext` triple (E2E). `contentMarkdown` is derived server-side from
 * `contentJson`, so callers never send it.
 */
export interface UpsertDraftInput {
  scope: DraftScope
  rootStreamId?: string | null
  expectedVersion: number
  writeId: string
  /**
   * Write ids of this device's earlier pushes for this draft that were
   * superseded before their ack was observed (a coalesced save replaced a push
   * that had already been attempted). If the server row's
   * `last_client_write_id` is any of these, the last accepted write was this
   * device's own — no other device has written since — so the server updates in
   * place instead of splitting a lost ack into a duplicate draft.
   */
  priorWriteIds?: string[]
  clientUpdatedAt: string
  contentJson?: JSONContent | null
  attachmentIds?: string[]
  command?: DraftCommand | null
  contextRefs?: Record<string, unknown>[] | null
  ciphertext?: string | null
  envelope?: unknown | null
  e2eVersion?: number | null
  /**
   * Absent means PRESERVE the server's current value (legacy clients omit it);
   * new clients send it on every push — explicit null clears, a timestamp sets.
   */
  stashedAt?: string | null
}

/**
 * Response from `PUT /drafts/:id`. When `split` is true the server detected
 * drift: `draft.id` is a freshly minted entity carrying the incoming content,
 * `originalId` is the id the client pushed under (whose row was left untouched
 * for the other device), and the client migrates its local state to `draft.id`.
 * `keptDraft` is that untouched row when it is still live: the pushing device
 * ignored its socket echo while dirty, so the response carries it and the
 * client seeds it as a stash entry instead of waiting for the next bootstrap.
 */
export interface UpsertDraftResponse {
  draft: Draft
  split: boolean
  originalId?: string
  keptDraft?: Draft
}

/**
 * Wire body for `POST /drafts/:id/resolve` (clear-on-send). CAS-guarded by
 * `expectedVersion`: the draft is removed only if it still matches, so a copy
 * that drifted since the send started survives as a stash entry instead of
 * being collaterally deleted. `supersededWriteIds` lets the server also remove
 * this device's own lost-ack upsert if it landed after send began, without
 * deleting unrelated drift. A lost-ack retry re-runs the same resolve: the row
 * is already tombstoned, so it returns `resolved: false` with the draft gone
 * either way.
 */
export interface ResolveDraftInput {
  expectedVersion: number
  /** Write ids from this device's sent draft upserts that may have landed after send began. */
  supersededWriteIds?: string[]
}

export interface ResolveDraftResponse {
  /** False when the version no longer matched — the draft drifted and was kept. */
  resolved: boolean
}

/**
 * Optional wire body for `DELETE /drafts/:id` (explicit discard). Like resolve,
 * a discard can race this device's own in-flight upsert: a push that left the
 * client but lands after the tombstone must be dropped, not split into a live
 * zombie of the discarded content. The tombstone remembers these write ids so
 * the late write is recognized as superseded.
 */
export interface DeleteDraftInput {
  supersededWriteIds?: string[]
}

/**
 * Defensive cap on the drafts bootstrap read (`GET /drafts`). Shared so the
 * client can tell a complete snapshot from a truncated one: when the snapshot
 * hits the cap, absence from it no longer proves a local draft was deleted
 * elsewhere, so the bootstrap sweep must not drop local rows.
 */
export const MAX_DRAFTS_PER_USER = 500

export interface DraftListResponse {
  drafts: Draft[]
}

/** Wire payload broadcast on `draft:upserted` socket events. */
export interface DraftUpsertedPayload {
  workspaceId: string
  targetUserId: string
  draft: Draft
}

/** Wire payload broadcast on `draft:deleted` socket events. */
export interface DraftDeletedPayload {
  workspaceId: string
  targetUserId: string
  draftId: string
}

/**
 * Wire payload broadcast on `enclave:rewrap_needed` socket events. Tells the
 * owner's online tab that an enclave turn in `rootStreamId` is stuck because no
 * live agent instance holds the stream's key — only the owner's unlocked device
 * can re-wrap it (the enclave can't seal to itself). The tab heals in place.
 */
export interface EnclaveRewrapNeededPayload {
  workspaceId: string
  targetUserId: string
  rootStreamId: string
}

/**
 * Wire body for `POST /labels`. Slug is server-derived from `name` (unique per
 * owner); `color` is required so the frontend picks an explicit swatch rather
 * than inventing a default.
 */
export interface CreateLabelInput {
  name: string
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
 * Wire payload for `label:created` / `label:updated`. Labels are owner-scoped,
 * so `targetUserId` is the owning actor and the event is delivered to that
 * actor only.
 */
export interface LabelUpsertedPayload {
  workspaceId: string
  targetUserId: string
  label: Label
}

/** Wire payload for `label:deleted` (soft-archive). Delivered to the owner. */
export interface LabelDeletedPayload {
  workspaceId: string
  targetUserId: string
  labelId: string
}

/**
 * Wire payload for `label:assigned` (a label applied to a resource).
 * Owner-scoped: `targetUserId` is the actor who applied it, the only one who
 * sees the assignment.
 */
export interface LabelAssignedPayload {
  workspaceId: string
  targetUserId: string
  assignment: LabelAssignment
}

/**
 * Wire payload for `label:unassigned`. The row is gone, so only identity is
 * carried. Delivered to the actor whose row was removed (`targetUserId`).
 */
export interface LabelUnassignedPayload {
  workspaceId: string
  targetUserId: string
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
  userId: string
}
