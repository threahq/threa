import type { Pool, PoolClient } from "pg"
import { collectAttachmentReferenceIds } from "@threahq/prosemirror"
import {
  AuthorTypes,
  type BridgeAddReaction,
  type BridgeEditMessage,
  type BridgeSendMessage,
  type BridgeSendMessageResponse,
  type BridgeWriteAttachment,
  type BridgeWriteUser,
  type JSONContent,
} from "@threahq/types"
import { withTransaction } from "../../db"
import { AttachmentRepository } from "../attachments"
import type { FeatureFlagService } from "../feature-flags"
import { EventService, MessageRepository, insertFileCopies } from "../messaging"
import { StreamRepository } from "../streams"
import { UserRepository, syncUserCopies } from "../workspaces"
import { connectionNotFound, writeRefused } from "./errors"
import { importDoc, loadSharedTree, type BridgeCaller, type ImportedContent } from "./export"
import { enqueueProfileRefreshes } from "./profiles"
import { StreamConnectionRepository } from "./repository"

/** Past a caller's settle after a write: its pulls retry three times on 5 s requests. */
const SETTLED_REFRESH_DELAY_MS = 30_000

type WriteCaller = BridgeCaller & { streamId: string }
type MessageCaller = WriteCaller & { messageId: string }

/** What a write must hold before it is applied, checked and prepared in one transaction. */
interface Admission {
  /** The caller's user the write is made as. */
  authorId: string
  /** The caller's users to copy here first: the author and anyone the content mentions. Empty when the copy must already exist. */
  profiles: BridgeWriteUser[]
  /** Content to clean, which is returned cleaned. It keeps references to the files this write sends, or to the targeted message's own. */
  doc?: JSONContent
  /** A send's files, copied here before it lands, and the id its retries repeat. */
  send?: { files: BridgeWriteAttachment[]; clientMessageId: string }
  /** A message the write targets, which must be live in the stream and, when `ownedByAuthor`, written by the author. */
  message?: { id: string; ownedByAuthor: boolean }
}

interface Dependencies {
  pool: Pool
  featureFlagService: FeatureFlagService
  eventService: EventService
}

/**
 * Applies a partner's writes to a channel this workspace hosts, as the
 * partner's own users. Every write is admitted in one transaction that holds the
 * connection, then made through the same event service the host's own users
 * write through, so the host's members see it like any other message.
 */
