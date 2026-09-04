import type { Pool } from "pg"
import type { StreamType } from "@threa/types"
import { AuthorTypes, StreamTypes } from "@threa/types"
import { ConversationRepository } from "../conversations"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import { logger } from "../../lib/logger"
import type { EmbeddingServiceLike } from "./embedding-service"

export const ANCHOR_MAX_CHARS = 300
export const PRECEDING_MAX_CHARS = 200
export const PRECEDING_MAX_COUNT = 3
export const CONTENT_MAX_CHARS = 8000
export const TOPIC_MAX_CHARS = 200
export const SUMMARY_MAX_CHARS = 400

export interface MessageEmbeddingTextInput {
  streamType: StreamType
  streamName: string | null
  topic: string | null
  summary: string | null
  anchor: string | null
  preceding: string[]
  content: string
}

export function buildMessageEmbeddingText(input: MessageEmbeddingTextInput): string {
  const header = input.streamName ? `${input.streamType}: ${input.streamName}` : input.streamType

  const lines: string[] = [header]

  if (input.topic) {
    lines.push(input.topic.slice(0, TOPIC_MAX_CHARS))
  }

  if (input.summary) {
    lines.push(input.summary.slice(0, SUMMARY_MAX_CHARS))
  }

  if (input.anchor) {
    lines.push(input.anchor.slice(0, ANCHOR_MAX_CHARS))
  }

  for (const message of input.preceding.slice(-PRECEDING_MAX_COUNT)) {
    if (message) {
      lines.push(message.slice(0, PRECEDING_MAX_CHARS))
    }
  }

  lines.push("")
  lines.push(input.content.slice(0, CONTENT_MAX_CHARS))

  return lines.join("\n")
}

export interface EmbedMessageWithContextDeps {
  pool: Pool
  embeddingService: EmbeddingServiceLike
}

/**
 * Loads the stream/anchor/message's-primary-conversation context around
 * `message` and renders it through `buildMessageEmbeddingText`. Shared by the
 * live embedding path (`embedMessageWithContext`) and the backfill so both
 * embed identical text. Returns `null` when the message's stream is gone —
 * callers decide how to skip.
 */
export async function loadMessageEmbeddingText(
  pool: Pool,
  workspaceId: string,
  message: Message
): Promise<string | null> {
  const stream = await StreamRepository.findById(pool, message.streamId)
  if (!stream) {
    return null
  }

  let anchor: string | null = null
  if (stream.type === StreamTypes.THREAD && stream.parentAnchorId?.startsWith("msg_")) {
    const anchorMessage = await MessageRepository.findById(pool, stream.parentAnchorId)
    anchor = anchorMessage && !anchorMessage.deletedAt ? anchorMessage.contentMarkdown : null
  }

  const conversation = await ConversationRepository.findPrimaryByMessageId(pool, workspaceId, message.id)

  let preceding: string[] = []
  let topic: string | null = null
  let summary: string | null = null

  if (conversation) {
    const precedingIds = conversation.messageIds.filter((id) => id < message.id).slice(-PRECEDING_MAX_COUNT)
    const byId = await MessageRepository.findByIds(pool, precedingIds)
    preceding = precedingIds
      .map((id) => byId.get(id))
      .filter(
        (candidate): candidate is Message =>
          candidate !== undefined && !candidate.deletedAt && candidate.authorType !== AuthorTypes.SYSTEM
      )
      .map((candidate) => candidate.contentMarkdown)
    topic = conversation.topicSummary
    summary = conversation.summary
  }

  return buildMessageEmbeddingText({
    streamType: stream.type,
    streamName: stream.displayName ?? stream.slug,
    topic,
    summary,
    anchor,
    preceding,
    content: message.contentMarkdown,
  })
}

export async function embedMessageWithContext(
  deps: EmbedMessageWithContextDeps,
  workspaceId: string,
  message: Message
): Promise<void> {
  const { pool, embeddingService } = deps

  const text = await loadMessageEmbeddingText(pool, workspaceId, message)
  if (text === null) {
    logger.warn({ messageId: message.id, streamId: message.streamId }, "Skipping embedding: stream not found")
    return
  }

  const embedding = await embeddingService.embed(text, {
    workspaceId,
    functionId: "message-embedding",
  })

  await MessageRepository.updateEmbedding(pool, message.id, embedding)
}
