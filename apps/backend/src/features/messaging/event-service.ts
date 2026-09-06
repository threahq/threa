import type { Pool, PoolClient } from "pg"
import { withTransaction, withClient, sql } from "../../db"
import { StreamEventRepository, type StreamEvent, type MoveEventIdSequenceUpdate } from "../streams"
import { StreamRepository, type Stream } from "../streams"
import { StreamMemberRepository, SparseReadRepository, ReadStateRepository } from "../streams"
import {
  assertStreamWritable,
  assertStreamsWritable,
  resolveLockedStreamAuthorities,
  checkStreamAccess,
  resolveEffectiveAccessStream,
  type StreamWritePrincipal,
} from "../streams"
import { MessageRepository, type Message, type MoveMessageSequenceUpdate } from "./repository"
import {
  collectSharedMessageRefs,
  hydrateSharedMessageRefsForRoom,
  toDualSlotMaps,
  ShareService,
  type ResolveEffectiveStream,
} from "./sharing"
import { resolveMessageReferences } from "./references"
import {
  AttachmentRepository,
  AttachmentReferenceRepository,
  AttachmentUploadRepository,
  isAttachmentReadableViaShareOrReference,
  isAttachmentSafeForSharing,
  toAttachmentSummary,
  type Attachment,
  type AttachmentUpload,
} from "../attachments"
import { OutboxRepository } from "../../lib/outbox"
import { AgentSessionRepository, StreamPersonaParticipantRepository } from "../agents"
import { settleMessagesOnEngagement } from "../conversations"
import { DraftsRepository, toDraftView } from "../drafts"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamContextRepository, contextRowsForMessage, contextSnippet } from "../stream-context"
import { MemoRepository, resolveMemoEmbedSummaries } from "../memos"
import {
  attachmentReferenceId,
  eventId,
  messageId,
  messageVersionId,
  streamContextItemId,
  streamId as generateStreamId,
} from "../../lib/id"
import { MessageVersionRepository, type MessageVersion } from "./version-repository"
import { MessageComposeTraceRepository } from "./compose-trace-repository"
import { collectAgentBlockAuthorIds, collectMemoEmbedIds } from "@threahq/prosemirror"
import { withDerivedMessageMetadata } from "./metadata-schema"
import { serializeBigInt } from "@threahq/backend-common"
import { messagesTotal } from "../../lib/observability"
import { HttpError, MessageNotFoundError, StreamNotFoundError } from "../../lib/errors"
import { OperationLeaseRepository } from "../../lib/operation-leases"
import { resolveMentionContent } from "../mentions"
import { deriveContentMarkdown } from "./content"
import { logger } from "../../lib/logger"
import {
  AttachmentSafetyStatuses,
  AuthorTypes,
  CompanionModes,
  ConversationIntents,
  StreamTypes,
  Visibilities,
  THREAD_ANCHORABLE_EVENT_TYPES,
  draftStreamScope,
  draftThreadScope,
  type AttachmentSummary,
  type AuthorType,
  type ComposeTrace,
  type ConversationDirective,
  type FeatureFlagValue,
  type MemoEmbedSummary,
  type EventType,
  type SharedMessageRef,
  type SourceItem,
  type JSONContent,
  type ThreadSummary,
  type StreamEvent as WireStreamEvent,
  type MessagesMovedEventPayload,
  type MovedMessagePreview,
} from "@threahq/types"

/**
 * Adapter that lets `ShareService.validateAndRecordShares` consume the
 * canonical `resolveEffectiveAccessStream` (which returns either the input
 * shape or a full `Stream`) without leaking the streams-feature row shape
 * into the sharing sub-feature (INV-52). Hoisted to module scope so the
 * create + edit call paths share one allocation rather than re-declaring
 * the closure per request (INV-13, INV-35).
 */
const resolveEffectiveStreamAdapter: ResolveEffectiveStream = async (db, source) => {
  const resolved = await resolveEffectiveAccessStream(db, source)
  return {
    id: resolved.id,
    workspaceId: resolved.workspaceId,
    visibility: resolved.visibility,
    rootStreamId: resolved.rootStreamId,
  }
}

type MessageMutationAuthority =
  | { kind: "internal" }
  | { kind: "principal"; principal: StreamWritePrincipal; presentationOwnerId?: string }

export interface MessageCreatedPayload {
  messageId: string
  contentJson: JSONContent
  contentMarkdown: string
  /**
   * The revision `contentJson` is. `1` on emission; bootstrap enrichment
   * overlays the projection's current value alongside the edited body, so a
   * reference pinned from a rendered row pins what the viewer actually saw.
   */
  revision: number
  attachments?: AttachmentSummary[]
  sources?: SourceItem[]
  sessionId?: string
  /** Client-generated ID for deterministic optimistic→real event dedup on the frontend */
  clientMessageId?: string
  /** Present when message was sent via an API key on behalf of a user */
  sentVia?: string
  /** External references attached by the sender (string->string). Omitted when empty. */
  metadata?: Record<string, string>
  /**
   * The conversation this message declared at send time via an `existing`
   * directive (a board/panel reply, or a future "reply in conversation" action).
   * Lets the flat-timeline provenance chip render membership the instant the message
   * arrives, without waiting for the async conversation list to load. Only the
   * id is carried (messaging stays decoupled from conversation internals — no
   * topic read here); the frontend resolves the topic label from the same-root
   * conversation list the timeline already loads. Absent for `new`/thread-from-
   * message declarations (a fresh topic is chip-less) and for messages the async
   * extractor classifies later (Mechanism A's membership map still covers those).
   */
  declaredConversationId?: string
  /**
   * Populated at bootstrap enrichment time when this message has at least one
   * non-deleted reply. Not present on initial `message_created` emission (the
   * outbox path carries no replies yet).
   */
  threadSummary?: ThreadSummary
  /**
   * Set on messages originating in an E2E stream. When present,
   * `contentJson` / `contentMarkdown` are placeholder values and consumers
   * must decrypt the ciphertext via the matching recipient envelope entry to
   * recover the real payload. Plaintext consumers (outbox handlers, search
   * indexer) gate on `e2eStreams.isE2eStream` and short-circuit; the
   * frontend branches on the presence of `ciphertext` to drive the decrypt.
   */
  ciphertext?: string
  envelope?: unknown
  e2eVersion?: number
  /**
   * Card content for the memos this body references, so each embed card renders
   * complete on its first frame instead of fetching (INV-21, and the rule it
   * serves: content may change only when the memo changed). Omitted when the
   * body cites none. Ids the room can't uniformly read are absent — those cards
   * render the reference's own label and stay there.
   */
  memoEmbeds?: MemoEmbedSummary[]
}

export interface MessageEditedPayload {
  messageId: string
  contentJson: JSONContent
  contentMarkdown: string
  /** The revision this edit produced (the pre-edit revision + 1). */
  revision: number
  /**
   * Always present, empty array included — unlike the create payload. The client
   * applies an edit by spreading it over the stored payload, so an omitted key
   * would leave the pre-edit summaries in place: a removed reference would keep
   * its card content, and one swapped for another would show the wrong memo.
   */
  memoEmbeds: MemoEmbedSummary[]
}

export interface MessageDeletedPayload {
  messageId: string
}

export interface ReactionPayload {
  messageId: string
  emoji: string
  userId: string
}

export interface CreateMessageParams {
  workspaceId: string
  streamId: string
  /**
   * Optional server-minted message id. Used by the enclave reply path, which
   * must know the id before sealing (the SSK envelope's AAD binds to it).
   * Omit for normal sends — a fresh id is generated.
   */
  id?: string
  authorId: string
  authorType: AuthorType
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds?: string[]
  sources?: SourceItem[]
  sessionId?: string
  /** Client-generated idempotency key to prevent duplicate sends on retry */
  clientMessageId?: string
  /** Indicator for messages sent via API (e.g. "api" for user-scoped keys) */
  sentVia?: string
  /** External references (string->string) attached to the message. Reserved prefix: `threa.*`. */
  metadata?: Record<string, string>
  /**
   * Declares the message's conversation, assigned synchronously in this send's
   * transaction by the injected {@link ConversationAssigner} (the extractor then
   * leaves it locked). Omit to let the async extractor infer the conversation.
   */
  conversation?: ConversationDirective
  /**
   * Compose-session provenance captured by the client (see {@link ComposeTrace}).
   * Persisted to the `message_compose_traces` sidecar only while the workspace's
   * `composeTraces` flag is on; absent for API sends, old clients, and every
   * non-user author, which is normal rather than an error.
   */
  composeTrace?: ComposeTrace
  /**
   * Present when the sharer has acknowledged a privacy warning in the
   * share modal. Backend still independently verifies whether the share
   * crosses a privacy boundary before consulting this flag.
   */
  confirmedPrivacyWarning?: boolean
  /**
   * Pre-computed access scope used to authorize inline-attachment
   * references and cross-stream share/quote pointers. When omitted, the
   * gate falls back to membership lookups keyed by `authorId`, which is
   * correct for user-authored messages.
   *
   * Persona-authored messages MUST set this to the agent's
   * `accessibleStreamIds` from `AgentAccessSpec` — *not* the invoking
   * user's full reach. The spec is scope-restricted: from a public channel
   * the agent only sees public streams, from a private channel only that
   * channel + public, from a DM only the participants' intersection, etc.
   * Using the user's full access would let agents resurface attachments
   * the user never could have surfaced from this scope.
   */
  accessibleStreamIds?: string[]
  /**
   * Set on messages bound for an E2E stream. Caller must have
   * already verified that the target stream is E2E (the messaging handler
   * does this via `E2eStreamsRepository.isE2eStream`); when present,
   * `contentJson` / `contentMarkdown` are placeholder values and the
   * canonical payload is the ciphertext + envelope blob below.
   */
  ciphertext?: Buffer
  envelope?: unknown
  e2eVersion?: number
}

export interface EditMessageParams {
  workspaceId: string
  messageId: string
  streamId: string
  contentJson: JSONContent
  contentMarkdown: string
  actorId: string
  actorType?: AuthorType
  /**
   * Inline-attachment ids referenced from the new content. Required to keep
   * `attachment_references` in sync with `contentJson` (INV-7) — without this,
   * an edit that adds or removes an `attachment:` link leaves the projection
   * stale and download authorization stops matching the persisted body.
   * Callers derive this from `contentJson` via
   * `collectAttachmentReferenceIds`. Fresh uploads on edit are NOT supported
   * — pass references only (`messageId !== null`); a fresh-upload id will
   * fail the validation here loudly.
   */
  attachmentIds?: string[]
  /** Same semantics as `CreateMessageParams.confirmedPrivacyWarning`. */
  confirmedPrivacyWarning?: boolean
  /** Same semantics as `CreateMessageParams.accessibleStreamIds`. */
  accessibleStreamIds?: string[]
}

export interface DeleteMessageParams {
  workspaceId: string
  messageId: string
  streamId: string
  actorId: string
  actorType?: AuthorType
}

export interface AddReactionParams {
  workspaceId: string
  messageId: string
  streamId: string
  emoji: string
  userId: string
  /**
   * Actor type of the reactor. Defaults to "user" for human reactions sent
   * through the HTTP API. Persona-authored reactions (the agent's
   * `react_to_message` tool) pass "persona" so the stream event, outbox
   * payload, and downstream activity/emoji handlers attribute the reaction
   * correctly instead of treating the persona id as a workspace user.
   */
  actorType?: AuthorType
}

export interface RemoveReactionParams {
  workspaceId: string
  messageId: string
  streamId: string
  emoji: string
  userId: string
  /** Same semantics as `AddReactionParams.actorType`. */
  actorType?: AuthorType
}

export interface MoveMessagesToThreadParams {
  workspaceId: string
  sourceStreamId: string
  targetMessageId: string
  messageIds: string[]
  actorId: string
  leaseKey: string
}

export interface ValidateMoveMessagesToThreadParams {
  workspaceId: string
  sourceStreamId: string
  targetMessageId: string
  messageIds: string[]
  actorId: string
}

export interface MoveMessagesToThreadResult {
  sourceStreamId: string
  destinationStreamId: string
  targetMessageId: string
  movedMessageIds: string[]
  thread: import("../streams").Stream
  events: WireStreamEvent[]
  removedEventIds: string[]
  /** The `messages:moved` tombstone inserted into the SOURCE stream. */
  sourceTombstoneEvent: WireStreamEvent
}

const MOVE_MESSAGES_TO_THREAD_OPERATION = "messages.move_to_thread"

/**
 * Cap each moved-message content excerpt embedded in a `messages:moved`
 * payload. Long messages are truncated server-side so the wire size is
 * bounded for big moves; the drill-in drawer shows a one-liner per
 * message anyway. We append `…` only when truncation actually happened
 * to avoid lying about completeness on already-short messages.
 */
const MOVED_MESSAGE_PREVIEW_CHAR_CAP = 200

function capMovedPreview(content: string): string {
  if (content.length <= MOVED_MESSAGE_PREVIEW_CHAR_CAP) return content
  // Iterate by code points so non-BMP characters aren't split into a lone
  // surrogate at the truncation boundary.
  const codePoints = Array.from(content)
  if (codePoints.length <= MOVED_MESSAGE_PREVIEW_CHAR_CAP) return content
  return `${codePoints.slice(0, MOVED_MESSAGE_PREVIEW_CHAR_CAP).join("")}…`
}

