import type { Pool, PoolClient } from "pg"
import { withTransaction, withClient } from "../../db"
import { StreamEventRepository, type StreamEvent, type MoveEventIdSequenceUpdate } from "../streams"
import { StreamRepository } from "../streams"
import { StreamMemberRepository } from "../streams"
import { checkStreamAccess, resolveEffectiveAccessStream } from "../streams"
import { MessageRepository, type Message, type MoveMessageSequenceUpdate } from "./repository"
import { ShareService, type ResolveEffectiveStream } from "./sharing"
import {
  AttachmentRepository,
  AttachmentReferenceRepository,
  isAttachmentReadableViaShareOrReference,
  isAttachmentSafeForSharing,
  toAttachmentSummary,
} from "../attachments"
import { OutboxRepository } from "../../lib/outbox"
import { AgentSessionRepository, StreamPersonaParticipantRepository } from "../agents"
import { E2eStreamsRepository } from "../e2e-streams"
import { attachmentReferenceId, eventId, messageId, messageVersionId, streamId as generateStreamId } from "../../lib/id"
import { MessageVersionRepository, type MessageVersion } from "./version-repository"
import { serializeBigInt } from "@threa/backend-common"
import { messagesTotal } from "../../lib/observability"
import { HttpError, MessageNotFoundError, StreamNotFoundError } from "../../lib/errors"
import { OperationLeaseRepository } from "../../lib/operation-leases"
import {
  AuthorTypes,
  CompanionModes,
  StreamTypes,
  Visibilities,
  type AttachmentSummary,
  type AuthorType,
  type EventType,
  type SourceItem,
  type JSONContent,
  type ThreadSummary,
  type StreamEvent as WireStreamEvent,
  type MessagesMovedEventPayload,
  type MovedMessagePreview,
} from "@threa/types"

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

// Event payloads
export interface MessageCreatedPayload {
  messageId: string
  contentJson: JSONContent
  contentMarkdown: string
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
}

export interface MessageEditedPayload {
  messageId: string
  contentJson: JSONContent
  contentMarkdown: string
}

export interface MessageDeletedPayload {
  messageId: string
}

export interface ReactionPayload {
  messageId: string
  emoji: string
  userId: string
}

export interface ThreadCreatedPayload {
  threadId: string
  parentMessageId: string
}

// `MovedMessagePreview` and `MessagesMovedEventPayload` are wire types
// shared with the frontend — see `packages/types/src/api.ts`.

// Service params
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
  // Iterate by code points so emoji and other non-BMP characters don't get
  // split into a lone surrogate at the truncation boundary. `Array.from`
  // on a string yields one entry per code point, which is what we want
  // for "200 user-perceived characters" (close enough — grapheme clusters
  // would be ideal but cost more for very little user benefit here).
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
 * INV-E1: an E2E stream must carry ciphertext and a plaintext stream must not.
 * Either mismatch would persist a row that violates the encryption guarantee.
 * Throws the same error codes the messaging create handler uses so the wire
 * contract stays identical whether the check fires at the handler or the sink.
 */
function assertE2eContentMatch(streamIsE2e: boolean, hasCiphertext: boolean): void {
  if (streamIsE2e === hasCiphertext) return
  throw new HttpError(
    streamIsE2e
      ? "Stream is end-to-end encrypted; send ciphertext, envelope, and e2eVersion"
      : "Stream is not end-to-end encrypted; send plaintext content",
    {
      status: 400,
      code: streamIsE2e ? "E2E_STREAM_REQUIRES_CIPHERTEXT" : "E2E_PAYLOAD_REQUIRES_E2E_STREAM",
    }
  )
}

export class EventService {
  constructor(private pool: Pool) {}