export class StreamConnectionWriteService {
  private readonly pool: Pool
  private readonly featureFlagService: FeatureFlagService
  private readonly eventService: EventService

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.featureFlagService = deps.featureFlagService
    this.eventService = deps.eventService
  }

  async sendMessage(caller: WriteCaller & BridgeSendMessage): Promise<BridgeSendMessageResponse> {
    const content = await this.admit(caller, {
      authorId: caller.author.id,
      profiles: [caller.author, ...caller.users],
      doc: caller.contentJson,
      send: { files: caller.attachments, clientMessageId: caller.clientMessageId },
    })
    const message = await this.eventService.createMessage({
      workspaceId: caller.workspaceId,
      streamId: caller.streamId,
      authorId: caller.author.id,
      authorType: AuthorTypes.USER,
      ...content,
      attachmentIds: caller.attachments.map((attachment) => attachment.id),
      clientMessageId: caller.clientMessageId,
    })
    // The send is deduped on its id alone, so an id another user already sent under is not this author's to see,
    // and a deleted message would never come back to the caller's copy.
    if (message.authorId !== caller.author.id || message.authorType !== AuthorTypes.USER || message.deletedAt) {
      throw writeRefused("Client message id is taken")
    }
    return { messageId: message.id }
  }

  async editMessage(caller: MessageCaller & BridgeEditMessage): Promise<void> {
    const content = await this.admit(caller, {
      authorId: caller.author.id,
      profiles: [caller.author, ...caller.users],
      doc: caller.contentJson,
      message: { id: caller.messageId, ownedByAuthor: true },
    })
    const edited = await this.eventService.editMessageInternal({
      workspaceId: caller.workspaceId,
      messageId: caller.messageId,
      streamId: caller.streamId,
      ...content,
      attachmentIds: collectAttachmentReferenceIds(content.contentJson),
      actorId: caller.author.id,
      actorType: AuthorTypes.USER,
    })
    if (!edited) throw writeRefused("Message not found")
  }

  async deleteMessage(caller: MessageCaller & { authorId: string }): Promise<void> {
    await this.admit(caller, {
      authorId: caller.authorId,
      profiles: [],
      message: { id: caller.messageId, ownedByAuthor: true },
    })
    const deleted = await this.eventService.deleteMessageInternal({
      workspaceId: caller.workspaceId,
      messageId: caller.messageId,
      streamId: caller.streamId,
      actorId: caller.authorId,
      actorType: AuthorTypes.USER,
    })
    if (!deleted) throw writeRefused("Message not found")
  }

  async addReaction(caller: MessageCaller & BridgeAddReaction & { emoji: string }): Promise<void> {
    await this.admit(caller, {
      authorId: caller.author.id,
      profiles: [caller.author],
      message: { id: caller.messageId, ownedByAuthor: false },
    })
    const reacted = await this.eventService.addReactionInternal({
      workspaceId: caller.workspaceId,
      messageId: caller.messageId,
      streamId: caller.streamId,
      emoji: caller.emoji,
      userId: caller.author.id,
      actorType: AuthorTypes.USER,
    })
    if (!reacted) throw writeRefused("Message not found")
  }

  async removeReaction(caller: MessageCaller & { authorId: string; emoji: string }): Promise<void> {
    await this.admit(caller, {
      authorId: caller.authorId,
      profiles: [],
      message: { id: caller.messageId, ownedByAuthor: false },
    })
    const removed = await this.eventService.removeReactionInternal({
      workspaceId: caller.workspaceId,
      messageId: caller.messageId,
      streamId: caller.streamId,
      emoji: caller.emoji,
      userId: caller.authorId,
      actorType: AuthorTypes.USER,
    })
    if (!removed) throw writeRefused("Message not found")
  }

  /**
   * Holds the connection and checks the write against it, then returns the
   * cleaned content. A connection that isn't the caller's active one is a 404,
   * like every other bridge call; anything the connection can't reach is a refusal.
   */
  private admit(caller: WriteCaller, admission: Admission & { doc: JSONContent }): Promise<ImportedContent>
  private admit(caller: WriteCaller, admission: Admission & { doc?: undefined }): Promise<null>
  private async admit(caller: WriteCaller, admission: Admission): Promise<ImportedContent | null> {
    await this.assertEnabled(caller.workspaceId)
    return withTransaction(this.pool, async (client) => {
      const { connection, tree } = await loadSharedTree(client, caller, { lock: true })
      const stream = tree.find((candidate) => candidate.id === caller.streamId)
      if (!stream) throw writeRefused("Stream is not shared")
      const archivedAncestor = await StreamRepository.findNearestArchivedAncestor(client, caller.workspaceId, stream.id)
      if (stream.archivedAt || archivedAncestor) throw writeRefused("Stream is archived")

      const profiles = [...new Map(admission.profiles.map((user) => [user.id, user])).values()]
      const origins = await UserRepository.findOrigins(client, caller.workspaceId, [
        ...new Set([admission.authorId, ...profiles.map((user) => user.id)]),
      ])
      // An id the host already has must be a copy of the caller's own user, never a host user or another partner's.
      const foreign = [...origins.values()].some((origin) => origin !== caller.callerWorkspaceId)
      const authorKnown = origins.has(admission.authorId) || profiles.some((user) => user.id === admission.authorId)
      if (foreign || !authorKnown) throw writeRefused("Not a user of the caller's workspace")

      if (profiles.length > 0) {
        if (!connection.remoteWorkspaceName) {
          throw new Error(`Connection ${connection.id} is active but names no partner workspace`)
        }
        const insertedCopies = await syncUserCopies(client, {
          workspaceId: caller.workspaceId,
          originWorkspaceId: caller.callerWorkspaceId,
          originWorkspaceName: connection.remoteWorkspaceName,
          users: profiles,
        })
        if (insertedCopies.length > 0) {
          // The caller answers for its users only once its copy holds something they wrote, which this write
          // reaches when the caller's settle pull commits, so a second refresh lands past that settle.
          const refs = [{ workspaceId: caller.workspaceId, connectionId: connection.id }]
          await enqueueProfileRefreshes(client, refs)
          await enqueueProfileRefreshes(client, refs, SETTLED_REFRESH_DELAY_MS)
        }
      }

      if (admission.message) {
        const message = await MessageRepository.findById(client, caller.workspaceId, admission.message.id)
        const live = message !== null && message.deletedAt === null && message.streamId === caller.streamId
        if (!live) throw writeRefused("Message not found")
        if (
          admission.message.ownedByAuthor &&
          (message.authorType !== AuthorTypes.USER || message.authorId !== admission.authorId)
        ) {
          throw writeRefused("Message is not the author's")
        }
      }

      if (!admission.doc) return null
      const attachmentIds = admission.message
        ? (await AttachmentRepository.findByMessageId(client, caller.workspaceId, admission.message.id)).map(
            (row) => row.id
          )
        : await admitFiles(client, caller, connection.id, admission.authorId, admission.send)
      return importDoc(client, {
        workspaceId: caller.workspaceId,
        partnerWorkspaceIds: (
          await StreamConnectionRepository.listConnectedWorkspaces(client, caller.workspaceId, connection.streamId)
        ).map((workspace) => workspace.id),
        tree,
        attachmentIds,
        doc: admission.doc,
      })
    })
  }

  private async assertEnabled(workspaceId: string): Promise<void> {
    const flag = await this.featureFlagService.getWorkspaceFlag(workspaceId, "streamConnections")
    if (flag !== "on") throw connectionNotFound()
  }
}

/**
 * Copies a send's files here, unbound, for the send to bind. A retried send
 * finds its files already here, unbound or bound to the message it sent; an id
 * held for anyone else, or by another message, is not the author's to send.
 */
async function admitFiles(
  client: PoolClient,
  caller: WriteCaller,
  connectionId: string,
  authorId: string,
  send: Admission["send"]
): Promise<string[]> {
  if (!send || send.files.length === 0) return []
  const ids = send.files.map((file) => file.id)
  const held = await AttachmentRepository.findByIds(client, caller.workspaceId, ids)
  if (held.some((row) => row.uploadedBy !== authorId)) throw writeRefused("Attachment is not the author's")
  if (held.some((row) => row.messageId !== null)) {
    const retried = await MessageRepository.findByClientMessageId(
      client,
      caller.workspaceId,
      caller.streamId,
      send.clientMessageId
    )
    if (held.some((row) => row.messageId !== null && row.messageId !== retried?.id)) {
      throw writeRefused("Attachment is already sent")
    }
  }
  const heldIds = new Set(held.map((row) => row.id))
  await insertFileCopies(client, {
    workspaceId: caller.workspaceId,
    connectionId,
    binding: null,
    uploadedBy: authorId,
    files: send.files.filter((file) => !heldIds.has(file.id)),
  })
  return ids
}