function canonicalMoveLeasePayload(params: {
  sourceStreamId: string
  targetMessageId: string
  messageIds: string[]
}): Record<string, unknown> {
  return {
    sourceStreamId: params.sourceStreamId,
    targetMessageId: params.targetMessageId,
    messageIds: [...params.messageIds].sort(),
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    )
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function payloadsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableStringify(left) === stableStringify(right)
}

/** Sentinel thrown when ON CONFLICT DO NOTHING suppresses a duplicate messages INSERT.
 *  Carries the existing message so the caller can return it after the txn rolls back. */
class DuplicateMessageError extends Error {
  constructor(readonly existingMessage: Message) {
    super("Duplicate clientMessageId detected via ON CONFLICT")
  }
}

/**
 * INV-E1: an E2E stream must carry a *complete* E2E payload (ciphertext +
 * envelope + e2eVersion), and a plaintext stream must carry none of them.
 * Either mismatch would persist a row that violates the encryption guarantee —
 * including a half-formed sealed row (ciphertext with no envelope is
 * undecryptable). The messaging create handler's Zod schema already requires
 * the three together; this sink backstops every other caller (scheduled-message
 * worker, public-API bot completion, future adapters) that bypasses it. Throws
 * the same error codes/copy the handler uses so the wire contract is identical
 * wherever the check fires.
 */
function assertE2eContentMatch(params: {
  streamIsE2e: boolean
  ciphertext?: Buffer
  envelope?: unknown
  e2eVersion?: number
}): void {
  const hasCiphertext = params.ciphertext !== undefined
  const hasEnvelope = params.envelope !== undefined
  const hasE2eVersion = params.e2eVersion !== undefined
  const hasAnyE2ePayload = hasCiphertext || hasEnvelope || hasE2eVersion

  // E2E stream: the full triple, or nothing valid. Plaintext stream: no E2E payload at all.
  if (params.streamIsE2e && hasCiphertext && hasEnvelope && hasE2eVersion) return
  if (!params.streamIsE2e && !hasAnyE2ePayload) return

  throw new HttpError(
    params.streamIsE2e
      ? "Stream is end-to-end encrypted; send ciphertext, envelope, and e2eVersion"
      : "Stream is not end-to-end encrypted; send plaintext content",
    {
      status: 400,
      code: params.streamIsE2e ? "E2E_STREAM_REQUIRES_CIPHERTEXT" : "E2E_PAYLOAD_REQUIRES_E2E_STREAM",
    }
  )
}

/**
 * Synchronous conversation assignment for a declared message, run inside the
 * send transaction. Implemented by the conversations feature and injected here
 * so messaging stays decoupled from conversation internals (the message just
 * carries a {@link ConversationDirective}; the assigner owns the conversation
 * row + its outbox events). Invoked only when a send declares a directive.
 */
export interface ConversationAssigner {
  /** Assigns the message to its declared conversation and returns that
   *  conversation's id — minted (a `new` post) or joined (`existing`,
   *  `threadFromMessage`, `newSubtopic`) — so the caller can surface it on the
   *  send response for an optimistic board card. */
  assignInTransaction(
    client: PoolClient,
    params: {
      workspaceId: string
      message: Message
      directive: ConversationDirective
      /** The send's stream, when the caller already holds it — a mint reads it to
       *  record the parent of a card-anchored thread, and re-reading here would
       *  add a query to every declared send. */
      stream?: Stream | null
      /** Human who initiated this explicit structural assignment. */
      initiatingUserId?: string
    }
  ): Promise<string>

  /** Attaches an UNDECLARED message to a cheap structural candidate, marked
   *  settling, so board viewers see it before the debounced extractor runs.
   *  Returns null when nothing suitable exists (the extractor assigns later) or
   *  the send isn't one extraction would cluster. Never mints. */
  attachProvisionalInTransaction(
    client: PoolClient,
    params: {
      workspaceId: string
      message: Message
      stream: Stream | null
      authorType: CreateMessageParams["authorType"]
    }
  ): Promise<string | null>
}

/**
 * Minimal thread stream shape `emitThreadUpdate` needs — accepts both the
 * repository's row-mapped `Stream` (dates) and the wire `Stream` (strings),
 * since only these anchor/identity/count fields are read.
 */
interface ThreadStreamStats {
  id: string
  workspaceId: string
  parentStreamId: string | null
  parentAnchorId?: string | null
  replyCount?: number
}

/**
 * Resolves the workspace's `composeTraces` rollout value. Injected rather than
 * read from a service locator so `EventService` stays constructed once with its
 * collaborators (INV-13) and the messaging feature never imports the
 * feature-flags feature's internals (INV-52).
 */
export type GetComposeTraceMode = (workspaceId: string) => Promise<FeatureFlagValue<"composeTraces">>

/**
 * Only a thread's messages are replies on its anchor. An aside is anchored the
 * same way (`parentStreamId` + `parentAnchorId`) but is private to its creator:
 * bumping the anchor's reply stats or emitting `thread:updated` for it would
 * hand the host message the aside as its thread.
 */
function isThreadReplyStream(
  stream: { type: string; parentStreamId: string | null; parentAnchorId?: string | null } | null | undefined
): stream is { type: string; parentStreamId: string; parentAnchorId: string } {
  return stream?.type === StreamTypes.THREAD && !!stream.parentStreamId && !!stream.parentAnchorId
}

export class EventService {
  constructor(
    private pool: Pool,
    private conversationAssigner?: ConversationAssigner,
    private getComposeTraceMode?: GetComposeTraceMode
  ) {}

  /**
   * Emit the projection patch(es) for a thread whose reply stats just changed.
   * The thread IS the stream its replies land in, so `threadStream` carries the
   * post-mutation `replyCount` (read off `streams.reply_count` via the caller's
   * `bumpThreadReplyCount`) and the anchor it hangs under.
   *
   * Emits `thread:updated` for EVERY anchor kind (message- or event-anchored),
   * routed to the parent stream room. `includeReplyCount` (default true) carries
   * the authoritative post-mutation count on that payload; the edit path passes
   * false so it refreshes only `threadSummary` and never republishes an unlocked
   * thread-stream count a concurrent create/delete already advanced (INV-20).
   */
  private async emitThreadUpdate(
    client: PoolClient,
    threadStream: ThreadStreamStats | null,
    options: { includeReplyCount?: boolean } = {}
  ): Promise<void> {
    if (!threadStream?.parentStreamId) return
    const anchorId = threadStream.parentAnchorId
    if (!anchorId) return
    const includeReplyCount = options.includeReplyCount ?? true

    const threadSummary = await StreamRepository.findThreadSummaryByParentMessage(
      client,
      threadStream.parentStreamId,
      anchorId
    )
    await OutboxRepository.insert(client, "thread:updated", {
      workspaceId: threadStream.workspaceId,
      streamId: threadStream.parentStreamId,
      parentStreamId: threadStream.parentStreamId,
      anchorId,
      threadId: threadStream.id,
      ...(includeReplyCount ? { replyCount: threadStream.replyCount ?? 0 } : {}),
      threadSummary,
    })
  }

  private async resolveActorType(
    client: PoolClient,
    streamId: string,
    actorId: string,
    actorType?: AuthorType,
    existingMessage?: Pick<Message, "authorId" | "authorType">
  ): Promise<AuthorType> {
    if (actorType) return actorType

    if (existingMessage && existingMessage.authorId === actorId) {
      return existingMessage.authorType
    }

    const [isMember, isPersona] = await Promise.all([
      StreamMemberRepository.isMember(client, streamId, actorId),
      StreamPersonaParticipantRepository.hasParticipated(client, streamId, actorId),
    ])

    if (isMember && isPersona) {
      throw new Error(`Actor ${actorId} has ambiguous type in stream ${streamId}`)
    }
    if (isMember) return AuthorTypes.USER
    if (isPersona) return AuthorTypes.PERSONA

    throw new Error(`Actor ${actorId} has no resolved type in stream ${streamId}`)
  }

  async createMessage(params: CreateMessageParams): Promise<Message> {
    return (await this.createMessageReturningConversationInternal(params)).message
  }

  /**
   * Same send as {@link createMessage}, but also returns the id of the
   * conversation a declared directive assigned the message to (minted for `new`,
   * joined for `existing`/`threadFromMessage`/`newSubtopic`) — `undefined` when
   * no directive was declared. The board composer surfaces it on the send
   * response so it can write an optimistic board card keyed by the real
   * conversation id (no temp-id swap), reconciled by the `conversation:*` echo.
   * `onCreated` joins the same transaction and runs only for the winning insert.
   */
  async createMessageReturningConversationInternal(
    params: CreateMessageParams,
    onCreated?: (client: PoolClient, message: Message) => Promise<void>
  ): Promise<{ message: Message; conversationId?: string }> {
    return this.createMessageReturningConversationWithAuthority({ kind: "internal" }, params, onCreated)
  }

  async assertStreamWritableForPrincipal(
    principal: StreamWritePrincipal,
    workspaceId: string,
    streamId: string
  ): Promise<void> {
    await withTransaction(this.pool, (client) => assertStreamWritable(client, { workspaceId, streamId, principal }))
  }

  async createMessageForPrincipalReturningConversation(
    principal: StreamWritePrincipal,
    params: CreateMessageParams,
    onCreated?: (client: PoolClient, message: Message) => Promise<void>
  ): Promise<{ message: Message; conversationId?: string }> {
    return this.createMessageReturningConversationWithAuthority({ kind: "principal", principal }, params, onCreated)
  }

  private async createMessageReturningConversationWithAuthority(
    authority: MessageMutationAuthority,
    params: CreateMessageParams,
    onCreated?: (client: PoolClient, message: Message) => Promise<void>
  ): Promise<{ message: Message; conversationId?: string }> {
    try {
      const result = await this._createMessageTxn(authority, params, onCreated)
      return { message: result.message, ...(result.conversationId && { conversationId: result.conversationId }) }
    } catch (error) {
      // Concurrent duplicate: the txn rolled back (no orphaned stream_events/outbox),
      // and we return the already-committed message from the winning transaction.
      // No conversation id — the winner already surfaced its own; the loser's
      // optimistic card would double the winner's, so leave it to the echo/refetch.
      if (error instanceof DuplicateMessageError) {
        if (authority.kind === "principal") {
          await withTransaction(this.pool, async (client) => {
            await resolveLockedStreamAuthorities(client, {
              workspaceId: params.workspaceId,
              streamIds: [error.existingMessage.streamId],
              principal: authority.principal,
            })
            const principalId =
              authority.principal.kind === "user" ? authority.principal.userId : authority.principal.botId
            const principalType = authority.principal.kind === "user" ? AuthorTypes.USER : AuthorTypes.BOT
            if (error.existingMessage.authorId !== principalId || error.existingMessage.authorType !== principalType) {
              throw new HttpError("Cannot return another actor's message", { status: 403, code: "FORBIDDEN" })
            }
          })
        }
        return { message: error.existingMessage }
      }
      throw error
    }
  }

  async createGeneratedMessage(principal: StreamWritePrincipal, params: CreateMessageParams): Promise<Message> {
    return withTransaction(
      this.pool,
      async (client) => (await this.createMessageForPrincipalInTransaction(client, principal, params)).message
    )
  }

  async createMessageForPrincipalInTransaction(
    client: PoolClient,
    principal: StreamWritePrincipal,
    params: CreateMessageParams
  ): Promise<{ message: Message; conversationId?: string; created: boolean }> {
    if (params.clientMessageId) {
      const existing = await MessageRepository.findByClientMessageId(client, params.streamId, params.clientMessageId)
      if (existing) {
        await resolveLockedStreamAuthorities(client, {
          workspaceId: params.workspaceId,
          streamIds: [existing.streamId],
          principal,
        })
        if (existing.authorId !== params.authorId || existing.authorType !== params.authorType) {
          throw new HttpError("Cannot return another actor's message", { status: 403, code: "FORBIDDEN" })
        }
        return { message: existing, created: false }
      }
    }
    await assertStreamWritable(client, {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      principal,
    })
    return this.createMessageInTransaction(client, params, principal.kind === "user" ? principal.userId : undefined)
  }

