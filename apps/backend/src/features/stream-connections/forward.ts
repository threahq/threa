import type { Pool } from "pg"
import { collectMentionActorRefs } from "@threahq/prosemirror"
import {
  BINDABLE_ATTACHMENT_SAFETY_STATUSES,
  type AttachmentSafetyStatus,
  type BridgeWriteAttachment,
  type BridgeWriteUser,
  type JSONContent,
} from "@threahq/types"
import { AttachmentRepository } from "../attachments"
import { MessageRepository, type Message } from "../messaging"
import type { FeatureFlagService } from "../feature-flags"
import type { Stream } from "../streams"
import { UserRepository } from "../workspaces"
import type { BridgeClient } from "./bridge-client"
import { copyWriteUnsupported, hostUnreachable, writeRefused } from "./errors"
import { bridgeAddress, toActivePartner, type StreamConnectionPullService } from "./pull"
import { StreamConnectionRepository, type ConnectionRef } from "./repository"

const BINDABLE_STATUSES = new Set<AttachmentSafetyStatus>(BINDABLE_ATTACHMENT_SAFETY_STATUSES)

/** A pull that loses a cursor race writes nothing, so it is tried again against the winner's work. */
const PULL_ATTEMPTS = 3

interface Dependencies {
  pool: Pool
  bridgeClient: BridgeClient
  pullService: StreamConnectionPullService
  featureFlagService: FeatureFlagService
}

/** The partner user writing, and the partner's copy of the host stream they write into. */
interface ForwardCaller {
  workspaceId: string
  userId: string
  stream: Stream
}

/**
 * Sends a partner user's write in a shared channel's copy to the host, which
 * owns the channel, then pulls the stream so the result lands in the copy
 * through the one path every copy change takes. Nothing is written locally
 * here; a write the host didn't take leaves the copy as it was. The bridge call
 * holds no database connection (INV-41).
 */
