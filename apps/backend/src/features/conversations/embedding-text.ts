import { createHash } from "node:crypto"
import type { Querier } from "../../db"
import { MessageRepository } from "../messaging"
import type { Conversation } from "./repository"

export const TOPIC_MAX_CHARS = 200
export const SUMMARY_MAX_CHARS = 400
export const OPENING_MAX_CHARS = 300

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * A conversation is worth embedding once extraction has described it (topic
 * summary or summary) and it still owns at least one primary message. The
 * SQL twin of this rule is `ELIGIBLE_PREDICATE` in `embedding-backfill.ts`.
 */
export function isConversationEmbeddable(
  conversation: Pick<Conversation, "topicSummary" | "summary" | "messageIds">
): boolean {
  return conversation.messageIds.length > 0 && (hasText(conversation.topicSummary) || hasText(conversation.summary))
}

export interface ConversationEmbeddingTextInput {
  topicSummary: string | null
  summary: string | null
  opening: string | null
}

export function buildConversationEmbeddingText(input: ConversationEmbeddingTextInput): string {
  const lines: string[] = []
  if (hasText(input.topicSummary)) lines.push(input.topicSummary.trim().slice(0, TOPIC_MAX_CHARS))
  if (hasText(input.summary)) lines.push(input.summary.trim().slice(0, SUMMARY_MAX_CHARS))
  if (hasText(input.opening)) lines.push(input.opening.trim().slice(0, OPENING_MAX_CHARS))
  return lines.join("\n")
}

export function hashConversationEmbeddingText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/**
 * Build the embedding text for each conversation, keyed by conversation id.
 * The opening message (`message_ids[0]`) is read in one batch; a deleted or
 * missing opener just drops that line.
 */
export async function loadConversationEmbeddingTexts(
  db: Querier,
  conversations: Conversation[]
): Promise<Map<string, string>> {
  const openingIds = conversations.map((conversation) => conversation.messageIds[0]).filter((id) => id !== undefined)
  const openers = await MessageRepository.findByIds(db, openingIds)

  const texts = new Map<string, string>()
  for (const conversation of conversations) {
    const openingId = conversation.messageIds[0]
    const opener = openingId === undefined ? undefined : openers.get(openingId)
    const opening =
      opener && opener.streamId === conversation.streamId && opener.deletedAt === null ? opener.contentMarkdown : null
    texts.set(
      conversation.id,
      buildConversationEmbeddingText({
        topicSummary: conversation.topicSummary,
        summary: conversation.summary,
        opening,
      })
    )
  }
  return texts
}
