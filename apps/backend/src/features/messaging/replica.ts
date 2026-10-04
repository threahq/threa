import { isDeepStrictEqual } from "node:util"
import type { PoolClient } from "pg"
import { serializeBigInt } from "@threahq/backend-common"
import {
  AttachmentSafetyStatuses,
  AttachmentUploadStatuses,
  AuthorTypes,
  ProcessingStatuses,
  type AttachmentSummary,
  type AuthorType,
  type BridgeChange,
  type BridgeMessage,
} from "@threahq/types"
import { OutboxRepository } from "../../lib/outbox"
import { eventId, messageVersionId, attachmentReferenceId, attachmentUploadId } from "../../lib/id"
import { JobQueues, QueueRepository, type StreamConnectionCopyAttachmentJobData } from "../../lib/queue"
import {
  AttachmentReferenceRepository,
  AttachmentRepository,
  AttachmentUploadRepository,
  toAttachmentSummary,
} from "../attachments"
import {
  StreamEventRepository,
  StreamRepository,
  adjustStreamMessageCount,
  lockMessageCountStreams,
  publishThreadUpdated,
  type Stream,
} from "../streams"
import { StreamContextRepository, contextRowsForMessage } from "../stream-context"
import {
  isThreadReplyStream,
  type MessageCreatedPayload,
  type MessageDeletedPayload,
  type MessageEditedPayload,
  type ReactionPayload,
} from "./event-service"
import { MessageRepository, type Message } from "./repository"
import { MessageVersionRepository } from "./version-repository"

/**
 * Brings a partner workspace's copies of a host stream's messages to the
 * host's current state, in the host's order, through the same events and
 * projections a local write produces. A copy keeps the host's ids and times;
 * its sequence, broadcast slot and revision are this workspace's own.
 * Applying the same state twice writes nothing.
 */
export async function applyCopyChanges(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  changes: BridgeChange[],
  connectionId: string
): Promise<void> {
  const nextOrdinal = tailOrdinals(client, workspaceId, stream.id)
  for (const change of changes) {
    if (change.kind === "message") {
      await applyMessageCopy(client, workspaceId, stream, connectionId, change.message, nextOrdinal)
    } else {
      await removeMessageCopy(client, workspaceId, stream, change.messageId)
    }
  }
}

type NextOrdinal = (sequence: bigint) => Promise<number>

/**
 * Every copy inserted here lands at its stream's tail, and the stream's
 * sequence lock keeps other inserts out until commit, so the stream is
 * counted once and each later insert takes the next ordinal.
 */
function tailOrdinals(client: PoolClient, workspaceId: string, streamId: string): NextOrdinal {
  let last: number | null = null
  return async (sequence) => {
    last =
      last === null
        ? await StreamEventRepository.countMessagesThrough(client, workspaceId, streamId, sequence)
        : last + 1
    return last
  }
}

async function applyMessageCopy(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  connectionId: string,
  copy: BridgeMessage,
  nextOrdinal: NextOrdinal
): Promise<void> {
  if (copy.streamId !== stream.id) {
    throw new Error(`Message copy ${copy.id} names stream ${copy.streamId}, not ${stream.id}`)
  }
  await lockMessageCountStreams(client, workspaceId, [stream.id])
  const existing = await MessageRepository.findByIdForUpdate(client, workspaceId, copy.id)
  if (!existing) {
    await insertCopy(client, workspaceId, stream, connectionId, copy, nextOrdinal)
  } else {
    if (existing.streamId !== stream.id || existing.deletedAt) {
      throw new Error(`Message copy ${copy.id} conflicts with message ${existing.id} in stream ${existing.streamId}`)
    }
    // The host can rewrite a body without editing it, or edit it back to what
    // this copy holds between pulls, so only a newer edit time makes an edit.
    const editedAt = copy.editedAt ? new Date(copy.editedAt) : null
    if (editedAt && (!existing.editedAt || editedAt > existing.editedAt)) {
      await editCopy(client, workspaceId, stream, existing, copy, editedAt)
    } else if (
      existing.contentMarkdown !== copy.contentMarkdown ||
      !isDeepStrictEqual(existing.contentJson, copy.contentJson)
    ) {
      await MessageRepository.rewriteContent(client, workspaceId, copy.id, copy.contentJson, copy.contentMarkdown)
      await replaceContextRows(client, workspaceId, stream, existing, copy)
    }
  }
  const current = await MessageRepository.findById(client, workspaceId, copy.id)
  await syncReactions(client, workspaceId, stream.id, copy.id, current?.reactions ?? {}, copy.reactions)
}