  async createMessageInTransaction(
    client: PoolClient,
    params: CreateMessageParams,
    initiatingUserId?: string
  ): Promise<{ message: Message; conversationId?: string; created: boolean }> {
    // Fast path for sequential retries: return the existing message without
    // writes. No conversation id — the first send already surfaced it; a retry
    // reconciles through the echo/refetch, not a fresh optimistic card.
    if (params.clientMessageId) {
      const existing = await MessageRepository.findByClientMessageId(client, params.streamId, params.clientMessageId)
      if (existing) return { message: existing, created: false }
    }
    // The enclave seals its E2E reply with the message AAD bound to a
    // server-minted id, so the caller can pass that same id here to keep the
    // stored row's id and the envelope's bound id identical (INV-E*). Defaults
    // to a fresh id for every other caller.
    const msgId = params.id ?? messageId()
    const evtId = eventId()

    const stream = await StreamRepository.findById(client, params.streamId)

    // INV-E1 backstop at the write sink: an E2E stream stores only ciphertext, a
    // plaintext stream never carries an E2E envelope. The create handler checks
    // this too, but the sink covers every other caller (scheduled-message worker,
    // public-API bot completion). `findById` already LEFT JOINs `e2e_streams`, so
    // `e2eEnabled` reads off the loaded row without a second SELECT.
    assertE2eContentMatch({
      streamIsE2e: stream?.e2eEnabled === true,
      ciphertext: params.ciphertext,
      envelope: params.envelope,
      e2eVersion: params.e2eVersion,
    })

    // Rewrite slug-only mention/channel ids to authoritative actor/stream ids
    // (INV-64) before the body feeds projections, mention extraction, and the
    // outbox payload. No-op when ids are already resolved (rich-client writes).
    // When resolution changes an id, re-derive the markdown so the wire form
    // (`[@slug](user:usr_x)`) stays consistent with the JSON.
    const resolvedCreate = await resolveMentionContent(
      client,
      params.workspaceId,
      params.contentJson,
      // A personal persona resolves by slug only for its owner: pass the author
      // when they are a user; a persona/bot/system author resolves none.
      params.authorType === "user" ? params.authorId : undefined
    )
    if (resolvedCreate.changed) {
      params.contentJson = resolvedCreate.contentJson
      params.contentMarkdown = deriveContentMarkdown(resolvedCreate.contentJson)
    }

    // Pin every quote/share node to a source revision + span and re-derive the
    // quote bodies from it (the server is the sole writer of a quote snippet).
    // Runs before the event, the projections and the outbox so they all read
    // the pinned body. Skipped in E2E streams: the stored content is a
    // placeholder there and carries no references.
    if (stream?.e2eEnabled !== true) {
      const resolvedReferences = await resolveMessageReferences(client, {
        workspaceId: params.workspaceId,
        contentJson: params.contentJson,
        targetStreamId: params.streamId,
        canReadSourceStream: this.sourceStreamReader(
          client,
          params.workspaceId,
          params.authorId,
          params.accessibleStreamIds
        ),
      })
      if (resolvedReferences.changed) {
        params.contentJson = resolvedReferences.contentJson
        params.contentMarkdown = deriveContentMarkdown(resolvedReferences.contentJson)
      }
    }

    // Validate attachments before creating the event. Two flavors:
    // - "new" (`messageId === null`): fresh upload, ownership anchored to this
    //   message via `attachToMessage` below.
    // - "referenced" (`messageId !== null`): body re-uses an attachment owned by
    //   a previous message; ownership stays put and an `attachment_references`
    //   row records the pointer.
    // Verifying the author can read a referenced attachment closes the abuse of
    // submitting an arbitrary id to get it silently summarised on the wire.
    let attachmentSummaries: AttachmentSummary[] | undefined
    const attachmentsToAttach: string[] = []
    const attachmentsToReference: string[] = []
    if (params.attachmentIds && params.attachmentIds.length > 0) {
      const attachments = await AttachmentRepository.findByIds(client, params.attachmentIds)
      if (attachments.length !== params.attachmentIds.length) {
        throw new Error("Invalid attachment IDs: not all attachments were found")
      }
      for (const a of attachments) {
        if (a.workspaceId !== params.workspaceId) {
          throw new Error("Invalid attachment IDs: must belong to this workspace")
        }
        // Shareable = scanned-clean OR E2E ciphertext (unscannable, owner's own
        // bytes). Single source of truth with the download path. One widening:
        // the author's OWN still-settling reservation may bind (send-while-
        // uploading) — it renders as an inert status chip and stays
        // non-downloadable until the scan settles clean.
        if (!isAttachmentSafeForSharing(a.safetyStatus)) {
          const isPendingReservation =
            (a.safetyStatus === AttachmentSafetyStatuses.PENDING_UPLOAD ||
              a.safetyStatus === AttachmentSafetyStatuses.PENDING_SCAN) &&
            a.messageId === null &&
            a.uploadedBy === params.authorId
          if (!isPendingReservation) {
            throw new Error(
              "Invalid attachment IDs: must be malware-scan clean, E2E-encrypted, or this author's own pending upload"
            )
          }
        }
        // INV-E1 backstop, the attachment sibling of assertE2eContentMatch: a
        // sealed message binds only E2E ciphertext rows (a plaintext row would
        // surface its real filename in the E2E stream's event payload), and a
        // plaintext message never binds an E2E row (its key/filename live only
        // in a sealed payload no plaintext reader can open).
        if ((a.e2eOnly === true) !== (params.ciphertext !== undefined)) {
          throw new Error(
            a.e2eOnly
              ? "Invalid attachment IDs: an E2E attachment can only be bound to a sealed message"
              : "Invalid attachment IDs: a sealed message can only bind E2E attachments"
          )
        }
        if (a.messageId === null) {
          attachmentsToAttach.push(a.id)
          continue
        }
        // Gate on the author's read access via the same chain `getDownloadUrl`
        // honours so the two paths can never disagree. User authors use
        // membership lookups keyed by `authorId`; persona authors pass
        // `accessibleStreamIds` from `AgentAccessSpec`, which is scope-restricted
        // (NOT the invoking user's full reach) — bypassing it with a user-id check
        // would let agents resurface attachments the user couldn't surface here.
        let accessible = false
        if (params.accessibleStreamIds) {
          const accessibleSet = new Set(params.accessibleStreamIds)
          if (a.streamId && accessibleSet.has(a.streamId)) {
            accessible = true
          } else {
            const refStreamIds = await AttachmentReferenceRepository.findReferencingStreamIds(
              client,
              params.workspaceId,
              a.id
            )
            accessible = refStreamIds.some((streamId) => accessibleSet.has(streamId))
          }
        } else {
          if (a.streamId) {
            accessible = (await checkStreamAccess(client, a.streamId, params.workspaceId, params.authorId)) !== null
          }
          if (!accessible) {
            accessible = await isAttachmentReadableViaShareOrReference(client, a, params.workspaceId, params.authorId)
          }
        }
        if (!accessible) {
          throw new Error("Invalid attachment IDs: cannot reference an attachment without read access")
        }
        attachmentsToReference.push(a.id)
      }

      // Bind fresh uploads BEFORE baking summaries into the event payload. The
      // UPDATE takes the row locks a concurrent upload-settle also takes
      // (`completeReservedUpload` locks FOR UPDATE), so re-reading pending rows
      // afterwards observes any settle that committed first — otherwise the
      // payload freezes "uploading" for an upload that already finished, and
      // that settle's status event was skipped (the row was unbound then).
      if (attachmentsToAttach.length > 0) {
        const attached = await AttachmentRepository.attachToMessage(client, attachmentsToAttach, msgId, params.streamId)
        if (attached !== attachmentsToAttach.length) {
          // A concurrent send with the same clientMessageId may have won the
          // bind: attach now runs BEFORE the message insert (whose ON CONFLICT
          // is the usual duplicate detector), so the loser surfaces here.
          // Route it to the duplicate-recovery path instead of a hard error.
          if (params.clientMessageId) {
            const winner = await MessageRepository.findByClientMessageId(
              client,
              params.streamId,
              params.clientMessageId
            )
            if (winner) throw new DuplicateMessageError(winner)
          }
          throw new Error("Failed to attach all files")
        }
      }

      let summaryRows = attachments
      const pendingIds = attachments.filter((a) => !isAttachmentSafeForSharing(a.safetyStatus)).map((a) => a.id)
      let uploadsByAttachmentId = new Map<string, AttachmentUpload>()
      if (pendingIds.length > 0) {
        const refreshed = await AttachmentRepository.findByIds(client, pendingIds)
        const refreshedById = new Map(refreshed.map((a) => [a.id, a]))
        summaryRows = attachments.map((a) => refreshedById.get(a.id) ?? a)
        const stillPendingIds = summaryRows.filter((a) => !isAttachmentSafeForSharing(a.safetyStatus)).map((a) => a.id)
        uploadsByAttachmentId = await AttachmentUploadRepository.findByAttachmentIds(
          client,
          params.workspaceId,
          stillPendingIds
        )
      }
      attachmentSummaries = summaryRows.map((a) => toAttachmentSummary(a, uploadsByAttachmentId.get(a.id)?.status))
    }

    // Non-empty metadata only — keep payloads and projections clean of `{}`.
    // The agent-block marker is derived here from the content itself: callers
    // can't write `threa.*` (metadata-schema.ts rejects it), so attribution
    // for agent-written text can't be spoofed or omitted.
    const metadata = withDerivedMessageMetadata(params.metadata, collectAgentBlockAuthorIds(params.contentJson))

    // A message that declares an EXISTING conversation carries that id on its
    // event payload so the flat-timeline provenance chip renders membership the
    // instant the message lands (Mechanism C), instead of
    // waiting for the async conversation list. The id is known here without any
    // conversation read; the assigner below still row-locks + validates it (a
    // cross-root/stale id rolls back the whole send). `new`/thread-from-message
    // declarations are chip-less openers, so only `existing` is stamped.
    const declaredConversationId =
      params.conversation?.intent === ConversationIntents.EXISTING ? params.conversation.conversationId : undefined

    // Resolved against the citing stream's ROOT: a thread inherits its root's
    // audience (INV-62), and this payload is delivered to that whole room.
    const memoEmbeds = await resolveMemoEmbedSummaries(
      client,
      params.workspaceId,
      params.contentJson,
      stream?.rootStreamId ?? params.streamId
    )

    const event = await StreamEventRepository.insert(client, {
      id: evtId,
      streamId: params.streamId,
      eventType: "message_created",
      payload: {
        messageId: msgId,
        contentJson: params.contentJson,
        contentMarkdown: params.contentMarkdown,
        revision: 1,
        ...(attachmentSummaries && { attachments: attachmentSummaries }),
        ...(params.sources && params.sources.length > 0 && { sources: params.sources }),
        ...(params.sessionId && { sessionId: params.sessionId }),
        ...(params.clientMessageId && { clientMessageId: params.clientMessageId }),
        ...(params.sentVia && { sentVia: params.sentVia }),
        ...(declaredConversationId && { declaredConversationId }),
        ...(memoEmbeds.length > 0 && { memoEmbeds }),
        ...(metadata && { metadata }),
        ...(params.ciphertext && { ciphertext: params.ciphertext.toString("base64") }),
        ...(params.envelope !== undefined && { envelope: params.envelope }),
        ...(params.e2eVersion !== undefined && { e2eVersion: params.e2eVersion }),
      } satisfies MessageCreatedPayload,
      actorId: params.authorId,
      actorType: params.authorType,
    })

    const message = await MessageRepository.insert(client, {
      id: msgId,
      streamId: params.streamId,
      sequence: event.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      clientMessageId: params.clientMessageId,
      sentVia: params.sentVia,
      metadata,
      conversationIntent: params.conversation?.intent,
      ciphertext: params.ciphertext,
      envelope: params.envelope,
      e2eVersion: params.e2eVersion,
    })

    // Concurrent duplicate detected: ON CONFLICT DO NOTHING suppressed our INSERT,
    // so the repository returned the existing message (different ID). Throw to
    // rollback the transaction — this prevents orphaned stream_events and outbox
    // entries that would reference our never-created msgId (INV-20).
    if (message.id !== msgId) {
      throw new DuplicateMessageError(message)
    }

    // Increment only after confirming this transaction owns the new message,
    // so concurrent duplicate losers (rolled back above) never overcount.
    messagesTotal.inc({
      workspace_id: params.workspaceId,
      stream_type: stream?.type || "unknown",
      author_type: params.authorType,
    })

    // Advance the author's read position so their own message isn't counted unread.
    // Read state is user-anchored: the born-read lands whether or not the author
    // holds a membership row (membership ≠ access ≠ read state).
    if (params.authorType === "user") {
      await ReadStateRepository.advance(client, params.streamId, params.authorId, evtId)
    }

    if (params.authorType === "persona") {
      await StreamPersonaParticipantRepository.recordParticipation(client, params.streamId, params.authorId)
    }

    // Compose-session provenance rides the send's own transaction so a trace can
    // never outlive a rolled-back message. Already gated on the `composeTraces`
    // flag by the caller (see `shouldCaptureComposeTrace`).
    if (params.composeTrace) {
      await MessageComposeTraceRepository.insert(client, {
        messageId: msgId,
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        horizonStreamId: params.composeTrace.horizonStreamId,
        openedAt: params.composeTrace.openedAt,
        openedAtSequence: params.composeTrace.openedAtSequence,
        sentAtSequence: params.composeTrace.sentAtSequence,
        resumedDraft: params.composeTrace.resumedDraft,
      })
    }

    // First-time attachments were linked (attachToMessage) before the event
    // payload was built — see the summary re-read above. Re-referenced
    // attachments keep their owning `message_id`/`stream_id`: overwriting them
    // would orphan the original `attachment:` link.

    // Record an attachment_references row for every attachment (newly-attached
    // and re-referenced) so "is this visible to a viewer of stream X?" lookups
    // consult one index regardless of original ownership.
    const attachmentReferenceIds = [...attachmentsToAttach, ...attachmentsToReference]
    if (attachmentReferenceIds.length > 0) {
      await AttachmentReferenceRepository.insertMany(
        client,
        attachmentReferenceIds.map((aid) => ({
          id: attachmentReferenceId(),
          workspaceId: params.workspaceId,
          attachmentId: aid,
          messageId: msgId,
          streamId: params.streamId,
        }))
      )
    }

    // "In this stream" projection (INV-7): links, media, files this message
    // carries, keyed by the message's own created_at. Sealed streams are never
    // indexed — the server can't read their content.
    if (stream?.e2eEnabled !== true) {
      await StreamContextRepository.insertMany(
        client,
        contextRowsForMessage({
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          rootStreamId: stream?.rootStreamId ?? params.streamId,
          messageId: msgId,
          authorId: params.authorId,
          occurredAt: message.createdAt,
          sequence: event.sequence,
          contentJson: params.contentJson,
          contentMarkdown: params.contentMarkdown,
          attachments: attachmentSummaries ?? [],
        })
      )
    }

    // Validate and record cross-stream share references in contentJson, inside
    // the transaction so the shared_messages access-projection commits atomically
    // with the event + projection (INV-7).
    await ShareService.validateAndRecordShares({
      client,
      workspaceId: params.workspaceId,
      targetStreamId: params.streamId,
      shareMessageId: msgId,
      sharerId: params.authorId,
      accessibleStreamIds: params.accessibleStreamIds,
      contentJson: params.contentJson,
      findStream: (db, id) => StreamRepository.findById(db, id),
      resolveEffectiveStream: resolveEffectiveStreamAdapter,
      isAncestor: (db, ancestorId, streamId) => StreamRepository.isAncestor(db, ancestorId, streamId),
      countExposedMembers: (db, targetStreamId, sourceStreamId) =>
        StreamMemberRepository.countMembersNotIn(db, targetStreamId, sourceStreamId),
      canReadStream: async (db, workspaceId, streamId, userId) =>
        (await checkStreamAccess(db, streamId, workspaceId, userId)) !== null,
      confirmedPrivacyWarning: params.confirmedPrivacyWarning,
    })

    const sharedMessageRefs = new Map<string, SharedMessageRef>()
    collectSharedMessageRefs(params.contentJson, sharedMessageRefs)
    const slotMaps =
      sharedMessageRefs.size > 0
        ? toDualSlotMaps(
            await hydrateSharedMessageRefsForRoom(
              client,
              params.workspaceId,
              params.streamId,
              sharedMessageRefs.values()
            )
          )
        : undefined

    await OutboxRepository.insert(client, "message:created", {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      event: serializeBigInt(event),
      ...(slotMaps && { slots: slotMaps.slots, sharedMessages: slotMaps.sharedMessages }),
    })

    // Stream activity for sidebar updates. sequence/messageOrdinal are absolute
    // stream facts: clients derive unread as latestOrdinal - lastReadOrdinal
    // rather than incrementing, so replayed/duplicated events converge. Exact
    // under concurrency because the sequence allocator's row lock serializes
    // message inserts per stream until commit.
    const messageOrdinal = await StreamEventRepository.countMessagesThrough(client, params.streamId, event.sequence)
    await OutboxRepository.insert(client, "stream:activity", {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      authorId: params.authorId,
      sequence: event.sequence.toString(),
      messageOrdinal,
      lastMessagePreview: {
        authorId: params.authorId,
        authorType: params.authorType,
        content: params.contentMarkdown,
        createdAt: event.createdAt.toISOString(),
      },
    })

    if (isThreadReplyStream(stream)) {
      const updatedThread = await StreamRepository.bumpThreadReplyCount(client, stream.id, 1)
      await this.emitThreadUpdate(client, updatedThread ?? stream)
    }

    // A declared message assigns its conversation synchronously, in this same
    // transaction (so the board sees it the instant the send returns and the
    // async extractor leaves it locked). The assigner is injected to keep
    // messaging decoupled from conversation internals; fail loud (INV-11) if a
    // directive arrives without one wired rather than silently dropping it. Its
    // returned id rides the send response for an optimistic board card.
    let conversationId: string | undefined
    if (params.conversation) {
      if (!this.conversationAssigner) {
        throw new Error("Message declares a conversation but no ConversationAssigner is configured")
      }
      conversationId = await this.conversationAssigner.assignInTransaction(client, {
        workspaceId: params.workspaceId,
        message,
        directive: params.conversation,
        stream: stream ?? null,
        initiatingUserId,
      })
    } else if (this.conversationAssigner) {
      // Undeclared: attach to a structural candidate, marked settling, so the
      // board isn't blind to the message until the debounced extractor runs.
      // The extractor still decides — `conversation_intent` stays NULL, so the
      // pass evaluates the message and re-files it when it disagrees.
      // The attach is an optimization; the send is the contract. A savepoint
      // (`withTransaction` on the client) so a failure rolls back only the
      // attach's writes — a bare try/catch would commit them half-done — and
      // the send completes exactly as if no candidate existed.
      try {
        conversationId =
          (await withTransaction(client, (tx) =>
            this.conversationAssigner!.attachProvisionalInTransaction(tx, {
              workspaceId: params.workspaceId,
              message,
              stream: stream ?? null,
              authorType: params.authorType,
            })
          )) ?? undefined
      } catch (err) {
        logger.warn(
          { err, messageId: message.id, streamId: params.streamId },
          "Provisional conversation attach failed; sending without it"
        )
      }
    }

    return { message, conversationId, created: true }
  }

