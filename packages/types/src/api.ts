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
} from "./constants"
import type { WorkspaceInvitableRole } from "./workspace-permissions"
import type { ContextBag, ContextIntent, ContextRefKind } from "./context-bag"
import type { UserId } from "./ids"
import type { JSONContent } from "./prosemirror"
import type {
  AttachmentSummary,
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
} from "./domain"
import type { UserPreferences } from "./preferences"
import type { WorkspaceSettings } from "./workspace-settings"
import type { FeatureFlags } from "./feature-flags"
import type { SidebarConfig } from "./sidebar"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "./tool-privacy"
import type { WorkspacePermissionSlug } from "./workspace-permissions"

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
  parentMessageId?: string
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
   * sync-log floor (entries it would need have been pruned by retention, see
   * docs/plans/sync-v2-log-retention.md). The log can no longer heal the gap;
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
 * target. See docs/plans/sync-v2-heartbeat.md.
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
 * `existing` attaches to `conversationId`; `threadFromMessage` mints the
 * conversation for this message (a thread's first reply) and retires the lone
 * `sourceConversationId` it threaded off, so the board shows one card — the
 * thread — instead of the source post plus the thread. The id is a sibling of
 * the discriminant (not folded into one field) so a missing/garbage id on
 * `existing`/`threadFromMessage` is a validation error, distinct from `new`.
 */
export type ConversationDirective =
  | { intent: "new" }
  | { intent: "existing"; conversationId: string }
  | { intent: "threadFromMessage"; sourceConversationId: string }

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
  /**
   * E2E attachment ids to bind to this message. The bytes are opaque ciphertext
   * (`e2e_only` rows); their per-file keys + real metadata ride sealed inside
   * the message payload, never here. Omitted when the message has no files.
   */
  attachmentIds?: string[]
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
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
 * A sealed auto-generated stream title the enclave produced this turn, POSTed to
 * `POST .../sessions/:id/sealed-name`. The server can't read message content, so
 * it can't title an encrypted scratchpad — the enclave (which sees plaintext)
 * generates a short title, seals it under the stream SSK bound by AAD to
 * `streamId|name|generation` (`buildNameAad`), and the backend stores the
 * ciphertext as the stream's sealed name (`e2e_streams.name_ciphertext`). No
 * `messageId`: a stream name occupies a single per-stream slot, not a message.
 */
export interface EnclaveSealedName {
  ciphertext: string
  envelope: EnclaveStreamEnvelope
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
  system: string
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
   * When true, this scratchpad has no sealed name yet, so the enclave should
   * generate a short title from the decrypted turn, seal it under the SSK
   * (`buildNameAad`), and POST it back via the sealed-name callback. The server
   * can't title an encrypted scratchpad itself (it only holds ciphertext).
   * Set only for the root scratchpad's first untitled turn; omitted/false
   * otherwise (threads and already-titled scratchpads).
   */
  autoTitle?: boolean
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
 * Payload for `memos:captured` timeline events (INV-62): appended to the
 * source stream when GAM extracts memos from one of its conversations, in
 * the same transaction as the memo rows. The event lands at the broadcast
 * position where extraction completed — per-stream debouncing means that is
 * normally just after the conversation that produced it — and carries the
 * source conversation/message ids so the row can point back at the messages
 * the knowledge came from.
 */
export interface MemosCapturedEventPayload {
  conversationId: string
  memos: CapturedMemoSummary[]
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
   * The viewer's resolved feature flags (defaults + backoffice-managed
   * per-user overrides). Kept live by the `feature_flags:updated` socket event.
   */
  featureFlags: FeatureFlags
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

export interface MarkAsReadInput {
  lastEventId: string
}

export interface MarkAsReadResponse {
  membership: StreamMember
}

export interface MarkAllAsReadResponse {
  updatedStreamIds: string[]
}

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

/** Build the `thread:{parentMessageId}` draft scope (reply to a not-yet-threaded message). */
export function draftThreadScope(parentMessageId: string): DraftScope {
  return `thread:${parentMessageId}`
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