/**
 * Deletes the partner's copy of a message the host deleted or no longer
 * shares. A copy already gone, or one living in another stream because the
 * host moved it there before sharing, is a no-op.
 */
async function removeMessageCopy(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  messageId: string
): Promise<void> {
  await lockMessageCountStreams(client, workspaceId, [stream.id])
  const existing = await MessageRepository.findByIdForUpdate(client, workspaceId, messageId)
  if (!existing || existing.deletedAt || existing.streamId !== stream.id) return

  await adjustStreamMessageCount(client, workspaceId, stream.id, -1)
  await StreamEventRepository.insert(client, {
    id: eventId(),
    workspaceId,
    streamId: stream.id,
    eventType: "message_deleted",
    payload: { messageId } satisfies MessageDeletedPayload,
    actorId: existing.authorId,
    actorType: existing.authorType,
  })
  const message = await MessageRepository.softDelete(client, workspaceId, messageId)
  await MessageRepository.markActivityReadForDeleted(client, workspaceId, messageId)
  await StreamContextRepository.deleteByMessageId(client, workspaceId, messageId)
  await OutboxRepository.insert(client, "message:deleted", {
    workspaceId,
    streamId: stream.id,
    messageId,
    deletedAt: message!.deletedAt!.toISOString(),
  })
  if (isThreadReplyStream(stream)) {
    const thread = await StreamRepository.bumpThreadReplyCount(client, workspaceId, stream.id, -1)
    await publishThreadUpdated(client, thread ?? stream)
  }
}

/**
 * Rows for the host message's files, bound to the copy. Bytes stay on the host
 * until a queued job copies each one; until then a file reads as uploading.
 * Plain inserts: an id this workspace already holds means the host named a
 * file that is not its own, and the page is refused.
 */
async function insertCopyAttachments(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  connectionId: string,
  copy: BridgeMessage
): Promise<AttachmentSummary[]> {
  if (copy.attachments.length === 0) return []
  const rows = await AttachmentRepository.insertCopies(
    client,
    workspaceId,
    copy.attachments.map((attachment) => ({
      id: attachment.id,
      streamId: stream.id,
      messageId: copy.id,
      uploadedBy: copy.authorId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      storagePath: `${workspaceId}/${attachment.id}/${attachment.filename}`,
      width: attachment.width,
      height: attachment.height,
      safetyStatus:
        attachment.safetyStatus === AttachmentSafetyStatuses.QUARANTINED
          ? AttachmentSafetyStatuses.QUARANTINED
          : AttachmentSafetyStatuses.PENDING_UPLOAD,
      processingStatus: ProcessingStatuses.SKIPPED,
    }))
  )
  const awaitingBytes = rows.filter((row) => row.safetyStatus === AttachmentSafetyStatuses.PENDING_UPLOAD)
  await AttachmentUploadRepository.insertMany(
    client,
    awaitingBytes.map((row) => ({
      id: attachmentUploadId(),
      workspaceId,
      attachmentId: row.id,
      uploadedBy: copy.authorId,
      expectedSizeBytes: row.sizeBytes,
    }))
  )
  await AttachmentReferenceRepository.insertMany(
    client,
    rows.map((row) => ({
      id: attachmentReferenceId(),
      workspaceId,
      attachmentId: row.id,
      messageId: copy.id,
      streamId: stream.id,
    }))
  )
  const now = new Date()
  await QueueRepository.batchInsert(
    client,
    awaitingBytes.map((row) => {
      const payload: StreamConnectionCopyAttachmentJobData = { workspaceId, connectionId, attachmentId: row.id }
      return {
        id: `scfile_${workspaceId}_${row.id}`,
        queueName: JobQueues.STREAM_CONNECTION_COPY_ATTACHMENT,
        workspaceId,
        payload,
        processAfter: now,
        insertedAt: now,
      }
    })
  )
  const awaiting = new Set(awaitingBytes.map((row) => row.id))
  return rows.map((row) =>
    toAttachmentSummary(row, awaiting.has(row.id) ? AttachmentUploadStatuses.RESERVED : undefined)
  )
}