export class StreamConnectionForwardService {
  private readonly pool: Pool
  private readonly bridgeClient: BridgeClient
  private readonly pullService: StreamConnectionPullService
  private readonly featureFlagService: FeatureFlagService

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.bridgeClient = deps.bridgeClient
    this.pullService = deps.pullService
    this.featureFlagService = deps.featureFlagService
  }

  /**
   * A send that failed to confirm is safe to retry: once the pull brought it back the copy answers it, and before
   * that the host dedupes it by its client message id. The sent files stay unbound here until that pull binds them.
   */
  async sendMessage(
    params: ForwardCaller & { clientMessageId: string; contentJson: JSONContent; attachmentIds: string[] }
  ): Promise<Message> {
    const { clientMessageId, contentJson } = params
    const { address, ref, author } = await this.open(params)
    const landed = await MessageRepository.findByClientMessageId(
      this.pool,
      params.workspaceId,
      params.stream.id,
      clientMessageId
    )
    if (landed?.authorId === params.userId) return landed
    const { messageId } = await this.bridgeClient.sendMessage(address, {
      streamId: params.stream.id,
      author,
      users: await this.mentionedOwnUsers(params.workspaceId, contentJson),
      clientMessageId,
      contentJson,
      attachments: await this.newUploads(params.workspaceId, params.userId, params.attachmentIds),
    })
    return this.settle(ref, params.stream.id, messageId)
  }

  async editMessage(
    params: ForwardCaller & { messageId: string; contentJson: JSONContent; attachmentIds: string[] }
  ): Promise<Message> {
    const { messageId, contentJson } = params
    const { address, ref, author } = await this.open(params)
    await this.assertOwnFiles(params.workspaceId, messageId, params.attachmentIds)
    await this.bridgeClient.editMessage(address, {
      streamId: params.stream.id,
      messageId,
      author,
      users: await this.mentionedOwnUsers(params.workspaceId, contentJson),
      contentJson,
    })
    return this.settle(ref, params.stream.id, messageId)
  }

  async deleteMessage(params: ForwardCaller & { messageId: string }): Promise<void> {
    const { address, ref, author } = await this.open(params)
    await this.bridgeClient.deleteMessage(address, {
      streamId: params.stream.id,
      messageId: params.messageId,
      authorId: author.id,
    })
    await this.catchUp(ref, params.stream.id)
  }

  async addReaction(params: ForwardCaller & { messageId: string; emoji: string }): Promise<Message> {
    const { address, ref, author } = await this.open(params)
    await this.bridgeClient.addReaction(address, {
      streamId: params.stream.id,
      messageId: params.messageId,
      emoji: params.emoji,
      author,
    })
    return this.settle(ref, params.stream.id, params.messageId)
  }

  async removeReaction(params: ForwardCaller & { messageId: string; emoji: string }): Promise<Message> {
    const { address, ref, author } = await this.open(params)
    await this.bridgeClient.removeReaction(address, {
      streamId: params.stream.id,
      messageId: params.messageId,
      emoji: params.emoji,
      authorId: author.id,
    })
    return this.settle(ref, params.stream.id, params.messageId)
  }

  /** The active connection the copy belongs to, as seen from this partner, and the user writing. */
  private async open({ workspaceId, userId, stream }: ForwardCaller) {
    // A pull is skipped while Connect is off, so a write let through here would reach the host and never come back.
    const flag = await this.featureFlagService.getWorkspaceFlag(workspaceId, "streamConnections")
    if (flag !== "on") throw writeRefused("Shared channels are off for this workspace")
    const connections = await StreamConnectionRepository.listLiveForStream(
      this.pool,
      workspaceId,
      stream.rootStreamId ?? stream.id
    )
    const connection = connections
      .map((live) => toActivePartner({ workspaceId, connectionId: live.id }, live))
      .find(Boolean)
    if (!connection) throw writeRefused("Stream is not a shared channel this workspace may write to")

    const user = await UserRepository.findById(this.pool, workspaceId, userId)
    if (!user) throw new Error(`User ${userId} is missing from ${workspaceId}`)
    const author: BridgeWriteUser = { id: user.id, name: user.name, slug: user.slug }
    return {
      address: bridgeAddress(connection),
      ref: { workspaceId, connectionId: connection.connectionId },
      author,
    }
  }

  /** This workspace's own users the content mentions: the host has no profile for them until it is told. */
  private async mentionedOwnUsers(workspaceId: string, contentJson: JSONContent): Promise<BridgeWriteUser[]> {
    const ids = collectMentionActorRefs(contentJson).flatMap((ref) => (ref.actorType === "user" ? [ref.actorId] : []))
    const users = await UserRepository.findByIds(this.pool, workspaceId, ids)
    return users
      .filter((user) => user.originWorkspaceId === null)
      .map((user) => ({ id: user.id, name: user.name, slug: user.slug }))
  }

  /** An edit keeps the message's own files and adds none: a file reaches the host only with the send that brings it. */
  private async assertOwnFiles(workspaceId: string, messageId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const rows = await AttachmentRepository.findByIds(this.pool, workspaceId, ids)
    if (rows.length !== ids.length || rows.some((row) => row.messageId !== messageId)) {
      throw copyWriteUnsupported("Files can't be added to a sent message in a shared channel")
    }
  }

  /** A send carries only files its author uploaded and hasn't sent yet: the host copies each one, and nothing else is the author's to give it. */
  private async newUploads(workspaceId: string, userId: string, ids: string[]): Promise<BridgeWriteAttachment[]> {
    const rows = await AttachmentRepository.findByIds(this.pool, workspaceId, ids)
    const sendable = rows.filter(
      (row) =>
        row.uploadedBy === userId &&
        row.messageId === null &&
        !row.e2eOnly &&
        BINDABLE_STATUSES.has(row.safetyStatus)
    )
    if (sendable.length !== ids.length) {
      throw copyWriteUnsupported("Only files you just uploaded can be sent to a shared channel")
    }
    return sendable.map(({ id, filename, mimeType, sizeBytes, width, height }) => ({
      id,
      filename,
      mimeType,
      sizeBytes,
      width,
      height,
    }))
  }

  /** The copy of a message the host now holds. Absent means the pull could not bring it in, which a retry can. */
  private async settle(ref: ConnectionRef, streamId: string, messageId: string): Promise<Message> {
    await this.catchUp(ref, streamId)
    const message = await MessageRepository.findById(this.pool, ref.workspaceId, messageId)
    if (!message) throw hostUnreachable(`Message ${messageId} did not reach the copy`)
    return message
  }

  private async catchUp(ref: ConnectionRef, streamId: string): Promise<void> {
    for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
      if (await this.pullService.pull(ref, { streamId })) return
    }
    throw hostUnreachable(`Stream ${streamId} did not catch up with its host`)
  }
}