  /**
   * Whether this send's client-supplied compose trace should be persisted.
   * Resolved BEFORE the send's transaction opens: the lookup is an uncached
   * query on its own pool connection, and issuing it while holding the send's
   * client would have two connections outstanding per send (INV-41). No trace
   * on the send means no lookup at all, so flag-off workspaces pay nothing.
   */
  private async shouldCaptureComposeTrace(params: CreateMessageParams): Promise<boolean> {
    if (!params.composeTrace || !this.getComposeTraceMode) return false
    return (await this.getComposeTraceMode(params.workspaceId)) === "capture"
  }

  private async _createMessageTxn(
    authority: MessageMutationAuthority,
    params: CreateMessageParams,
    onCreated?: (client: PoolClient, message: Message) => Promise<void>
  ): Promise<{ message: Message; conversationId?: string; created: boolean }> {
    // The trace is dropped here rather than inside the transaction, so
    // `createMessageInTransaction` can persist whatever reaches it.
    const gatedParams = (await this.shouldCaptureComposeTrace(params)) ? params : { ...params, composeTrace: undefined }
    return withTransaction(this.pool, async (client) => {
      if (gatedParams.clientMessageId) {
        const existing = await MessageRepository.findByClientMessageId(
          client,
          gatedParams.streamId,
          gatedParams.clientMessageId
        )
        if (existing) {
          if (authority.kind === "principal") {
            await resolveLockedStreamAuthorities(client, {
              workspaceId: gatedParams.workspaceId,
              streamIds: [existing.streamId],
              principal: authority.principal,
            })
            const principalId =
              authority.principal.kind === "user" ? authority.principal.userId : authority.principal.botId
            const principalType = authority.principal.kind === "user" ? AuthorTypes.USER : AuthorTypes.BOT
            if (existing.authorId !== principalId || existing.authorType !== principalType) {
              throw new HttpError("Cannot return another actor's message", { status: 403, code: "FORBIDDEN" })
            }
          }
          return { message: existing, created: false }
        }
      }
      if (authority.kind === "principal") {
        await assertStreamWritable(client, {
          workspaceId: gatedParams.workspaceId,
          streamId: gatedParams.streamId,
          principal: authority.principal,
        })
      }
      const result = await this.createMessageInTransaction(
        client,
        gatedParams,
        authority.kind === "principal" && authority.principal.kind === "user" ? authority.principal.userId : undefined
      )
      if (result.created) await onCreated?.(client, result.message)
      return result
    })
  }