async function insertCopy(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  connectionId: string,
  copy: BridgeMessage,
  nextOrdinal: NextOrdinal
): Promise<void> {
  const createdAt = new Date(copy.createdAt)
  await adjustStreamMessageCount(client, workspaceId, stream.id, 1)
  const attachments = await insertCopyAttachments(client, workspaceId, stream, connectionId, copy)
  const event = await StreamEventRepository.insert(client, {
    id: eventId(),
    workspaceId,
    streamId: stream.id,
    eventType: "message_created",
    payload: {
      messageId: copy.id,
      contentJson: copy.contentJson,
      contentMarkdown: copy.contentMarkdown,
      revision: 1,
      ...(attachments.length > 0 && { attachments }),
    } satisfies MessageCreatedPayload,
    actorId: copy.authorId,
    actorType: copy.authorType,
    createdAt,
  })
  await MessageRepository.insert(client, {
    id: copy.id,
    workspaceId,
    streamId: stream.id,
    sequence: event.sequence,
    authorId: copy.authorId,
    authorType: copy.authorType,
    contentJson: copy.contentJson,
    contentMarkdown: copy.contentMarkdown,
    createdAt,
    editedAt: copy.editedAt ? new Date(copy.editedAt) : null,
  })
  await StreamContextRepository.insertMany(
    client,
    contextRowsForMessage({
      workspaceId,
      streamId: stream.id,
      rootStreamId: stream.rootStreamId ?? stream.id,
      messageId: copy.id,
      authorId: copy.authorId,
      occurredAt: createdAt,
      sequence: event.sequence,
      contentJson: copy.contentJson,
      contentMarkdown: copy.contentMarkdown,
      attachments,
    })
  )
  await OutboxRepository.insert(client, "message:created", {
    workspaceId,
    streamId: stream.id,
    event: serializeBigInt(event),
  })
  const messageOrdinal = await nextOrdinal(event.sequence)
  await OutboxRepository.insert(client, "stream:activity", {
    workspaceId,
    streamId: stream.id,
    authorId: copy.authorId,
    sequence: event.sequence.toString(),
    messageOrdinal,
    lastMessagePreview: {
      authorId: copy.authorId,
      authorType: copy.authorType,
      content: copy.contentMarkdown,
      createdAt: copy.createdAt,
    },
  })
  if (isThreadReplyStream(stream)) {
    const thread = await StreamRepository.bumpThreadReplyCount(client, workspaceId, stream.id, 1)
    await publishThreadUpdated(client, thread ?? stream)
  }
}