  private async publishParentThreadUpdate(
    client: PoolClient,
    params: {
      workspaceId: string
      parentStreamId: string | null
      parentMessageId: string | null
    }
  ): Promise<void> {
    if (!params.parentStreamId || !params.parentMessageId) return

    const parentMessage = await MessageRepository.findById(client, params.parentMessageId)
    if (!parentMessage) return

    const threadSummary = await StreamRepository.findThreadSummaryByParentMessage(client, params.parentMessageId)
    await OutboxRepository.insert(client, "message:updated", {
      workspaceId: params.workspaceId,
      streamId: params.parentStreamId,
      messageId: params.parentMessageId,
      updateType: "reply_count",
      replyCount: parentMessage.replyCount,
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
    try {
      return await this._createMessageTxn(params)
    } catch (error) {
      // Concurrent duplicate: the txn rolled back (no orphaned stream_events/outbox),
      // and we return the already-committed message from the winning transaction.
      if (error instanceof DuplicateMessageError) return error.existingMessage
      throw error
    }
  }

  async createMessageInTransaction(client: PoolClient, params: CreateMessageParams): Promise<Message> {
    // Fast path: if a message with this clientMessageId already exists,
    // return it without doing any writes. Handles sequential retries.
    if (params.clientMessageId) {
      const existing = await MessageRepository.findByClientMessageId(client, params.streamId, params.clientMessageId)
      if (existing) return existing
    }
    // The enclave seals its E2E reply with the message AAD bound to a
    // server-minted id, so the caller can pass that same id here to keep the
    // stored row's id and the envelope's bound id identical (INV-E*). Defaults
    // to a fresh id for every other caller.
    const msgId = params.id ?? messageId()
    const evtId = eventId()

    // 0. Get stream for thread handling (metrics deferred until after conflict check)
    const stream = await StreamRepository.findById(client, params.streamId)

    // INV-E1 enforced at the write sink (E2EE-5): an E2E stream stores only
    // ciphertext, and a plaintext stream never carries an E2E envelope. The
    // messaging create handler checks this too (with caller-friendly copy off
    // the resolved stream), but the sink is the backstop so no other caller —
    // the scheduled-message worker, public-API bot-invocation completion, any
    // future adapter — can persist plaintext into a sealed stream. `findById`
    // already LEFT JOINs `e2e_streams`, so this reads `e2eEnabled` off the row
    // we just loaded rather than issuing a second SELECT.
    assertE2eContentMatch(stream?.e2eEnabled === true, params.ciphertext !== undefined)

    // 1. Validate and prepare attachments FIRST (before creating event).
    //    Two flavors are allowed:
    //    - "new" (`messageId === null`): a fresh upload owned by this send.
    //      The attachment row gets its `message_id` / `stream_id` set in
    //      step 6 via `attachToMessage`, anchoring ownership to this message.
    //    - "referenced" (`messageId !== null`): the message body re-uses an
    //      attachment that already belongs to a previous message — typical
    //      after copy-paste of a message containing `[Image #1](attachment:id)`.
    //      Ownership stays with the original message; an
    //      `attachment_references` row in step 6b records the pointer so
    //      recipients of the new message can resolve download access via the
    //      same workspace/stream gate that already covers shared messages.
    //
    //    Verifying the author can read the referenced attachment closes the
    //    obvious abuse — submitting an arbitrary id from someone else's
    //    workspace would otherwise bypass `getDownloadUrl`'s access check by
    //    being silently summarised on the wire.
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
        // bytes). Single source of truth with the download path.
        if (!isAttachmentSafeForSharing(a.safetyStatus)) {
          throw new Error("Invalid attachment IDs: must be malware-scan clean or E2E-encrypted")
        }
        if (a.messageId === null) {
          attachmentsToAttach.push(a.id)
          continue
        }
        // Referenced from another message — gate on the author's ability
        // to read it via the same chain `getDownloadUrl` honours so the
        // two paths can never disagree. Direct stream access first; the
        // shared helper covers the share-grant + inline-reference fallback.
        //
        // Two flavors:
        // 1. User authors (no `accessibleStreamIds` provided): membership
        //    lookups keyed by `authorId`, including the share-grant fallback.
        // 2. Persona authors (`accessibleStreamIds` provided): mirrors
        //    `AttachmentService.getAccessible` exactly — direct set
        //    membership, then reference-projection intersection.
        //    `accessibleStreamIds` comes from `AgentAccessSpec` and is
        //    scope-restricted (from a public channel only public streams,
        //    from a private channel only that channel + public, etc.) —
        //    NOT the invoking user's full reach. Bypassing it with a
        //    user-id check would let agents resurface attachments the
        //    user couldn't surface from this invocation point.
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

      attachmentSummaries = attachments.map(toAttachmentSummary)
    }

    // Non-empty metadata only — keep payloads and projections clean of `{}`.
    const metadata = params.metadata && Object.keys(params.metadata).length > 0 ? params.metadata : undefined

    // 2. Append event (source of truth) - includes attachments and sources in payload
    const event = await StreamEventRepository.insert(client, {
      id: evtId,
      streamId: params.streamId,
      eventType: "message_created",
      payload: {
        messageId: msgId,
        contentJson: params.contentJson,
        contentMarkdown: params.contentMarkdown,
        ...(attachmentSummaries && { attachments: attachmentSummaries }),
        ...(params.sources && params.sources.length > 0 && { sources: params.sources }),
        ...(params.sessionId && { sessionId: params.sessionId }),
        ...(params.clientMessageId && { clientMessageId: params.clientMessageId }),
        ...(params.sentVia && { sentVia: params.sentVia }),
        ...(metadata && { metadata }),
        ...(params.ciphertext && { ciphertext: params.ciphertext.toString("base64") }),
        ...(params.envelope !== undefined && { envelope: params.envelope }),
        ...(params.e2eVersion !== undefined && { e2eVersion: params.e2eVersion }),
      } satisfies MessageCreatedPayload,
      actorId: params.authorId,
      actorType: params.authorType,
    })

    // 3. Update projection
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

    // 4. Update author's read position to include their own message
    // This ensures the sender's own message is never counted as unread
    if (params.authorType === "user") {
      await StreamMemberRepository.update(client, params.streamId, params.authorId, {
        lastReadEventId: evtId,
      })
    }

    // 5. Record persona participation (idempotent)
    if (params.authorType === "persona") {
      await StreamPersonaParticipantRepository.recordParticipation(client, params.streamId, params.authorId)
    }

    // 6. Link first-time attachments to this message (also sets streamId).
    //    Re-referenced attachments deliberately skip this step — their
    //    `message_id`/`stream_id` already point at the original owner and
    //    overwriting that would orphan the original `attachment:` link in
    //    other messages.
    if (attachmentsToAttach.length > 0) {
      const attached = await AttachmentRepository.attachToMessage(client, attachmentsToAttach, msgId, params.streamId)
      if (attached !== attachmentsToAttach.length) {
        throw new Error("Failed to attach all files")
      }
    }

    // 6b. Record an attachment_references row for every attachment in this
    //     message — both newly-attached and re-referenced. Lookups for
    //     "is this attachment visible to a viewer of stream X?" can then
    //     consult one index without caring about original ownership.
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

    // 7. Validate and record any cross-stream share references carried in
    //    contentJson. Runs inside the transaction so the shared_messages
    //    access-projection is committed atomically with the event + projection
    //    (INV-7). No-op for messages without cross-stream share nodes.
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

    // 8. Publish to outbox for real-time delivery
    await OutboxRepository.insert(client, "message:created", {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      event: serializeBigInt(event),
    })

    // 9. Publish unread increment for sidebar updates
    // Stream-scoped: only members of this stream receive the preview content.
    // Frontend excludes the author's own messages from unread count.
    await OutboxRepository.insert(client, "stream:activity", {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      authorId: params.authorId,
      lastMessagePreview: {
        authorId: params.authorId,
        authorType: params.authorType,
        content: params.contentMarkdown,
        createdAt: event.createdAt.toISOString(),
      },
    })

    // 10. If this is a thread, update parent message's reply count
    if (stream?.parentMessageId && stream?.parentStreamId) {
      await MessageRepository.incrementReplyCount(client, stream.parentMessageId)
      await this.publishParentThreadUpdate(client, {
        workspaceId: params.workspaceId,
        parentStreamId: stream.parentStreamId,
        parentMessageId: stream.parentMessageId,
      })
    }

    return message
  }

  private async _createMessageTxn(params: CreateMessageParams): Promise<Message> {
    return withTransaction(this.pool, (client) => this.createMessageInTransaction(client, params))
  }

  async editMessage(params: EditMessageParams): Promise<Message | null> {
    return withTransaction(this.pool, async (client) => {
      // INV-E1 (E2EE-1): there is no sealed-edit path yet, so editing a message
      // in an E2E stream would overwrite the sealed projection with plaintext,
      // snapshot a plaintext version row, and broadcast plaintext over
      // `message:edited`. Refuse loudly at the sink until a ciphertext edit
      // payload exists; the frontend also hides the Edit affordance for E2E
      // messages so this never surfaces as a dead button.
      if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, params.streamId)) {
        throw new HttpError("Cannot edit a message in an end-to-end-encrypted stream", {
          status: 400,
          code: "E2E_STREAM_EDIT_UNSUPPORTED",
        })
      }

      // Returns null if the message was concurrently deleted — prevents phantom edits
      const existing = await MessageRepository.findByIdForUpdate(client, params.messageId)
      if (!existing || existing.deletedAt) return null

      // No-op: content hasn't meaningfully changed
      if (params.contentMarkdown.trim() === existing.contentMarkdown.trim()) return existing

      const actorType = await this.resolveActorType(client, params.streamId, params.actorId, params.actorType, existing)

      // 1. Snapshot pre-edit content as a version record
      await MessageVersionRepository.insert(client, {
        id: messageVersionId(),
        messageId: params.messageId,
        contentJson: existing.contentJson,
        contentMarkdown: existing.contentMarkdown,
        editedBy: params.actorId,
      })

      // 2. Append event
      const event = await StreamEventRepository.insert(client, {
        id: eventId(),
        streamId: params.streamId,
        eventType: "message_edited",
        payload: {
          messageId: params.messageId,
          contentJson: params.contentJson,
          contentMarkdown: params.contentMarkdown,
        } satisfies MessageEditedPayload,
        actorId: params.actorId,
        actorType,
      })

      // 3. Update projection
      const message = await MessageRepository.updateContent(
        client,
        params.messageId,
        params.contentJson,
        params.contentMarkdown
      )

      if (message) {
        // 4. Re-validate share nodes. Same call as createMessage — edits that
        //    add, remove, or swap share references rewrite the shared_messages
        //    row set so hydration/authorization reflects the new content.
        //    Without this, an author could edit in a sharedMessage pointing
        //    at an arbitrary id and leak its content past the create-time check.
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

        // 4b. Refresh `attachment_references` projection to match the new
        //     contentJson (INV-7). Without this, an edit that adds or removes
        //     an `attachment:` link leaves stale rows behind and download
        //     authorization stops matching the persisted body. Reference-only
        //     — fresh uploads aren't supported on edit (a zero-`messageId`
        //     attachment id will fail the access validation here loudly).
        //     Full delete-then-insert per edit; the projection is small and
        //     this lets the helper share its access-check semantics with the
        //     create path verbatim.
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

        // 5. Publish to outbox
        await OutboxRepository.insert(client, "message:edited", {
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          event: serializeBigInt(event),
        })

        const stream = await StreamRepository.findById(client, params.streamId)
        if (stream?.parentMessageId && stream.parentStreamId) {
          await this.publishParentThreadUpdate(client, {
            workspaceId: params.workspaceId,
            parentStreamId: stream.parentStreamId,
            parentMessageId: stream.parentMessageId,
          })
        }
      }

      return message
    })
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

