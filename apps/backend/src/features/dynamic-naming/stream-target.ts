import type { Pool, PoolClient } from "pg"
import { StreamTypes, TitleSources, Visibilities } from "@threa/types"
import { withClient } from "../../db"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { AttachmentRepository, awaitAttachmentProcessing, type AttachmentWithExtraction } from "../attachments"
import { E2eStreamsRepository } from "../e2e-streams"
import { awaitLinkPreviewProcessing, enrichMessagesWithLinkPreviewMap } from "../link-previews"
import { MessageRepository } from "../messaging"
import { prependThreadNamingAnchor, resolveEffectiveAccessStream, StreamRepository, type Stream } from "../streams"
import { DYNAMIC_NAMING_MAX_EXISTING_TITLES, DYNAMIC_NAMING_MAX_MESSAGES } from "./config"
import type {
  DynamicNamingTargetAdapter,
  DynamicNamingTargetContext,
  DynamicNamingTargetLockParams,
  DynamicNamingTargetSnapshot,
} from "./types"

interface StreamTargetSnapshot extends DynamicNamingTargetSnapshot {
  stream: Stream
}

function isStreamTargetSnapshot(target: DynamicNamingTargetSnapshot): target is StreamTargetSnapshot {
  return "stream" in target
}

export class DynamicNamingStreamTarget implements DynamicNamingTargetAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly messageFormatter: MessageFormatter
  ) {}

  async resolveAuthorityStreamId(_client: PoolClient, params: DynamicNamingTargetLockParams): Promise<string | null> {
    return params.targetKind === "stream" ? params.targetId : null
  }

  async lockAndValidate(
    client: PoolClient,
    params: DynamicNamingTargetLockParams
  ): Promise<StreamTargetSnapshot | null> {
    if (params.targetKind !== "stream") return null
    // A contended title row is delayed work, not a protected/missing target.
    // Block inside this short DB-only claim/apply phase so SKIP LOCKED cannot
    // acknowledge and permanently lose an eligible checkpoint.
    const stream = await StreamRepository.findByIdForUpdateBlocking(client, params.targetId)
    if (!stream || stream.workspaceId !== params.workspaceId || stream.archivedAt) return null
    if (
      stream.type !== StreamTypes.SCRATCHPAD &&
      stream.type !== StreamTypes.THREAD &&
      stream.type !== StreamTypes.ASIDE
    )
      return null
    if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, params.targetId)) return null

    const source = stream.displayNameSource ?? (stream.displayName ? TitleSources.LEGACY : null)
    if (source !== null && source !== TitleSources.GENERATED) return null
    const titleRevision = stream.displayNameRevision ?? 0
    if (params.expectedTitleRevision !== undefined && params.expectedTitleRevision !== titleRevision) return null

    const stats = await MessageRepository.getNamingStats(client, stream.id)
    return {
      workspaceId: stream.workspaceId,
      targetKind: "stream",
      targetId: stream.id,
      messageCount: stats.count,
      latestMessageAt: stats.latestMessageAt,
      title: stream.displayName,
      titleSource: source,
      titleRevision,
      stream,
    }
  }

  async loadContext(target: DynamicNamingTargetSnapshot): Promise<DynamicNamingTargetContext | null> {
    const fetched = await withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, target.targetId)
      if (!stream || stream.workspaceId !== target.workspaceId) return null
      if (await E2eStreamsRepository.isE2eStream(client, target.workspaceId, target.targetId)) return null
      const replies = await MessageRepository.list(client, stream.id, { limit: DYNAMIC_NAMING_MAX_MESSAGES })
      const messages = await prependThreadNamingAnchor(client, stream, replies)
      const siblings = await StreamRepository.list(client, stream.workspaceId, { types: [stream.type] })
      const attachmentsByMessage = await AttachmentRepository.findByMessageIds(
        client,
        messages.map((message) => message.id)
      )
      const attachmentIds = [...attachmentsByMessage.values()].flatMap((attachments) =>
        attachments.map((attachment) => attachment.id)
      )
      return { stream, messages, siblings, attachmentIds }
    })
    if (!fetched || fetched.messages.length === 0) return null

    const linkPreviewProcessing = awaitLinkPreviewProcessing(this.pool, target.workspaceId, fetched.messages)
    if (fetched.attachmentIds.length > 0) {
      const result = await awaitAttachmentProcessing(this.pool, fetched.attachmentIds)
      logger.debug(
        {
          targetId: target.targetId,
          completedCount: result.completedIds.length,
          failedCount: result.failedOrTimedOutIds.length,
        },
        "Dynamic naming attachment context ready"
      )
    }

    const [linkPreviews, attachmentsByMessageId] = await Promise.all([
      linkPreviewProcessing,
      fetched.attachmentIds.length > 0
        ? AttachmentRepository.findByMessageIdsWithExtractions(
            this.pool,
            fetched.messages.map((message) => message.id)
          )
        : Promise.resolve(new Map<string, AttachmentWithExtraction[]>()),
    ])
    const messages = enrichMessagesWithLinkPreviewMap(fetched.messages, linkPreviews.previewsByMessage)
    const context = await this.messageFormatter.formatMessagesWithAttachments(
      this.pool,
      target.workspaceId,
      messages,
      attachmentsByMessageId
    )
    const existingTitles = fetched.siblings
      .filter((stream) => stream.id !== target.targetId && stream.displayName)
      .slice(0, DYNAMIC_NAMING_MAX_EXISTING_TITLES)
      .map((stream) => stream.displayName!)
    return { context, existingTitles }
  }

  async applyRename(client: PoolClient, target: DynamicNamingTargetSnapshot, title: string): Promise<number | null> {
    if (!isStreamTargetSnapshot(target)) return null
    const named = await StreamRepository.updateDisplayName(client, {
      workspaceId: target.workspaceId,
      streamId: target.targetId,
      displayName: title,
      source: TitleSources.GENERATED,
      expectedRevision: target.titleRevision,
      expectedSource: target.titleSource,
    })
    if (!named) return null

    const effective = await resolveEffectiveAccessStream(client, target.stream)
    const visibility =
      target.stream.rootStreamId && effective.id !== target.stream.rootStreamId
        ? Visibilities.PRIVATE
        : effective.visibility
    await OutboxRepository.insert(client, "stream:display_name_updated", {
      workspaceId: target.workspaceId,
      streamId: target.targetId,
      displayName: title,
      visibility,
      source: TitleSources.GENERATED,
      revision: named.displayNameRevision!,
    })
    return named.displayNameRevision ?? null
  }
}