  private async withPlacementRecovery<T>(
    messageId: string,
    candidateStreamId: string,
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T | { kind: "retry"; streamId: string }> {
    try {
      return await withTransaction(this.pool, operation)
    } catch (error) {
      const denial = error as { code?: string }
      if (denial.code !== "STREAM_READ_ONLY" && denial.code !== "STREAM_NOT_FOUND") throw error
      const current = await MessageRepository.findById(this.pool, messageId)
      if (current && current.streamId !== candidateStreamId) return { kind: "retry", streamId: current.streamId }
      throw error
    }
  }

  async editMessageInternal(params: EditMessageParams): Promise<Message | null> {
    return this.editMessageWithAuthority({ kind: "internal" }, params)
  }

  async editMessageForPrincipal(principal: StreamWritePrincipal, params: EditMessageParams): Promise<Message | null> {
    return this.editMessageWithAuthority({ kind: "principal", principal }, params)
  }

  async editGeneratedMessage(principal: StreamWritePrincipal, params: EditMessageParams): Promise<Message | null> {
    return this.editMessageWithAuthority({ kind: "principal", principal, presentationOwnerId: params.actorId }, params)
  }

  private async editMessageWithAuthority(
    authority: MessageMutationAuthority,
    params: EditMessageParams
  ): Promise<Message | null> {
    let streamId =
      authority.kind === "principal"
        ? ((await MessageRepository.findById(this.pool, params.messageId))?.streamId ?? params.streamId)
        : params.streamId
    for (let attempt = 0; attempt < 3; attempt++) {
      params = { ...params, streamId }
      const result = await this.withPlacementRecovery(params.messageId, streamId, async (client) => {
        if (authority.kind === "principal") {
          await assertStreamWritable(client, {
            workspaceId: params.workspaceId,
            streamId,
            principal: authority.principal,
          })
        }
        // INV-E1: no sealed-edit path exists yet, so editing in an E2E stream would
        // overwrite the sealed projection with plaintext and broadcast it. Refuse
        // until a ciphertext edit payload exists (the frontend also hides Edit here).
        if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, params.streamId)) {
          throw new HttpError("Cannot edit a message in an end-to-end-encrypted stream", {
            status: 400,
            code: "E2E_STREAM_EDIT_UNSUPPORTED",
          })
        }

        // Returns null if the message was concurrently deleted — prevents phantom edits
        const existing = await MessageRepository.findByIdForUpdate(client, params.messageId)
        if (!existing || existing.deletedAt) return { kind: "done" as const, value: null }
        if (existing.streamId !== streamId) return { kind: "retry" as const, streamId: existing.streamId }
        if (authority.kind === "principal") {
          const ownerId =
            authority.presentationOwnerId ??
            (authority.principal.kind === "user" ? authority.principal.userId : authority.principal.botId)
          if (existing.authorId !== ownerId) {
            throw new HttpError("Cannot modify another actor's message", { status: 403, code: "FORBIDDEN" })
          }
        }

        // No-op: content hasn't meaningfully changed
        if (params.contentMarkdown.trim() === existing.contentMarkdown.trim())
          return { kind: "done" as const, value: existing }

        const actorType = await this.resolveActorType(
          client,
          params.streamId,
          params.actorId,
          params.actorType,
          existing
        )

        // Resolve slug-only mention/channel ids before the edited body feeds the
        // event payload, projection, and outbox (INV-64). When resolution changes
        // an id, re-derive the markdown so the stored wire form matches the JSON.
        const resolvedEdit = await resolveMentionContent(
          client,
          params.workspaceId,
          params.contentJson,
          // Personal personas resolve by slug only for their owner (see create).
          actorType === "user" ? params.actorId : undefined
        )
        if (resolvedEdit.changed) {
          params.contentJson = resolvedEdit.contentJson
          params.contentMarkdown = deriveContentMarkdown(resolvedEdit.contentJson)
        }

        // Same pinning pass as the create path, before the version snapshot so
        // the snapshot and the event agree. E2E streams reject edits above.
        // `previousContentJson` marks which unpinned quotes were already there:
        // one whose snippet no longer matches the (since-edited) source must not
        // block the author from editing their own message.
        const resolvedEditReferences = await resolveMessageReferences(client, {
          workspaceId: params.workspaceId,
          contentJson: params.contentJson,
          previousContentJson: existing.contentJson,
          targetStreamId: params.streamId,
          canReadSourceStream: this.sourceStreamReader(
            client,
            params.workspaceId,
            params.actorId,
            params.accessibleStreamIds
          ),
        })
        if (resolvedEditReferences.changed) {
          params.contentJson = resolvedEditReferences.contentJson
          params.contentMarkdown = deriveContentMarkdown(resolvedEditReferences.contentJson)
        }

        const snapshot = await MessageVersionRepository.insert(client, {
          id: messageVersionId(),
          messageId: params.messageId,
          versionNumber: existing.revision,
          contentJson: existing.contentJson,
          contentMarkdown: existing.contentMarkdown,
          editedBy: params.actorId,
        })

        const editStream = await StreamRepository.findById(client, params.streamId)
        const memoEmbeds = await resolveMemoEmbedSummaries(
          client,
          params.workspaceId,
          params.contentJson,
          editStream?.rootStreamId ?? params.streamId
        )

        const event = await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: params.streamId,
          eventType: "message_edited",
          payload: {
            messageId: params.messageId,
            contentJson: params.contentJson,
            contentMarkdown: params.contentMarkdown,
            revision: snapshot.versionNumber + 1,
            memoEmbeds,
          } satisfies MessageEditedPayload,
          actorId: params.actorId,
          actorType,
        })

        const message = await MessageRepository.updateContent(
          client,
          params.messageId,
          params.contentJson,
          params.contentMarkdown
        )

        if (message) {
          // Re-validate share nodes: edits that add, remove, or swap share
          // references rewrite the shared_messages row set so
          // hydration/authorization reflects the new content. Without this, an
          // author could edit in a sharedMessage pointing at an arbitrary id and
          // leak its content past the create-time check.
          await ShareService.validateAndRecordShares({
            client,
            workspaceId: params.workspaceId,
            targetStreamId: params.streamId,
            shareMessageId: params.messageId,
            sharerId: params.actorId,
            accessibleStreamIds: params.accessibleStreamIds,
            contentJson: params.contentJson,
            findStream: (db, id) => StreamRepository.findById(db, id),
            resolveEffectiveStream: resolveEffectiveStreamAdapter,
            isAncestor: (db, ancestorId, streamId) => StreamRepository.isAncestor(db, ancestorId, streamId),
            countExposedMembers: (db, targetStreamId, sourceStreamId) =>
              StreamMemberRepository.countMembersNotIn(db, targetStreamId, sourceStreamId),
            canReadStream: async (db, workspaceId, streamId, userId) =>
              (await checkStreamAccess(db, streamId, workspaceId, userId)) !== null,
            confirmedPrivacyWarning: params.confirmedPrivacyWarning,
          })

          // Refresh `attachment_references` projection to match the new
          // contentJson (INV-7). Without this, an edit that adds or removes an
          // `attachment:` link leaves stale rows behind and download
          // authorization stops matching the persisted body. Reference-only —
          // fresh uploads aren't supported on edit (a zero-`messageId`
          // attachment id will fail the access validation here loudly).
          // Full delete-then-insert per edit; the projection is small and this
          // lets the helper share its access-check semantics with the create
          // path verbatim.
          const validatedReferenceIds = await this._validateEditAttachmentReferences(client, params)
          await AttachmentReferenceRepository.deleteByMessageId(client, params.workspaceId, params.messageId)
          if (validatedReferenceIds.length > 0) {
            await AttachmentReferenceRepository.insertMany(
              client,
              validatedReferenceIds.map((aid) => ({
                id: attachmentReferenceId(),
                workspaceId: params.workspaceId,
                attachmentId: aid,
                messageId: params.messageId,
                streamId: params.streamId,
              }))
            )
          }

          const sharedMessageRefs = new Map<string, SharedMessageRef>()
          collectSharedMessageRefs(params.contentJson, sharedMessageRefs)
          const slotMaps =
            sharedMessageRefs.size > 0
              ? toDualSlotMaps(
                  await hydrateSharedMessageRefsForRoom(
                    client,
                    params.workspaceId,
                    params.streamId,
                    sharedMessageRefs.values()
                  )
                )
              : undefined

          await OutboxRepository.insert(client, "message:edited", {
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            event: serializeBigInt(event),
            ...(slotMaps && { slots: slotMaps.slots, sharedMessages: slotMaps.sharedMessages }),
          })

          const stream = await StreamRepository.findById(client, params.streamId)

          // Rebuild the "In this stream" projection from the edited body. The
          // landmark keeps the message's ORIGINAL created_at — an edit must not
          // move it in the feed.
          const contextAttachments =
            validatedReferenceIds.length > 0 ? await AttachmentRepository.findByIds(client, validatedReferenceIds) : []
          await StreamContextRepository.replaceForMessage(
            client,
            params.workspaceId,
            params.messageId,
            contextRowsForMessage({
              workspaceId: params.workspaceId,
              streamId: params.streamId,
              rootStreamId: stream?.rootStreamId ?? params.streamId,
              messageId: params.messageId,
              authorId: existing.authorId,
              occurredAt: existing.createdAt,
              sequence: existing.sequence,
              contentJson: params.contentJson,
              contentMarkdown: params.contentMarkdown,
              attachments: contextAttachments,
            })
          )

          if (isThreadReplyStream(stream)) {
            // No count change on edit — refresh only the thread summary; omit
            // replyCount so a stale unlocked read can't clobber a concurrent
            // create/delete's authoritative count (INV-20).
            await this.emitThreadUpdate(client, stream, { includeReplyCount: false })
          }
        }

        return { kind: "done" as const, value: message }
      })
      if (result.kind === "done") return result.value
      streamId = result.streamId
    }
    throw new Error(`Message ${params.messageId} placement changed too many times`)
  }

  /**
   * Validate edit-time inline attachment references against the same gate
   * `_createMessageTxn` step 1 runs (workspace + safety + access). Only the
   * "reference" branch is supported on edit — fresh uploads (`messageId ===
   * null`) throw, since an existing message can't claim ownership of a fresh
   * upload (that's a create-time operation). Returns the validated id list,
   * which the caller passes straight into the `attachment_references` insert.
   *
   * Mirrors the create-step-1 access split:
   * - `accessibleStreamIds` set (persona path) → set-membership against the
   *   agent's `AgentAccessSpec` reach, plus reference-projection fallback.
   * - Otherwise (user path) → `checkStreamAccess(... actorId)` plus
   *   `isAttachmentReadableViaShareOrReference` for share-grant fallback.
   */
  /**
   * Read gate for a reference's source stream, mirroring the split
   * `ShareService` uses: an agent's precomputed reach when the caller passed
   * one (personas hold no `stream_members` rows), the actor's own access
   * otherwise. Thread sources resolve through their root inside
   * `checkStreamAccess` (INV-62).
   */
  private sourceStreamReader(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
    accessibleStreamIds?: string[]
  ): (streamId: string) => Promise<boolean> {
    if (accessibleStreamIds) {
      const reach = new Set(accessibleStreamIds)
      return async (streamId) => {
        if (reach.has(streamId)) return true
        const source = await StreamRepository.findById(client, streamId)
        if (!source) return false
        const effective = await resolveEffectiveStreamAdapter(client, source)
        return reach.has(effective.id)
      }
    }
    return async (streamId) => (await checkStreamAccess(client, streamId, workspaceId, actorId)) !== null
  }

  private async _validateEditAttachmentReferences(client: PoolClient, params: EditMessageParams): Promise<string[]> {
    if (!params.attachmentIds || params.attachmentIds.length === 0) return []

    const attachments = await AttachmentRepository.findByIds(client, params.attachmentIds)
    if (attachments.length !== params.attachmentIds.length) {
      throw new Error("Invalid attachment IDs: not all attachments were found")
    }

    const validated: string[] = []
    for (const a of attachments) {
      if (a.workspaceId !== params.workspaceId) {
        throw new Error("Invalid attachment IDs: must belong to this workspace")
      }
      // Shareable = scanned-clean OR E2E ciphertext (unscannable, owner's own
      // bytes). Single source of truth with the download path.
      if (!isAttachmentSafeForSharing(a.safetyStatus)) {
        throw new Error("Invalid attachment IDs: must be malware-scan clean or E2E-encrypted")
      }
      // INV-E1 backstop, mirroring the create path: only sealed messages may
      // bind E2E rows, and edits are plaintext-only (E2E edits are blocked
      // upstream), so an e2eOnly reference here is always wrong — it would
      // render as an undecryptable placeholder chip.
      if (a.e2eOnly === true) {
        throw new Error("Invalid attachment IDs: an E2E attachment can only be bound to a sealed message")
      }
      if (a.messageId === null) {
        // Fresh uploads aren't supported on edit — they'd need `attachToMessage`
        // claiming the row, which would orphan any other message that already
        // points at it (none today, but the invariant is worth preserving).
        throw new Error("Invalid attachment IDs: edits cannot attach fresh uploads — reference an existing attachment")
      }

      let accessible = false
      if (params.accessibleStreamIds) {
        const accessibleSet = new Set(params.accessibleStreamIds)
        if (a.streamId && accessibleSet.has(a.streamId)) {
          accessible = true
        } else {
          const refStreamIds = await AttachmentReferenceRepository.findReferencingStreamIds(
            client,
            params.workspaceId,
            a.id
          )
          accessible = refStreamIds.some((streamId) => accessibleSet.has(streamId))
        }
      } else {
        if (a.streamId) {
          accessible = (await checkStreamAccess(client, a.streamId, params.workspaceId, params.actorId)) !== null
        }
        if (!accessible) {
          accessible = await isAttachmentReadableViaShareOrReference(client, a, params.workspaceId, params.actorId)
        }
      }
      if (!accessible) {
        throw new Error("Invalid attachment IDs: cannot reference an attachment without read access")
      }
      validated.push(a.id)
    }

    return validated
  }

  async deleteMessageInternal(params: DeleteMessageParams): Promise<Message | null> {
    return this.deleteMessageWithAuthority({ kind: "internal" }, params)
  }

  async deleteMessageForPrincipal(
    principal: StreamWritePrincipal,
    params: DeleteMessageParams
  ): Promise<Message | null> {
    return this.deleteMessageWithAuthority({ kind: "principal", principal }, params)
  }

  async deleteGeneratedMessage(principal: StreamWritePrincipal, params: DeleteMessageParams): Promise<Message | null> {
    return this.deleteMessageWithAuthority(
      { kind: "principal", principal, presentationOwnerId: params.actorId },
      params
    )
  }

  private async deleteMessageWithAuthority(
    authority: MessageMutationAuthority,
    params: DeleteMessageParams
  ): Promise<Message | null> {
    let streamId =
      authority.kind === "principal"
        ? ((await MessageRepository.findById(this.pool, params.messageId))?.streamId ?? params.streamId)
        : params.streamId
    for (let attempt = 0; attempt < 3; attempt++) {
      params = { ...params, streamId }
      const result = await this.withPlacementRecovery(params.messageId, streamId, async (client) => {
        if (authority.kind === "principal") {
          await assertStreamWritable(client, {
            workspaceId: params.workspaceId,
            streamId,
            principal: authority.principal,
          })
        }
        const existing = await MessageRepository.findByIdForUpdate(client, params.messageId)
        if (!existing || existing.deletedAt) return { kind: "done" as const, value: null }
        if (existing.streamId !== streamId) return { kind: "retry" as const, streamId: existing.streamId }
        if (authority.kind === "principal") {
          const ownerId =
            authority.presentationOwnerId ??
            (authority.principal.kind === "user" ? authority.principal.userId : authority.principal.botId)
          if (existing.authorId !== ownerId) {
            throw new HttpError("Cannot modify another actor's message", { status: 403, code: "FORBIDDEN" })
          }
        }

        const actorType = await this.resolveActorType(
          client,
          params.streamId,
          params.actorId,
          params.actorType,
          existing
        )

        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: params.streamId,
          eventType: "message_deleted",
          payload: {
            messageId: params.messageId,
          } satisfies MessageDeletedPayload,
          actorId: params.actorId,
          actorType,
        })

        const message = await MessageRepository.softDelete(client, params.messageId)

        // A2 (sparse-read design): a deleted message's unread activity rows would
        // otherwise survive forever unless the user opens that exact stream, keeping
        // a phantom badge. Mark them read in the delete transaction; clients drop
        // held rows for the id on the `message_deleted` stream event.
        await client.query(sql`
        UPDATE user_activity
        SET read_at = NOW()
        WHERE workspace_id = ${params.workspaceId}
          AND message_id = ${params.messageId}
          AND read_at IS NULL
      `)

        await StreamContextRepository.deleteByMessageId(client, params.workspaceId, params.messageId)

        if (message) {
          await OutboxRepository.insert(client, "message:deleted", {
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            messageId: params.messageId,
            deletedAt: message.deletedAt!.toISOString(),
          })

          const stream = await StreamRepository.findById(client, params.streamId)
          if (isThreadReplyStream(stream)) {
            const updatedThread = await StreamRepository.bumpThreadReplyCount(client, stream.id, -1)
            await this.emitThreadUpdate(client, updatedThread ?? stream)
          }
        }

        return { kind: "done" as const, value: message }
      })
      if (result.kind === "done") return result.value
      streamId = result.streamId
    }
    throw new Error(`Message ${params.messageId} placement changed too many times`)
  }

  async moveMessagesToThreadInternal(params: MoveMessagesToThreadParams): Promise<MoveMessagesToThreadResult> {
    return this.moveMessagesToThreadWithAuthority({ kind: "internal" }, params)
  }

  async moveMessagesToThreadForPrincipal(
    principal: StreamWritePrincipal,
    params: MoveMessagesToThreadParams
  ): Promise<MoveMessagesToThreadResult> {
    return this.moveMessagesToThreadWithAuthority({ kind: "principal", principal }, params)
  }

  private async moveMessagesToThreadWithAuthority(
    authority: MessageMutationAuthority,
    params: MoveMessagesToThreadParams
  ): Promise<MoveMessagesToThreadResult> {
    const uniqueMessageIds = Array.from(new Set(params.messageIds))
    if (uniqueMessageIds.length === 0) {
      throw new HttpError("At least one message is required", { status: 400, code: "NO_MESSAGES_SELECTED" })
    }

    return withTransaction(this.pool, async (client) => {
      const lease = await OperationLeaseRepository.consume(client, {
        id: params.leaseKey,
        workspaceId: params.workspaceId,
        userId: params.actorId,
        operationType: MOVE_MESSAGES_TO_THREAD_OPERATION,
      })
      if (!lease) {
        throw new HttpError("Move validation lease is missing or expired", {
          status: 409,
          code: "MOVE_LEASE_REQUIRED",
        })
      }
      const expectedLeasePayload = canonicalMoveLeasePayload({
        sourceStreamId: params.sourceStreamId,
        targetMessageId: params.targetMessageId,
        messageIds: uniqueMessageIds,
      })
      if (!payloadsEqual(lease.payload, expectedLeasePayload)) {
        throw new HttpError("Move validation lease does not match this request", {
          status: 409,
          code: "MOVE_LEASE_MISMATCH",
        })
      }

      if (authority.kind === "principal") {
        const existingDestination = await StreamRepository.findByAnchor(
          client,
          params.sourceStreamId,
          params.targetMessageId
        )
        await assertStreamsWritable(client, {
          workspaceId: params.workspaceId,
          streamIds: [params.sourceStreamId, ...(existingDestination ? [existingDestination.id] : [])],
          principal: authority.principal,
        })
      }

      const sourceStream = await StreamRepository.findById(client, params.sourceStreamId)
      if (!sourceStream || sourceStream.workspaceId !== params.workspaceId) {
        throw new StreamNotFoundError()
      }
      if (sourceStream.archivedAt) {
        throw new HttpError("Cannot move messages from an archived stream", { status: 403, code: "STREAM_ARCHIVED" })
      }

      const isMember = await StreamMemberRepository.isMember(
        client,
        sourceStream.rootStreamId ?? sourceStream.id,
        params.actorId
      )
      if (!isMember) {
        throw new HttpError("Not a member of this stream", { status: 403, code: "NOT_STREAM_MEMBER" })
      }

      const targetMessage = await MessageRepository.findByIdForUpdate(client, params.targetMessageId)
      if (
        !targetMessage ||
        targetMessage.streamId !== params.sourceStreamId ||
        targetMessage.deletedAt ||
        uniqueMessageIds.includes(targetMessage.id)
      ) {
        throw new MessageNotFoundError()
      }

      const selectedMessages = await MessageRepository.findByIdsForUpdate(client, uniqueMessageIds)
      if (selectedMessages.length !== uniqueMessageIds.length) {
        throw new MessageNotFoundError()
      }
      if (selectedMessages.some((message) => message.streamId !== params.sourceStreamId || message.deletedAt)) {
        throw new HttpError("Selected messages must be active messages in the source stream", {
          status: 400,
          code: "INVALID_MOVE_SELECTION",
        })
      }
      if (selectedMessages.some((message) => message.sequence <= targetMessage.sequence)) {
        throw new HttpError("Messages can only be moved onto a preceding message", {
          status: 400,
          code: "TARGET_MUST_PRECEDE_SELECTION",
        })
      }

      const rootStreamId = sourceStream.rootStreamId ?? sourceStream.id
      const rootStream =
        rootStreamId === sourceStream.id ? sourceStream : await StreamRepository.findById(client, rootStreamId)
      if (!rootStream) {
        throw new StreamNotFoundError()
      }
      const inheritedVisibility = rootStream.visibility
      const inheritedCompanionMode =
        rootStream.type === StreamTypes.SCRATCHPAD ? rootStream.companionMode : CompanionModes.OFF
      const inheritedCompanionPersonaId =
        rootStream.type === StreamTypes.SCRATCHPAD ? (rootStream.companionPersonaId ?? undefined) : undefined

      const { stream: destinationThread, created } = await StreamRepository.insertThreadOrFind(client, {
        id: generateStreamId(),
        workspaceId: params.workspaceId,
        type: StreamTypes.THREAD,
        parentStreamId: params.sourceStreamId,
        parentAnchorId: params.targetMessageId,
        rootStreamId,
        visibility: inheritedVisibility,
        companionMode: inheritedCompanionMode,
        companionPersonaId: inheritedCompanionPersonaId,
        createdBy: params.actorId,
      })
      if (destinationThread.archivedAt) {
        throw new HttpError("Cannot move messages into an archived thread", { status: 403, code: "THREAD_ARCHIVED" })
      }

      // insert is idempotent (ON CONFLICT (stream_id, member_id) DO NOTHING),
      // so we can call it unconditionally for both the actor and the target
      // message's author without a precheck round-trip.
      await StreamMemberRepository.insert(client, destinationThread.id, params.actorId)
      if (targetMessage.authorType === AuthorTypes.USER && targetMessage.authorId !== params.actorId) {
        await StreamMemberRepository.insert(client, destinationThread.id, targetMessage.authorId)
      }

      const sourceEvents = await StreamEventRepository.findMessageCreatedByMessageIdsForUpdate(
        client,
        params.sourceStreamId,
        uniqueMessageIds
      )
      if (sourceEvents.length !== uniqueMessageIds.length) {
        throw new HttpError("Could not find source events for all selected messages", {
          status: 409,
          code: "MOVE_SOURCE_EVENTS_MISSING",
        })
      }

      const agentSessionIds = await MessageRepository.findAgentSessionIdsForMessages(client, {
        sourceStreamId: params.sourceStreamId,
        messageIds: uniqueMessageIds,
      })
      const sourceAgentSessionEvents = await StreamEventRepository.findAgentSessionEventsBySessionIdsForUpdate(
        client,
        params.sourceStreamId,
        agentSessionIds
      )
      const movableEvents = [
        ...sourceEvents.map((event) => ({
          kind: "message" as const,
          event,
          messageId: (event.payload as MessageCreatedPayload).messageId,
        })),
        ...sourceAgentSessionEvents.map((event) => ({
          kind: "agent_session" as const,
          event,
        })),
      ].sort((left, right) => {
        if (left.event.sequence < right.event.sequence) return -1
        if (left.event.sequence > right.event.sequence) return 1
        return left.event.id.localeCompare(right.event.id)
      })

      // Every movable event is a broadcast timeline type (message_created /
      // agent_session:*), so each gets a fresh (sequence, broadcastSequence)
      // pair at the destination — the destination chain stays dense (INV-61).
      const nextSequencePairs = await StreamEventRepository.getNextSequencePairs(
        client,
        destinationThread.id,
        movableEvents.length
      )
      const updates: MoveMessageSequenceUpdate[] = []
      const agentSessionEventUpdates: MoveEventIdSequenceUpdate[] = []
      movableEvents.forEach((entry, index) => {
        const pair = nextSequencePairs[index]
        if (entry.kind === "message") {
          updates.push({
            messageId: entry.messageId,
            sequence: pair.sequence,
            broadcastSequence: pair.broadcastSequence,
          })
        } else {
          agentSessionEventUpdates.push({
            eventId: entry.event.id,
            sequence: pair.sequence,
            broadcastSequence: pair.broadcastSequence,
          })
        }
      })

      // The slots these events occupied in the SOURCE stream's broadcast
      // chain are vacated by the move. Declare them on the source tombstone
      // so clients can tell "moved away" apart from "missed" (INV-61).
      // movableEvents is already in ascending source-sequence order, and
      // broadcast order matches global order, so no re-sort is needed.
      const vacatedBroadcastSequences = movableEvents
        .map((entry) => entry.event.broadcastSequence)
        .filter((value): value is bigint => value !== null)
        .map((value) => value.toString())

      // Pre-generate the destination tombstone's event ID so it can be
      // stamped onto each relocated `message_created` payload via
      // `movedFrom.moveTombstoneId`. The destination side relies on the
      // per-message origin badge + a context-menu drill-in (rather than an
      // inline tombstone row) — that drill-in needs to look up the
      // tombstone in IDB by ID, so the message has to know which one.
      const destinationTombstoneId = eventId()

      const movedAt = new Date()
      const movedEvents = await StreamEventRepository.moveMessageCreatedEvents(client, {
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        updates,
        movedFrom: {
          sourceStreamSlug: sourceStream.slug,
          sourceStreamDisplayName: sourceStream.displayName,
          movedAt: movedAt.toISOString(),
          movedBy: params.actorId,
          movedByType: AuthorTypes.USER,
          moveTombstoneId: destinationTombstoneId,
        },
      })
      const movedAgentSessionEvents = await StreamEventRepository.moveEventsById(client, {
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        updates: agentSessionEventUpdates,
      })
      await MessageRepository.moveToStream(client, destinationThread.id, updates)

      // Sparse-read follow-through, run AFTER
      // the events are relocated so the destination sequences are readable:
      //  - rehome every member's overlay rows for the moved messages to the
      //    destination (stream_id/event_id/sequence refreshed), and
      //  - A3: repoint any SOURCE membership whose watermark was one of the moved
      //    events to the nearest surviving prior source event — otherwise it counts
      //    unread against a foreign thread-space sequence (survives reload).
      await SparseReadRepository.rehomeReads(client, {
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        messageIds: uniqueMessageIds,
      })
      // A3: repoint any read-state row whose watermark was a moved event.
      await ReadStateRepository.repointForMovedEvents(
        client,
        params.sourceStreamId,
        movableEvents.map((entry) => ({ eventId: entry.event.id, sequence: entry.event.sequence }))
      )

      // Thread re-pointing: the target message just became a thread, so any reply
      // draft composed against it (scope `thread:{targetMessageId}`) follows the
      // message into the new thread stream (`stream:{destinationThread.id}`).
      // Drafts are private per author but a shared target can hold several
      // authors' reply drafts, so this re-scopes every owner's draft and emits
      // one user-scoped `draft:upserted` each — in this same transaction so the
      // re-point and the move commit together (INV-4/7).
      const rescopedDrafts = await DraftsRepository.rescopeByScope(client, {
        workspaceId: params.workspaceId,
        fromScope: draftThreadScope(params.targetMessageId),
        toScope: draftStreamScope(destinationThread.id),
        rootStreamId,
      })
      if (rescopedDrafts.length > 0) {
        await OutboxRepository.insertMany(
          client,
          rescopedDrafts.map((draft) => ({
            eventType: "draft:upserted" as const,
            payload: {
              workspaceId: params.workspaceId,
              targetUserId: draft.userId,
              draft: toDraftView(draft),
            },
          }))
        )
      }

      // The moved messages' context rows follow them into the destination
      // thread; the thread inherits the source's root, so the tree-scoped feed
      // is unchanged while the stream-scoped one now attributes them correctly.
      await StreamContextRepository.reparentMessages(
        client,
        params.workspaceId,
        updates.map((update) => ({ messageId: update.messageId, sequence: update.sequence })),
        destinationThread.id,
        destinationThread.rootStreamId ?? rootStreamId
      )

      // A move that MINTS the thread is a thread-creation site too: the same
      // landmark `createThreadOn` writes on the parent, anchored at the target
      // message (which stays in the source stream).
      if (created && sourceStream.e2eEnabled !== true) {
        await StreamContextRepository.insertMany(client, [
          {
            id: streamContextItemId(),
            workspaceId: params.workspaceId,
            streamId: params.sourceStreamId,
            rootStreamId,
            category: "thread",
            refKind: "thread",
            refId: destinationThread.id,
            groupKey: destinationThread.id,
            sourceMessageId: targetMessage.id,
            authorId: targetMessage.authorId,
            occurredAt: targetMessage.createdAt,
            sequence: targetMessage.sequence,
            snippet: contextSnippet(targetMessage.contentMarkdown),
            detail: {},
          },
        ])
      }

      await MessageRepository.updateStreamScopedReferences(client, {
        workspaceId: params.workspaceId,
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        messageIds: uniqueMessageIds,
      })
      await StreamRepository.moveChildThreadsToParent(client, {
        workspaceId: params.workspaceId,
        sourceParentStreamId: params.sourceStreamId,
        destinationParentStreamId: destinationThread.id,
        parentMessageIds: uniqueMessageIds,
      })

      const updatedDestThread = await StreamRepository.bumpThreadReplyCount(
        client,
        destinationThread.id,
        uniqueMessageIds.length
      )
      const projectedDestinationThread = updatedDestThread ?? destinationThread
      await this.emitThreadUpdate(client, projectedDestinationThread)

      // Snapshot the post-move reply count + thread summary so we can ship them
      // inside `messages:moved` itself. Without this, source clients depend on
      // the sibling `thread:updated` event arriving before the card is
      // rendered — and any delay there produces a visible regression where the
      // new thread doesn't appear until the next bootstrap. The count lives on
      // the destination thread row (the target message's anchor).
      const parentReplyCount = updatedDestThread?.replyCount ?? uniqueMessageIds.length
      const parentThreadSummary = await StreamRepository.findThreadSummaryByParentMessage(
        client,
        destinationThread.parentStreamId ?? params.sourceStreamId,
        params.targetMessageId
      )

      if (isThreadReplyStream(sourceStream)) {
        const updatedSourceThread = await StreamRepository.bumpThreadReplyCount(
          client,
          sourceStream.id,
          -uniqueMessageIds.length
        )
        await this.emitThreadUpdate(client, updatedSourceThread ?? sourceStream)
      }

      if (created) {
        await OutboxRepository.insert(client, "stream:created", {
          workspaceId: params.workspaceId,
          streamId: projectedDestinationThread.id,
          stream: projectedDestinationThread,
        })
      }

      // Insert "messages:moved" tombstones in BOTH streams so each side of
      // the move keeps a visible trace. Each row collapses in the timeline
      // to "Actor moved N messages" and opens a drill-in drawer with the
      // per-message list. Same payload shape on both sides; the renderer
      // infers role from `event.streamId === sourceStreamId` (outbound)
      // vs `=== destinationStreamId` (inbound).
      // Sort by sequence so the drill-in drawer shows messages in the
      // chronological order they were originally sent — not the order the
      // user happened to tick checkboxes in. Sequences come from the source
      // stream's monotonic counter, so ascending sort = oldest first.
      const orderedSelectedMessages = [...selectedMessages].sort((a, b) => {
        if (a.sequence < b.sequence) return -1
        if (a.sequence > b.sequence) return 1
        return 0
      })
      const movedMessagePreviews: MovedMessagePreview[] = orderedSelectedMessages.map((message) => ({
        id: message.id,
        authorId: message.authorId,
        authorType: message.authorType,
        contentMarkdown: capMovedPreview(message.contentMarkdown),
        createdAt: message.createdAt.toISOString(),
      }))
      const tombstonePayload: MessagesMovedEventPayload = {
        sourceStreamId: params.sourceStreamId,
        sourceStreamSlug: sourceStream.slug,
        sourceStreamDisplayName: sourceStream.displayName,
        destinationStreamId: destinationThread.id,
        destinationStreamSlug: destinationThread.slug,
        destinationStreamDisplayName: destinationThread.displayName,
        messages: movedMessagePreviews,
      }
      // Pin both tombstones AND the per-message `movedFrom.movedAt` to the
      // same `movedAt` value so the badge tooltip and the tombstone summary
      // line render identical timestamps for the same move (otherwise app
      // clock vs DB NOW() can drift visibly under slow transactions).
      // Only the source side carries `vacatedBroadcastSequences` — the
      // destination gained dense fresh slots and has nothing to account for.
      const sourceTombstone = await StreamEventRepository.insert(client, {
        id: eventId(),
        streamId: params.sourceStreamId,
        eventType: "messages:moved",
        payload: { ...tombstonePayload, vacatedBroadcastSequences } satisfies MessagesMovedEventPayload,
        actorId: params.actorId,
        actorType: AuthorTypes.USER,
        createdAt: movedAt,
      })
      const destinationTombstone = await StreamEventRepository.insert(client, {
        id: destinationTombstoneId,
        streamId: destinationThread.id,
        eventType: "messages:moved",
        payload: tombstonePayload,
        actorId: params.actorId,
        actorType: AuthorTypes.USER,
        createdAt: movedAt,
      })

      // Order the wire events that will be applied to the destination
      // stream's IDB cache. The destination tombstone slots in by sequence
      // alongside the relocated messages (it always sorts last since its
      // sequence was allocated after the moves).
      const orderedDestinationEvents = [...movedEvents, ...movedAgentSessionEvents, destinationTombstone].sort(
        (a, b) => {
          if (a.sequence < b.sequence) return -1
          if (a.sequence > b.sequence) return 1
          return a.id.localeCompare(b.id)
        }
      )

      // Stored message payloads snapshot their memo summaries at send time; the
      // destination bulkPut would repaint a memo:updated patch backwards with
      // that snapshot. Re-resolve against the destination root at move time —
      // the same room-uniform shape as the share hydration below. Must run
      // BEFORE serializeBigInt, which deep-copies the payloads.
      const movedMemoIdsByMessage = new Map(selectedMessages.map((m) => [m.id, collectMemoEmbedIds(m.contentJson)]))
      const movedMemoIds = [...new Set([...movedMemoIdsByMessage.values()].flat())]
      if (movedMemoIds.length > 0) {
        const movedSummaries = await MemoRepository.findEmbedSummaries(
          client,
          params.workspaceId,
          movedMemoIds,
          destinationThread.rootStreamId ?? destinationThread.id
        )
        for (const event of orderedDestinationEvents) {
          if (event.eventType !== "message_created") continue
          const payload = event.payload as { messageId?: string; memoEmbeds?: MemoEmbedSummary[] }
          const ids = payload.messageId ? movedMemoIdsByMessage.get(payload.messageId) : undefined
          if (!ids) continue
          const resolved = ids.map((id) => movedSummaries.get(id)).filter((s): s is MemoEmbedSummary => s !== undefined)
          if (resolved.length > 0) payload.memoEmbeds = resolved
          else delete payload.memoEmbeds
        }
      }

      const serializedDestinationEvents = orderedDestinationEvents.map(
        (event) => serializeBigInt(event) as unknown as WireStreamEvent
      )
      // `removedEventIds` is what the SOURCE stream cache must drop — only
      // the relocated rows, not the source tombstone (which we want to
      // keep visible there).
      const removedEventIds = [...movedEvents, ...movedAgentSessionEvents].map((event) => event.id)
      const serializedSourceTombstone = serializeBigInt(sourceTombstone) as unknown as WireStreamEvent

      // A1 (sparse-read design): the move dropped the source's true message count.
      // Ship the post-move source ordinal so the client SETs `latestOrdinals` down
      // (no applier corrects it downward otherwise → sticky phantom unread).
      const sourceMessageCounts = await StreamEventRepository.countMessagesByStreamBatch(client, [
        params.sourceStreamId,
      ])
      const sourceMessageOrdinal = sourceMessageCounts.get(params.sourceStreamId) ?? 0

      // B3: hydrate the moved messages' share refs room-uniform for the
      // destination thread. Pointer cards in the moved messages would skeleton
      // in the destination panel otherwise — the cross-stream sources are not
      // in the destination's local event cache and this path has no D-Fallback.
      // Where the grant doesn't reach the destination room, entries resolve
      // `private` (room-uniform is conservative — never a leak).
      const movedShareRefs = new Map<string, SharedMessageRef>()
      for (const message of selectedMessages) {
        collectSharedMessageRefs(message.contentJson, movedShareRefs)
      }
      const movedSlotMaps =
        movedShareRefs.size > 0
          ? toDualSlotMaps(
              await hydrateSharedMessageRefsForRoom(
                client,
                params.workspaceId,
                destinationThread.id,
                movedShareRefs.values()
              )
            )
          : undefined

      await OutboxRepository.insert(client, "messages:moved", {
        workspaceId: params.workspaceId,
        streamId: params.sourceStreamId,
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        targetMessageId: params.targetMessageId,
        movedMessageIds: uniqueMessageIds,
        thread: projectedDestinationThread,
        events: serializedDestinationEvents,
        removedEventIds,
        sourceTombstoneEvent: serializedSourceTombstone,
        parentReplyCount,
        parentThreadSummary,
        sourceMessageOrdinal,
        ...(movedSlotMaps && { slots: movedSlotMaps.slots, sharedMessages: movedSlotMaps.sharedMessages }),
      })

      return {
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        targetMessageId: params.targetMessageId,
        movedMessageIds: uniqueMessageIds,
        thread: projectedDestinationThread,
        events: serializedDestinationEvents,
        removedEventIds,
        sourceTombstoneEvent: serializedSourceTombstone,
      }
    })
  }

  async validateMoveMessagesToThread(params: ValidateMoveMessagesToThreadParams): Promise<{
    leaseKey: string
    expiresAt: string
    destinationStreamId: string | null
    messageCount: number
  }> {
    const uniqueMessageIds = Array.from(new Set(params.messageIds))
    if (uniqueMessageIds.length === 0) {
      throw new HttpError("At least one message is required", { status: 400, code: "NO_MESSAGES_SELECTED" })
    }

    return withTransaction(this.pool, async (client) => {
      const sourceStream = await StreamRepository.findById(client, params.sourceStreamId)
      if (!sourceStream || sourceStream.workspaceId !== params.workspaceId) {
        throw new StreamNotFoundError()
      }
      if (sourceStream.archivedAt) {
        throw new HttpError("Cannot move messages from an archived stream", { status: 403, code: "STREAM_ARCHIVED" })
      }

      const isMember = await StreamMemberRepository.isMember(
        client,
        sourceStream.rootStreamId ?? sourceStream.id,
        params.actorId
      )
      if (!isMember) {
        throw new HttpError("Not a member of this stream", { status: 403, code: "NOT_STREAM_MEMBER" })
      }

      const targetMessage = await MessageRepository.findById(client, params.targetMessageId)
      if (
        !targetMessage ||
        targetMessage.streamId !== params.sourceStreamId ||
        targetMessage.deletedAt ||
        uniqueMessageIds.includes(targetMessage.id)
      ) {
        throw new MessageNotFoundError()
      }

      const selectedMessagesMap = await MessageRepository.findByIds(client, uniqueMessageIds)
      const selectedMessages = uniqueMessageIds
        .map((id) => selectedMessagesMap.get(id))
        .filter((message): message is Message => !!message)
      if (selectedMessages.length !== uniqueMessageIds.length) {
        throw new MessageNotFoundError()
      }
      if (selectedMessages.some((message) => message.streamId !== params.sourceStreamId || message.deletedAt)) {
        throw new HttpError("Selected messages must be active messages in the source stream", {
          status: 400,
          code: "INVALID_MOVE_SELECTION",
        })
      }
      if (selectedMessages.some((message) => message.sequence <= targetMessage.sequence)) {
        throw new HttpError("Messages can only be moved onto a preceding message", {
          status: 400,
          code: "TARGET_MUST_PRECEDE_SELECTION",
        })
      }

      const existingThread = await StreamRepository.findByAnchor(client, params.sourceStreamId, params.targetMessageId)
      // Mirror the message-move guard so validate doesn't hand out
      // leases the move endpoint will reject — keeps the two-step contract
      // honest about what's actually movable.
      if (existingThread?.archivedAt) {
        throw new HttpError("Cannot move messages into an archived thread", {
          status: 403,
          code: "THREAD_ARCHIVED",
        })
      }
      const lease = await OperationLeaseRepository.create(client, {
        workspaceId: params.workspaceId,
        userId: params.actorId,
        operationType: MOVE_MESSAGES_TO_THREAD_OPERATION,
        payload: canonicalMoveLeasePayload({
          sourceStreamId: params.sourceStreamId,
          targetMessageId: params.targetMessageId,
          messageIds: uniqueMessageIds,
        }),
      })

      return {
        leaseKey: lease.id,
        expiresAt: lease.expiresAt.toISOString(),
        destinationStreamId: existingThread?.id ?? null,
        messageCount: uniqueMessageIds.length,
      }
    })
  }

  async addReactionInternal(params: AddReactionParams): Promise<Message | null> {
    return this.addReactionWithAuthority({ kind: "internal" }, params)
  }

  async addReactionForPrincipal(principal: StreamWritePrincipal, params: AddReactionParams): Promise<Message | null> {
    return this.addReactionWithAuthority({ kind: "principal", principal }, params)
  }

  private async addReactionWithAuthority(
    authority: MessageMutationAuthority,
    params: AddReactionParams
  ): Promise<Message | null> {
    const actorType = params.actorType ?? AuthorTypes.USER
    let streamId =
      authority.kind === "principal"
        ? ((await MessageRepository.findById(this.pool, params.messageId))?.streamId ?? params.streamId)
        : params.streamId
    for (let attempt = 0; attempt < 3; attempt++) {
      params = { ...params, streamId }
      const result = await this.withPlacementRecovery(params.messageId, streamId, async (client) => {
        if (authority.kind === "principal") {
          await assertStreamWritable(client, {
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            principal: authority.principal,
          })
        }
        const existing = await MessageRepository.findByIdForUpdate(client, params.messageId)
        if (!existing || existing.deletedAt) return { kind: "done" as const, value: null }
        if (existing.streamId !== streamId) return { kind: "retry" as const, streamId: existing.streamId }
        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: params.streamId,
          eventType: "reaction_added",
          payload: {
            messageId: params.messageId,
            emoji: params.emoji,
            userId: params.userId,
          } satisfies ReactionPayload,
          actorId: params.userId,
          actorType,
        })

        const message = await MessageRepository.addReaction(client, params.messageId, params.emoji, params.userId)

        if (message && actorType === AuthorTypes.USER) {
          // Reacting is engagement: a provisional conversation placement the
          // reader just acknowledged stops being provisional (same transaction,
          // INV-4/7).
          await settleMessagesOnEngagement(client, params.workspaceId, [params.messageId])
        }

        if (message) {
          await OutboxRepository.insert(client, "reaction:added", {
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            messageId: params.messageId,
            emoji: params.emoji,
            userId: params.userId,
            actorType,
          })
        }

        return { kind: "done" as const, value: message }
      })
      if (result.kind === "done") return result.value
      streamId = result.streamId
    }
    throw new Error(`Message ${params.messageId} placement changed too many times`)
  }

  async removeReactionInternal(params: RemoveReactionParams): Promise<Message | null> {
    return this.removeReactionWithAuthority({ kind: "internal" }, params)
  }

  async removeReactionForPrincipal(
    principal: StreamWritePrincipal,
    params: RemoveReactionParams
  ): Promise<Message | null> {
    return this.removeReactionWithAuthority({ kind: "principal", principal }, params)
  }

  private async removeReactionWithAuthority(
    authority: MessageMutationAuthority,
    params: RemoveReactionParams
  ): Promise<Message | null> {
    const actorType = params.actorType ?? AuthorTypes.USER
    let streamId =
      authority.kind === "principal"
        ? ((await MessageRepository.findById(this.pool, params.messageId))?.streamId ?? params.streamId)
        : params.streamId
    for (let attempt = 0; attempt < 3; attempt++) {
      params = { ...params, streamId }
      const result = await this.withPlacementRecovery(params.messageId, streamId, async (client) => {
        if (authority.kind === "principal") {
          await assertStreamWritable(client, {
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            principal: authority.principal,
          })
        }
        const existing = await MessageRepository.findByIdForUpdate(client, params.messageId)
        if (!existing || existing.deletedAt) return { kind: "done" as const, value: null }
        if (existing.streamId !== streamId) return { kind: "retry" as const, streamId: existing.streamId }
        await StreamEventRepository.insert(client, {
          id: eventId(),
          streamId: params.streamId,
          eventType: "reaction_removed",
          payload: {
            messageId: params.messageId,
            emoji: params.emoji,
            userId: params.userId,
          } satisfies ReactionPayload,
          actorId: params.userId,
          actorType,
        })

        const message = await MessageRepository.removeReaction(client, params.messageId, params.emoji, params.userId)

        if (message) {
          await OutboxRepository.insert(client, "reaction:removed", {
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            messageId: params.messageId,
            emoji: params.emoji,
            userId: params.userId,
            actorType,
          })
        }

        return { kind: "done" as const, value: message }
      })
      if (result.kind === "done") return result.value
      streamId = result.streamId
    }
    throw new Error(`Message ${params.messageId} placement changed too many times`)
  }

  async getMessages(
    streamId: string,
    options?: { limit?: number; beforeSequence?: bigint; afterSequence?: bigint }
  ): Promise<Message[]> {
    return MessageRepository.list(this.pool, streamId, options)
  }

  async getMessageById(messageId: string): Promise<Message | null> {
    return MessageRepository.findById(this.pool, messageId)
  }

  async listEvents(
    streamId: string,
    filters?: {
      types?: EventType[]
      limit?: number
      afterSequence?: bigint
      beforeSequence?: bigint
      viewerId?: string
    }
  ): Promise<StreamEvent[]> {
    return StreamEventRepository.list(this.pool, streamId, filters)
  }

  /**
   * Fetch events surrounding a target. Accepts either an event ID or a message ID
   * (search results return message IDs, not event IDs).
   */
  async listEventsAround(
    streamId: string,
    targetId: string,
    options?: { idType?: "event" | "message"; limit?: number; viewerId?: string }
  ): Promise<{ events: StreamEvent[]; hasOlder: boolean; hasNewer: boolean }> {
    return withClient(this.pool, async (client) => {
      let targetEvent: StreamEvent | null = null
      if (!options?.idType || options.idType === "event") {
        targetEvent = await StreamEventRepository.findById(client, targetId)
        if (targetEvent && targetEvent.streamId !== streamId) targetEvent = null
      }
      if (!targetEvent && options?.idType !== "event") {
        targetEvent = await StreamEventRepository.findByMessageId(client, streamId, targetId)
      }
      if (!targetEvent) {
        return { events: [], hasOlder: false, hasNewer: false }
      }
      return StreamEventRepository.listAround(client, streamId, targetEvent.sequence, options)
    })
  }

  /**
   * Fetch events surrounding the first message at or after a calendar instant
   * (jump-to-date). `anchorMessageId` is the message the client scrolls to —
   * null when the date is past the stream's last message, in which case the
   * window is empty and the client falls back to the live tail.
   */
  async listEventsAroundDate(
    streamId: string,
    date: Date,
    options?: { limit?: number; viewerId?: string }
  ): Promise<{ events: StreamEvent[]; hasOlder: boolean; hasNewer: boolean; anchorMessageId: string | null }> {
    return withClient(this.pool, async (client) => {
      const anchor = await StreamEventRepository.findFirstMessageOnOrAfter(client, streamId, date)
      if (!anchor) {
        return { events: [], hasOlder: false, hasNewer: false, anchorMessageId: null }
      }
      const around = await StreamEventRepository.listAround(client, streamId, anchor.sequence, options)
      const anchorMessageId = (anchor.payload as { messageId?: string })?.messageId ?? null
      return { ...around, anchorMessageId }
    })
  }

  /** Count message_created events per stream, used to derive thread reply counts. */
  async countMessagesByStreams(streamIds: string[]): Promise<Map<string, number>> {
    return StreamEventRepository.countMessagesByStreamBatch(this.pool, streamIds)
  }

  async getMessageVersions(messageId: string): Promise<MessageVersion[]> {
    return MessageVersionRepository.listByMessageId(this.pool, messageId)
  }

  async getMessagesByIds(messageIds: string[]): Promise<Map<string, Message>> {
    return withClient(this.pool, (client) => MessageRepository.findByIds(client, messageIds))
  }

  /**
   * Find non-deleted messages matching a metadata filter (AND-containment),
   * scoped to the caller's accessible streams. See {@link MessageRepository.findByMetadata}.
   */
  async findByMetadata(params: {
    streamIds: string[]
    filter: Record<string, string>
    streamId?: string
    limit?: number
  }): Promise<Message[]> {
    return MessageRepository.findByMetadata(this.pool, params)
  }

  async getLatestSequence(streamId: string): Promise<bigint | null> {
    return StreamEventRepository.getLatestSequence(this.pool, streamId)
  }

  /**
   * Memo-embed summaries for the edited messages in a bootstrap window, keyed by
   * message id — one batch for the whole window (INV-56), and nothing at all when
   * no message in it was edited. Without a scope (a caller that predates this)
   * the map is empty and payloads keep their create-time summaries.
   */
  private async refreshMemoEmbeds(
    messagesMap: Map<string, Message>,
    messageIdsWithKey: Set<string>,
    scope?: { workspaceId: string; streamId: string }
  ): Promise<Map<string, MemoEmbedSummary[]>> {
    const refreshed = new Map<string, MemoEmbedSummary[]>()
    if (!scope) return refreshed

    // Every citing message is re-resolved against the predicate AS OF THIS
    // read, never trusted from its stored payload. The stored summary is a
    // snapshot of a past access decision: serving it after the memo's source
    // went private would be a fresh delivery of withheld content, not
    // tolerable staleness. Who gets the key set:
    // - edited: always, even empty — an edit that dropped the last reference
    //   must clear the stale card, and the stored payload predates the edit.
    // - citing with a stored key: always, even empty — empty RETRACTS a
    //   summary the room may no longer see.
    // - citing without a key: only when something resolves — the created
    //   payload omits the key when empty, and there is nothing to retract.
    const edited = [...messagesMap.values()].filter((m) => m.editedAt && !m.deletedAt)
    const citing = [...messagesMap.values()]
      .filter((m) => !m.editedAt && !m.deletedAt)
      .map((m) => [m.id, collectMemoEmbedIds(m.contentJson)] as const)
      .filter(([, ids]) => ids.length > 0)
    if (edited.length === 0 && citing.length === 0) return refreshed

    const byMessage = new Map([...edited.map((m) => [m.id, collectMemoEmbedIds(m.contentJson)] as const), ...citing])
    const editedIds = new Set(edited.map((m) => m.id))
    const allIds = [...new Set([...byMessage.values()].flat())]

    const summaries =
      allIds.length > 0
        ? await MemoRepository.findEmbedSummaries(
            this.pool,
            scope.workspaceId,
            allIds,
            (await StreamRepository.findById(this.pool, scope.streamId))?.rootStreamId ?? scope.streamId
          )
        : new Map<string, MemoEmbedSummary>()
    for (const [messageId, ids] of byMessage) {
      const resolved = ids.map((id) => summaries.get(id)).filter((s): s is MemoEmbedSummary => s !== undefined)
      const mustSet = editedIds.has(messageId) || messageIdsWithKey.has(messageId)
      if (!mustSet && resolved.length === 0) continue
      refreshed.set(messageId, resolved)
    }
    return refreshed
  }

  /**
   * Enrich bootstrap events with projection state for display.
   *
   * Filters out operational events (message_edited, message_deleted) that are
   * redundant after enrichment, then injects editedAt/deletedAt/contentJson/contentMarkdown
   * from the messages projection, threadId/replyCount from the thread data map,
   * and threadSummary (latest-reply preview + participants) into each
   * message_created event's payload.
   */
  async enrichBootstrapEvents(
    events: StreamEvent[],
    threadDataMap: Map<string, { threadId: string; replyCount: number }>,
    threadSummaryMap: Map<string, ThreadSummary> = new Map(),
    memoEmbedScope?: { workspaceId: string; streamId: string }
  ): Promise<StreamEvent[]> {
    const messageCreatedEvents = events.filter((e) => e.eventType === "message_created")
    const messageIds = messageCreatedEvents.map((e) => (e.payload as MessageCreatedPayload).messageId)

    // Reactions live on the messages projection (not in events), so we must always
    // fetch when message_created events exist — the extra query is the cost of
    // real-time reaction enrichment on bootstrap.
    const messagesMap = messageIds.length > 0 ? await this.getMessagesByIds(messageIds) : new Map<string, Message>()

    // Event payloads snapshot attachment state at send time. Video transcoding
    // AND reserved-upload settling both complete asynchronously, so fresh-load
    // bootstrap must overlay current state from the attachments projection —
    // otherwise long-completed videos render as "Processing" and long-settled
    // uploads render as "Uploading…" after a page refresh (the socket patch
    // only reaches clients that were connected when the state changed).
    const refreshAttachmentIds = [
      ...new Set(
        messageCreatedEvents.flatMap((e) =>
          ((e.payload as MessageCreatedPayload).attachments ?? [])
            .filter(
              (a) => a.processingStatus !== undefined || a.safetyStatus !== undefined || a.uploadStatus !== undefined
            )
            .map((a) => a.id)
        )
      ),
    ]
    let attachmentRowById = new Map<string, Attachment>()
    let uploadRowByAttachmentId = new Map<string, AttachmentUpload>()
    if (refreshAttachmentIds.length > 0) {
      await withClient(this.pool, async (client) => {
        const rows = await AttachmentRepository.findByIds(client, refreshAttachmentIds)
        attachmentRowById = new Map(rows.map((a) => [a.id, a]))
        const pendingRows = rows.filter((a) => !isAttachmentSafeForSharing(a.safetyStatus))
        if (pendingRows.length > 0) {
          // One bootstrap enriches one workspace's events, so any row's
          // workspaceId scopes the tracking-table read (INV-8).
          uploadRowByAttachmentId = await AttachmentUploadRepository.findByAttachmentIds(
            client,
            pendingRows[0].workspaceId,
            pendingRows.map((a) => a.id)
          )
        }
      })
    }

    const startedSessionIds = events
      .filter((e) => e.eventType === "agent_session:started")
      .map((e) => (e.payload as { sessionId?: unknown }).sessionId)
      .filter((id): id is string => typeof id === "string")
    const runningSessionProgress =
      startedSessionIds.length > 0
        ? await AgentSessionRepository.findProgressSnapshotsByIds(this.pool, startedSessionIds)
        : new Map()

    // Stored payloads snapshot a PAST access decision and a past memo state:
    // an edit can change what the body cites, the memo's source can go private
    // after the citation (serving the old summary then would be a fresh
    // delivery of withheld content), a retitle can land between the create and
    // this read, and a pre-summaries row has no key at all. Every citing
    // message is therefore re-resolved here in one batch, against the same
    // root the write path used; the stored key only decides whether an empty
    // resolution must be pushed to retract.
    const messageIdsWithKey = new Set(
      messageCreatedEvents
        .filter((e) => (e.payload as MessageCreatedPayload).memoEmbeds !== undefined)
        .map((e) => (e.payload as MessageCreatedPayload).messageId)
    )
    const memoEmbedsByMessageId = await this.refreshMemoEmbeds(messagesMap, messageIdsWithKey, memoEmbedScope)

    return events
      .filter((e) => e.eventType !== "message_edited" && e.eventType !== "message_deleted")
      .map((event) => {
        if (event.eventType === "agent_session:started") {
          const payload = event.payload as { sessionId?: string }
          const progress = payload.sessionId ? runningSessionProgress.get(payload.sessionId) : undefined
          return progress
            ? {
                ...event,
                payload: {
                  ...payload,
                  stepCount: progress.stepCount,
                  messageCount: progress.messageCount,
                  currentStepType: progress.currentStepType,
                },
              }
            : event
        }
        // Threadable card events (delegation:created, call_started) anchor by
        // their event id — inject the same thread projection so a fresh-load
        // card renders its thread affordance without a second fetch.
        if (event.eventType !== "message_created" && THREAD_ANCHORABLE_EVENT_TYPES.includes(event.eventType)) {
          const threadData = threadDataMap.get(event.id)
          if (!threadData) return event
          const threadSummary = threadSummaryMap.get(event.id)
          return {
            ...event,
            payload: {
              ...(event.payload as Record<string, unknown>),
              threadId: threadData.threadId,
              replyCount: threadData.replyCount,
              ...(threadSummary ? { threadSummary } : {}),
            },
          }
        }
        if (event.eventType !== "message_created") return event
        const payload = event.payload as MessageCreatedPayload
        const threadData = threadDataMap.get(payload.messageId)
        const message = messagesMap.get(payload.messageId)

        const enrichments: Record<string, unknown> = {}
        if (message) {
          enrichments.revision = message.revision
        }
        if (threadData) {
          enrichments.threadId = threadData.threadId
          enrichments.replyCount = threadData.replyCount
        }
        const threadSummary = threadSummaryMap.get(payload.messageId)
        if (threadSummary) {
          enrichments.threadSummary = threadSummary
        }
        if (message?.deletedAt) {
          enrichments.deletedAt = message.deletedAt.toISOString()
        } else if (message?.editedAt) {
          enrichments.editedAt = message.editedAt.toISOString()
          enrichments.contentJson = message.contentJson
          enrichments.contentMarkdown = message.contentMarkdown
        }
        // Edited entries may be empty (an edit that dropped the last reference
        // must clear the create-time card); legacy entries are only ever
        // non-empty. Deleted messages never enter the map.
        const refreshedMemoEmbeds = memoEmbedsByMessageId.get(payload.messageId)
        if (refreshedMemoEmbeds) enrichments.memoEmbeds = refreshedMemoEmbeds
        if (message?.reactions && Object.keys(message.reactions).length > 0) {
          enrichments.reactions = message.reactions
        }
        if (message?.sentVia) {
          enrichments.sentVia = message.sentVia
        }

        const refreshedAttachments = payload.attachments?.map((a) => {
          const row = attachmentRowById.get(a.id)
          if (!row) return a
          let next = a
          if (a.processingStatus !== undefined && row.processingStatus !== a.processingStatus) {
            next = { ...next, processingStatus: row.processingStatus }
          }
          if (a.safetyStatus !== undefined || a.uploadStatus !== undefined) {
            const safetyStatus = isAttachmentSafeForSharing(row.safetyStatus) ? undefined : row.safetyStatus
            const uploadStatus = uploadRowByAttachmentId.get(a.id)?.status
            if (safetyStatus !== a.safetyStatus || uploadStatus !== a.uploadStatus) {
              // Settled fields are REMOVED, not overwritten — absence is the
              // wire encoding for "safe, render normally" (see summary.ts).
              const { safetyStatus: _staleSafety, uploadStatus: _staleUpload, ...rest } = next
              next = { ...rest, ...(safetyStatus && { safetyStatus }), ...(uploadStatus && { uploadStatus }) }
            }
          }
          return next
        })
        if (refreshedAttachments && refreshedAttachments.some((a, i) => a !== payload.attachments![i])) {
          enrichments.attachments = refreshedAttachments
        }

        if (Object.keys(enrichments).length === 0) return event
        return { ...event, payload: { ...payload, ...enrichments } }
      })
  }
}
