/**
 * Shared fixtures for the memo-classifier and memorizer suites: production-
 * shaped message rendering and minimal Conversation/Memo rows built from eval
 * case data.
 */

import { ulid } from "ulid"
import type { Memo } from "../../src/features/memos"
import type { Conversation } from "../../src/features/conversations"
import { MemoStatuses, MemoTypes, ConversationStatuses } from "@threa/types"
import { formatRelativeDate } from "../../src/lib/temporal"
import type { EvalClassifierMessage } from "../suites/memo-classifier/types"

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Render messages exactly as MessageFormatter.formatMessages does in production
 * with `{ includeIds: true, relativeTo: now }` (the classifier counts messages by
 * splitting on "<message"), but from eval fixtures instead of DB rows. Keep the
 * attribute shape — including the relative `age` — in step with
 * MessageFormatter.formatSingleMessage so evals exercise the real prompt (INV-45).
 */
export function formatEvalMessages(messages: EvalClassifierMessage[], now: Date): string {
  const rendered = messages.map((m, i) => {
    const id = m.id ?? `msg_${ulid()}`
    const createdAt = new Date(now.getTime() - (m.minutesAgo ?? (messages.length - i) * 2) * 60_000)
    const age = escapeXml(formatRelativeDate(createdAt, now))
    return `<message id="${id}" authorType="${m.authorType}" authorId="${m.authorId}" authorName="${escapeXml(m.authorName)}" createdAt="${createdAt.toISOString()}" age="${age}">${escapeXml(m.contentMarkdown)}</message>`
  })
  return `<messages>\n${rendered.join("\n")}\n</messages>`
}

export function toConversation(input: { topicSummary: string | null; participantIds: string[] }): Conversation {
  const now = new Date()
  return {
    id: `conv_${ulid()}`,
    streamId: `stream_${ulid()}`,
    workspaceId: `ws_${ulid()}`,
    messageIds: [],
    participantIds: input.participantIds,
    secondaryMessageIds: [],
    topicSummary: input.topicSummary,
    summary: null,
    completenessScore: 5,
    confidence: 0.9,
    status: ConversationStatuses.ACTIVE,
    parentConversationId: null,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

export function toMemo(m: { title: string; abstract: string; createdDaysAgo?: number }, conversationId: string): Memo {
  const createdAt = new Date(Date.now() - (m.createdDaysAgo ?? 1) * 24 * 60 * 60 * 1000)
  return {
    id: `memo_${ulid()}`,
    workspaceId: "ws_eval",
    memoType: MemoTypes.CONVERSATION,
    sourceMessageId: null,
    sourceConversationId: conversationId,
    title: m.title,
    abstract: m.abstract,
    keyPoints: [],
    sourceMessageIds: [],
    participantIds: [],
    knowledgeType: "context",
    tags: [],
    parentMemoId: null,
    status: MemoStatuses.ACTIVE,
    version: 1,
    revisionReason: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
  }
}
