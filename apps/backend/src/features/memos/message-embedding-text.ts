import type { Pool } from "pg"
import type { StreamType } from "@threa/types"
import { AuthorTypes, StreamTypes } from "@threa/types"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import type { EmbeddingServiceLike } from "./embedding-service"

export const ANCHOR_MAX_CHARS = 300
export const PRECEDING_MAX_CHARS = 200
export const PRECEDING_MAX_COUNT = 3
export const CONTENT_MAX_CHARS = 8000

export interface MessageEmbeddingTextInput {
  streamType: StreamType
  streamName: string | null
  anchor: string | null
  preceding: string[]
  content: string
}

export function buildMessageEmbeddingText(input: MessageEmbeddingTextInput): string {
  const header = input.streamName ? `${input.streamType}: ${input.streamName}` : input.streamType

  const lines: string[] = [header]

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
 * Loads the stream/anchor/preceding-message context around `message` and
 * renders it through `buildMessageEmbeddingText`. Shared by the live embedding
 * path (`embedMessageWithContext`) and the backfill so both embed identical text.
 */
export async function loadMessageEmbeddingText(pool: Pool, message: Message): Promise<string> {
  const stream = await StreamRepository.findById(pool, message.streamId)
  if (!stream) {
    throw new Error(`Stream ${message.streamId} not found for message ${message.id}`)
  }

  let anchor: string | null = null
  if (stream.type === StreamTypes.THREAD && stream.parentAnchorId?.startsWith("msg_")) {
    const anchorMessage = await MessageRepository.findById(pool, stream.parentAnchorId)
    anchor = anchorMessage && !anchorMessage.deletedAt ? anchorMessage.contentMarkdown : null
  }

  const surrounding = await MessageRepository.findSurrounding(
    pool,
    message.id,
    message.streamId,
    PRECEDING_MAX_COUNT,
    0
  )
  const preceding = surrounding
    .filter((candidate) => candidate.id !== message.id && candidate.authorType !== AuthorTypes.SYSTEM)
    .map((candidate) => candidate.contentMarkdown)

  return buildMessageEmbeddingText({
    streamType: stream.type,
    streamName: stream.displayName ?? stream.slug,
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

  const text = await loadMessageEmbeddingText(pool, message)

  const embedding = await embeddingService.embed(text, {
    workspaceId,
    functionId: "message-embedding",
  })

  await MessageRepository.updateEmbedding(pool, message.id, embedding)
}
