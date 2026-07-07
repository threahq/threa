/**
 * Shared fixtures for the memo-classifier and memorizer suites: production-
 * shaped message rendering and minimal Conversation/Memo rows built from eval
 * case data.
 */

import { ulid } from "ulid"
import type { Memo } from "../../src/features/memos"
import type { Conversation } from "../../src/features/conversations"
import { MemoStatuses, MemoTypes, ConversationStatuses } from "@threa/types"
import { renderMessagesXml } from "../../src/lib/ai/message-formatter"
import type { EvalClassifierMessage } from "../suites/memo-classifier/types"

/**
 * Render eval-fixture messages through the SAME production renderer the memo
 * pipeline uses (`{ includeIds: true, relativeTo: now }`), so evals can't test a
 * prompt that has drifted from production (INV-45). The fixtures already carry
 * resolved author names, so no DB `Querier` is needed — only production's
 * DB-bound name resolution is skipped, never the wire-format rendering itself.
 */
export function formatEvalMessages(messages: EvalClassifierMessage[], now: Date): string {
  return renderMessagesXml(
    messages.map((m, i) => ({
      id: m.id ?? `msg_${ulid()}`,
      authorType: m.authorType,
      authorId: m.authorId,
      authorName: m.authorName,
      contentMarkdown: m.contentMarkdown,
      createdAt: new Date(now.getTime() - (m.minutesAgo ?? (messages.length - i) * 2) * 60_000),
    })),
    { includeIds: true, relativeTo: now }
  )
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