async function editCopy(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  existing: Message,
  copy: BridgeMessage,
  editedAt: Date
): Promise<void> {
  const snapshot = await MessageVersionRepository.insert(client, {
    id: messageVersionId(),
    workspaceId,
    messageId: copy.id,
    versionNumber: existing.revision,
    contentJson: existing.contentJson,
    contentMarkdown: existing.contentMarkdown,
    editedBy: existing.authorId,
  })
  const event = await StreamEventRepository.insert(client, {
    id: eventId(),
    workspaceId,
    streamId: stream.id,
    eventType: "message_edited",
    payload: {
      messageId: copy.id,
      contentJson: copy.contentJson,
      contentMarkdown: copy.contentMarkdown,
      revision: snapshot.versionNumber + 1,
      memoEmbeds: [],
    } satisfies MessageEditedPayload,
    actorId: existing.authorId,
    actorType: existing.authorType,
    createdAt: editedAt,
  })
  await MessageRepository.updateContent(client, workspaceId, copy.id, copy.contentJson, copy.contentMarkdown, editedAt)
  await OutboxRepository.insert(client, "message:edited", {
    workspaceId,
    streamId: stream.id,
    event: serializeBigInt(event),
  })
  await replaceContextRows(client, workspaceId, stream, existing, copy)
  if (isThreadReplyStream(stream)) {
    await publishThreadUpdated(client, stream, { includeReplyCount: false })
  }
}

async function replaceContextRows(
  client: PoolClient,
  workspaceId: string,
  stream: Stream,
  existing: Message,
  copy: BridgeMessage
): Promise<void> {
  await StreamContextRepository.replaceForMessage(
    client,
    workspaceId,
    copy.id,
    contextRowsForMessage({
      workspaceId,
      streamId: stream.id,
      rootStreamId: stream.rootStreamId ?? stream.id,
      messageId: copy.id,
      authorId: existing.authorId,
      occurredAt: existing.createdAt,
      sequence: existing.sequence,
      contentJson: copy.contentJson,
      contentMarkdown: copy.contentMarkdown,
      attachments: [],
    })
  )
}

async function syncReactions(
  client: PoolClient,
  workspaceId: string,
  streamId: string,
  messageId: string,
  have: Record<string, string[]>,
  want: Record<string, string[]>
): Promise<void> {
  const haveKeys = reactionKeys(have)
  const wantKeys = reactionKeys(want)
  for (const [key, reaction] of wantKeys) {
    if (!haveKeys.has(key)) await writeReaction(client, workspaceId, streamId, messageId, reaction, "added")
  }
  for (const [key, reaction] of haveKeys) {
    if (!wantKeys.has(key)) await writeReaction(client, workspaceId, streamId, messageId, reaction, "removed")
  }
}

interface Reaction {
  emoji: string
  userId: string
}

function reactionKeys(reactions: Record<string, string[]>): Map<string, Reaction> {
  const keys = new Map<string, Reaction>()
  for (const [emoji, userIds] of Object.entries(reactions)) {
    for (const userId of userIds) keys.set(JSON.stringify([emoji, userId]), { emoji, userId })
  }
  return keys
}

async function writeReaction(
  client: PoolClient,
  workspaceId: string,
  streamId: string,
  messageId: string,
  { emoji, userId }: Reaction,
  change: "added" | "removed"
): Promise<void> {
  const actorType = reactorType(userId)
  await StreamEventRepository.insert(client, {
    id: eventId(),
    workspaceId,
    streamId,
    eventType: change === "added" ? "reaction_added" : "reaction_removed",
    payload: { messageId, emoji, userId } satisfies ReactionPayload,
    actorId: userId,
    actorType,
  })
  if (change === "added") {
    await MessageRepository.addReaction(client, workspaceId, messageId, emoji, userId)
  } else {
    await MessageRepository.removeReaction(client, workspaceId, messageId, emoji, userId)
  }
  await OutboxRepository.insert(client, change === "added" ? "reaction:added" : "reaction:removed", {
    workspaceId,
    streamId,
    messageId,
    emoji,
    userId,
    actorType,
  })
}

/** The bridge names reactors by id alone; the id's prefix says what kind of actor reacted. */
function reactorType(id: string): AuthorType {
  if (id.startsWith("usr_")) return AuthorTypes.USER
  if (id.startsWith("persona_")) return AuthorTypes.PERSONA
  if (id.startsWith("bot_")) return AuthorTypes.BOT
  throw new Error(`Reactor ${id} is not a user, persona or bot`)
}
