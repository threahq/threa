import type { Pool, PoolClient } from "pg"
import { StreamTypes, TitleSources } from "@threa/types"
import { withClient } from "../../db"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository, awaitAttachmentProcessing, type AttachmentWithExtraction } from "../attachments"
import {
  addStalenessFields,
  ConversationRepository,
  MessageConversationStateRepository,
  resolveConversationDelivery,
  type Conversation,
} from "../conversations"
import { E2eStreamsRepository } from "../e2e-streams"
import { awaitLinkPreviewProcessing, enrichMessagesWithLinkPreviewMap } from "../link-previews"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import { DYNAMIC_NAMING_MAX_EXISTING_TITLES, DYNAMIC_NAMING_MAX_MESSAGES } from "./config"
import type {
  DynamicNamingTargetAdapter,
  DynamicNamingTargetContext,
  DynamicNamingTargetLockParams,
  DynamicNamingTargetSnapshot,
} from "./types"

interface ConversationTargetSnapshot extends DynamicNamingTargetSnapshot {
  conversation: Conversation
}

function isConversationSnapshot(target: DynamicNamingTargetSnapshot): target is ConversationTargetSnapshot {
  return "conversation" in target
}

function orderedPrimaryMessages(conversation: Conversation, messages: Map<string, Message>): Message[] {
  return conversation.messageIds
    .flatMap((id) => {
      const message = messages.get(id)
      return message ? [message] : []
    })
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
}

export class DynamicNamingConversationTarget implements DynamicNamingTargetAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly messageFormatter: MessageFormatter
  ) {}

  async lockAndValidate(
    client: PoolClient,
    params: DynamicNamingTargetLockParams
  ): Promise<ConversationTargetSnapshot | null> {
    if (params.targetKind !== "conversation") return null
    const conversation = await ConversationRepository.findByIdForUpdate(client, params.workspaceId, params.targetId)
    if (!conversation) return null
    const stream = await StreamRepository.findById(client, conversation.streamId)
    if (!stream || stream.workspaceId !== params.workspaceId || stream.type === StreamTypes.SCRATCHPAD) return null
    if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, conversation.streamId)) return null
    const source = conversation.topicSummarySource ?? (conversation.topicSummary ? TitleSources.LEGACY : null)
    if (source !== null && source !== TitleSources.GENERATED) return null
    const titleRevision = conversation.topicSummaryRevision ?? 0
    if (params.expectedTitleRevision !== undefined && params.expectedTitleRevision !== titleRevision) return null

    const messages = await MessageRepository.findByIdsInWorkspace(client, params.workspaceId, conversation.messageIds)
    const primary = orderedPrimaryMessages(conversation, messages)
    return {
      workspaceId: params.workspaceId,
      targetKind: "conversation",
      targetId: conversation.id,
      messageCount: primary.length,
      latestMessageAt: primary.at(-1)?.createdAt ?? null,
      title: conversation.topicSummary,
      titleSource: source,
      titleRevision,
      conversation,
    }
  }

  async loadContext(target: DynamicNamingTargetSnapshot): Promise<DynamicNamingTargetContext | null> {
    const fetched = await withClient(this.pool, async (client) => {
      const conversation = await ConversationRepository.findById(client, target.targetId)
      if (!conversation || conversation.workspaceId !== target.workspaceId) return null
      const stream = await StreamRepository.findById(client, conversation.streamId)
      if (!stream || stream.type === StreamTypes.SCRATCHPAD) return null
      if (await E2eStreamsRepository.isE2eStream(client, target.workspaceId, conversation.streamId)) return null
      const byId = await MessageRepository.findByIdsInWorkspace(client, target.workspaceId, conversation.messageIds)
      const messages = orderedPrimaryMessages(conversation, byId).slice(-DYNAMIC_NAMING_MAX_MESSAGES)
      const siblings = await ConversationRepository.findByStreamIncludingThreads(
        client,
        stream.rootStreamId ?? stream.id,
        { limit: DYNAMIC_NAMING_MAX_EXISTING_TITLES + 1 }
      )
      const attachments = await AttachmentRepository.findByMessageIds(
        client,
        messages.map((message) => message.id)
      )
      return {
        conversation,
        messages,
        siblings,
        attachmentIds: [...attachments.values()].flatMap((items) => items.map((item) => item.id)),
      }
    })
    if (!fetched || fetched.messages.length === 0) return null

    const linkPreviewProcessing = awaitLinkPreviewProcessing(this.pool, target.workspaceId, fetched.messages)
    if (fetched.attachmentIds.length > 0) await awaitAttachmentProcessing(this.pool, fetched.attachmentIds)
    const [linkPreviews, attachments] = await Promise.all([
      linkPreviewProcessing,
      fetched.attachmentIds.length
        ? AttachmentRepository.findByMessageIdsWithExtractions(
            this.pool,
            fetched.messages.map((message) => message.id)
          )
        : Promise.resolve(new Map<string, AttachmentWithExtraction[]>()),
    ])
    const enriched = enrichMessagesWithLinkPreviewMap(fetched.messages, linkPreviews.previewsByMessage)
    const messages = await this.messageFormatter.formatMessagesWithAttachments(
      this.pool,
      target.workspaceId,
      enriched,
      attachments
    )
    const summary = fetched.conversation.summary
      ? `${JSON.stringify({ rollingSummary: fetched.conversation.summary })}\n`
      : ""
    return {
      context: `${summary}${messages}`,
      existingTitles: fetched.siblings
        .filter((conversation) => conversation.id !== target.targetId && conversation.topicSummary)
        .map((conversation) => conversation.topicSummary!)
        .slice(0, DYNAMIC_NAMING_MAX_EXISTING_TITLES),
    }
  }

  async applyRename(client: PoolClient, target: DynamicNamingTargetSnapshot, title: string): Promise<number | null> {
    if (!isConversationSnapshot(target)) return null
    const updated = await ConversationRepository.updateTopicSummary(client, {
      workspaceId: target.workspaceId,
      conversationId: target.targetId,
      topicSummary: title,
      source: TitleSources.GENERATED,
      expectedRevision: target.titleRevision,
      expectedSource: target.titleSource,
    })
    if (!updated) return null
    const stream = await StreamRepository.findById(client, updated.streamId)
    const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)
    const settling = await MessageConversationStateRepository.listSettlingByConversationIds(
      client,
      target.workspaceId,
      [updated.id]
    )
    await OutboxRepository.insert(client, "conversation:updated", {
      workspaceId: target.workspaceId,
      streamId: updated.streamId,
      conversationId: updated.id,
      conversation: addStalenessFields(updated),
      parentStreamId,
      streamVisibility,
      settlingMessageIds: settling.get(updated.id) ?? [],
    })
    return updated.topicSummaryRevision ?? null
  }
}