  async deleteMessage(params: DeleteMessageParams): Promise<Message | null> {
    return withTransaction(this.pool, async (client) => {
      const existing = await MessageRepository.findByIdForUpdate(client, params.messageId)
      if (!existing || existing.deletedAt) return null

      const actorType = await this.resolveActorType(client, params.streamId, params.actorId, params.actorType, existing)

      // 1. Append event
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

      // 2. Update projection (soft delete)
      const message = await MessageRepository.softDelete(client, params.messageId)

      if (message) {
        // 3. Publish to outbox
        await OutboxRepository.insert(client, "message:deleted", {
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          messageId: params.messageId,
          deletedAt: message.deletedAt!.toISOString(),
        })

        // 4. If this is a thread, update parent message's reply count
        const stream = await StreamRepository.findById(client, params.streamId)
        if (stream?.parentMessageId && stream?.parentStreamId) {
          await MessageRepository.decrementReplyCount(client, stream.parentMessageId)
          await this.publishParentThreadUpdate(client, {
            workspaceId: params.workspaceId,
            parentStreamId: stream.parentStreamId,
            parentMessageId: stream.parentMessageId,
          })
        }
      }

      return message
    })
  }

  async moveMessagesToThread(params: MoveMessagesToThreadParams): Promise<MoveMessagesToThreadResult> {
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
        parentMessageId: params.targetMessageId,
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

      const nextSequences = await StreamEventRepository.getNextSequences(
        client,
        destinationThread.id,
        movableEvents.length
      )
      const updates: MoveMessageSequenceUpdate[] = []
      const agentSessionEventUpdates: MoveEventIdSequenceUpdate[] = []
      movableEvents.forEach((entry, index) => {
        if (entry.kind === "message") {
          updates.push({ messageId: entry.messageId, sequence: nextSequences[index] })
        } else {
          agentSessionEventUpdates.push({ eventId: entry.event.id, sequence: nextSequences[index] })
        }
      })

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

      await MessageRepository.incrementReplyCountBy(client, params.targetMessageId, uniqueMessageIds.length)
      await this.publishParentThreadUpdate(client, {
        workspaceId: params.workspaceId,
        parentStreamId: params.sourceStreamId,
        parentMessageId: params.targetMessageId,
      })

      // Snapshot the post-increment reply count + thread summary so we can
      // ship them inside `messages:moved` itself. Without this, source
      // clients depend on the sibling `message:updated` event arriving
      // before the card is rendered — and any delay there produces a
      // visible regression where the new thread doesn't appear until the
      // next bootstrap.
      const updatedTargetMessage = await MessageRepository.findById(client, params.targetMessageId)
      const parentReplyCount = updatedTargetMessage?.replyCount ?? uniqueMessageIds.length
      const parentThreadSummary = await StreamRepository.findThreadSummaryByParentMessage(
        client,
        params.targetMessageId
      )

      if (sourceStream.parentStreamId && sourceStream.parentMessageId) {
        await MessageRepository.decrementReplyCountBy(client, sourceStream.parentMessageId, uniqueMessageIds.length)
        await this.publishParentThreadUpdate(client, {
          workspaceId: params.workspaceId,
          parentStreamId: sourceStream.parentStreamId,
          parentMessageId: sourceStream.parentMessageId,
        })
      }

      if (created) {
        await OutboxRepository.insert(client, "stream:created", {
          workspaceId: params.workspaceId,
          streamId: params.sourceStreamId,
          stream: destinationThread,
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
      const sourceTombstone = await StreamEventRepository.insert(client, {
        id: eventId(),
        streamId: params.sourceStreamId,
        eventType: "messages:moved",
        payload: tombstonePayload,
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
      const serializedDestinationEvents = orderedDestinationEvents.map(
        (event) => serializeBigInt(event) as unknown as WireStreamEvent
      )
      // `removedEventIds` is what the SOURCE stream cache must drop — only
      // the relocated rows, not the source tombstone (which we want to
      // keep visible there).
      const removedEventIds = [...movedEvents, ...movedAgentSessionEvents].map((event) => event.id)
      const serializedSourceTombstone = serializeBigInt(sourceTombstone) as unknown as WireStreamEvent

      await OutboxRepository.insert(client, "messages:moved", {
        workspaceId: params.workspaceId,
        streamId: params.sourceStreamId,
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        targetMessageId: params.targetMessageId,
        movedMessageIds: uniqueMessageIds,
        thread: destinationThread,
        events: serializedDestinationEvents,
        removedEventIds,
        sourceTombstoneEvent: serializedSourceTombstone,
        parentReplyCount,
        parentThreadSummary,
      })

      return {
        sourceStreamId: params.sourceStreamId,
        destinationStreamId: destinationThread.id,
        targetMessageId: params.targetMessageId,
        movedMessageIds: uniqueMessageIds,
        thread: destinationThread,
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

      const existingThread = await StreamRepository.findByParentMessage(
        client,
        params.sourceStreamId,
        params.targetMessageId
      )
      // Mirror the moveMessagesToThread guard so validate doesn't hand out
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

  async addReaction(params: AddReactionParams): Promise<Message | null> {
    const actorType = params.actorType ?? AuthorTypes.USER
    return withTransaction(this.pool, async (client) => {
      // 1. Append event
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

      // 2. Update projection
      const message = await MessageRepository.addReaction(client, params.messageId, params.emoji, params.userId)

      if (message) {
        // 3. Publish to outbox
        await OutboxRepository.insert(client, "reaction:added", {
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          messageId: params.messageId,
          emoji: params.emoji,
          userId: params.userId,
          actorType,
        })
      }

      return message
    })
  }

  async removeReaction(params: RemoveReactionParams): Promise<Message | null> {
    const actorType = params.actorType ?? AuthorTypes.USER
    return withTransaction(this.pool, async (client) => {
      // 1. Append event
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

      // 2. Update projection
      const message = await MessageRepository.removeReaction(client, params.messageId, params.emoji, params.userId)

      if (message) {
        // 3. Publish to outbox
        await OutboxRepository.insert(client, "reaction:removed", {
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          messageId: params.messageId,
          emoji: params.emoji,
          userId: params.userId,
          actorType,
        })
      }

      return message
    })
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
   * Get reply counts for multiple messages.
   * Returns a map of messageId -> replyCount
   */
  async getReplyCountsBatch(messageIds: string[]): Promise<Map<string, number>> {
    return MessageRepository.getReplyCountsBatch(this.pool, messageIds)
  }

  /**
   * Count message_created events for multiple streams.
   * Used to compute reply counts by counting messages in thread streams.
   * Returns a map of streamId -> message count
   */
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
    threadSummaryMap: Map<string, ThreadSummary> = new Map()
  ): Promise<StreamEvent[]> {
    const messageCreatedEvents = events.filter((e) => e.eventType === "message_created")
    const messageIds = messageCreatedEvents.map((e) => (e.payload as MessageCreatedPayload).messageId)

    // Reactions live on the messages projection (not in events), so we must always
    // fetch when message_created events exist. This replaces an earlier guard that
    // only fetched on edits/deletes — the extra query is the cost of real-time
    // reaction enrichment on bootstrap.
    const messagesMap = messageIds.length > 0 ? await this.getMessagesByIds(messageIds) : new Map<string, Message>()

    // Event payloads snapshot attachment processingStatus at send time. Video
    // transcoding completes asynchronously, so fresh-load bootstrap must overlay
    // current processingStatus from the attachments projection; otherwise
    // long-completed videos render as "Processing" after a page refresh.
    const attachmentIds = messageCreatedEvents.flatMap((e) =>
      ((e.payload as MessageCreatedPayload).attachments ?? [])
        .filter((a) => a.processingStatus !== undefined)
        .map((a) => a.id)
    )
    const attachmentStatusMap =
      attachmentIds.length > 0
        ? await withClient(this.pool, async (client) => {
            const rows = await AttachmentRepository.findByIds(client, attachmentIds)
            return new Map(rows.map((a) => [a.id, a.processingStatus as string]))
          })
        : new Map<string, string>()

    const startedSessionIds = events
      .filter((e) => e.eventType === "agent_session:started")
      .map((e) => (e.payload as { sessionId?: unknown }).sessionId)
      .filter((id): id is string => typeof id === "string")
    const runningSessionProgress =
      startedSessionIds.length > 0
        ? await AgentSessionRepository.findProgressSnapshotsByIds(this.pool, startedSessionIds)
        : new Map()

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
        if (event.eventType !== "message_created") return event
        const payload = event.payload as MessageCreatedPayload
        const threadData = threadDataMap.get(payload.messageId)
        const message = messagesMap.get(payload.messageId)

        const enrichments: Record<string, unknown> = {}
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
        if (message?.reactions && Object.keys(message.reactions).length > 0) {
          enrichments.reactions = message.reactions
        }
        if (message?.sentVia) {
          enrichments.sentVia = message.sentVia
        }

        const refreshedAttachments = payload.attachments?.map((a) => {
          if (a.processingStatus === undefined) return a
          const current = attachmentStatusMap.get(a.id)
          return current && current !== a.processingStatus ? { ...a, processingStatus: current } : a
        })
        if (refreshedAttachments && refreshedAttachments.some((a, i) => a !== payload.attachments![i])) {
          enrichments.attachments = refreshedAttachments
        }

        if (Object.keys(enrichments).length === 0) return event
        return { ...event, payload: { ...payload, ...enrichments } }
      })
  }
}
