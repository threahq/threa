/**
 * Memo Classifier Evaluation Suite
 *
 * Tests the knowledge-worthiness gate: does a settled conversation deserve
 * memos at all, and should existing memos be revised? Runs the production
 * MemoClassifier (INV-45) with production config (INV-44).
 *
 * ## Usage
 *
 *   bun run eval -- -s memo-classifier
 *   bun run eval -- -s memo-classifier -c news-hot-takes-001
 *
 * ## Key Evaluators
 *
 * - worthiness: Correct isKnowledgeWorthy decision?
 * - revision: Correct shouldReviseExisting decision (revision cases)?
 * - garbage-leak-rate (run-level): share of chatter classified as knowledge
 */

import { ulid } from "ulid"
import type { EvalSuite, EvalContext } from "../../framework/types"
import { memoClassifierCases } from "./cases"
import type { MemoClassifierInput, MemoClassifierOutput, MemoClassifierExpected, EvalClassifierMessage } from "./types"
import { worthinessEvaluator, revisionEvaluator, accuracyEvaluator, garbageLeakRateEvaluator } from "./evaluators"
import { MemoClassifier, MEMO_CLASSIFIER_MODEL_ID, MEMO_TEMPERATURES } from "../../../src/features/memos"
import type { Memo } from "../../../src/features/memos"
import type { Conversation } from "../../../src/features/conversations"
import { MessageFormatter } from "../../../src/lib/ai/message-formatter"
import { MemoStatuses, MemoTypes, ConversationStatuses } from "@threa/types"

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Render messages exactly as MessageFormatter.formatMessages does in
 * production (the classifier counts messages by splitting on "<message"), but
 * from eval fixtures instead of DB rows.
 */
export function formatEvalMessages(messages: EvalClassifierMessage[], now: Date): string {
  const rendered = messages.map((m, i) => {
    const id = m.id ?? `msg_${ulid()}`
    const createdAt = new Date(now.getTime() - (m.minutesAgo ?? (messages.length - i) * 2) * 60_000)
    return `<message id="${id}" authorType="${m.authorType}" authorId="${m.authorId}" authorName="${escapeXml(m.authorName)}" createdAt="${createdAt.toISOString()}">${escapeXml(m.contentMarkdown)}</message>`
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

async function runClassifierTask(input: MemoClassifierInput, ctx: EvalContext): Promise<MemoClassifierOutput> {
  const classifier = new MemoClassifier(ctx.ai, ctx.configResolver, new MessageFormatter())
  const conversation = toConversation({
    topicSummary: input.topicSummary,
    participantIds: [...new Set(input.messages.map((m) => m.authorId))],
  })
  const formattedMessages = formatEvalMessages(input.messages, new Date())
  const existingMemos = (input.existingMemos ?? []).map((m) => toMemo(m, conversation.id))

  try {
    const result = await classifier.classifyConversation(conversation, formattedMessages, existingMemos, {
      workspaceId: ctx.workspaceId,
    })
    return {
      input,
      isKnowledgeWorthy: result.isKnowledgeWorthy,
      shouldReviseExisting: result.shouldReviseExisting,
      confidence: result.confidence,
      containsActionItems: result.containsActionItems,
    }
  } catch (error) {
    return {
      input,
      isKnowledgeWorthy: false,
      shouldReviseExisting: false,
      confidence: 0,
      containsActionItems: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const memoClassifierSuite: EvalSuite<MemoClassifierInput, MemoClassifierOutput, MemoClassifierExpected> = {
  name: "memo-classifier",
  description: "Tests the memo knowledge-worthiness classifier",

  cases: memoClassifierCases,

  task: runClassifierTask,

  evaluators: [worthinessEvaluator, revisionEvaluator],

  runEvaluators: [accuracyEvaluator, garbageLeakRateEvaluator],

  defaultPermutations: [
    {
      model: MEMO_CLASSIFIER_MODEL_ID,
      temperature: MEMO_TEMPERATURES.classification,
    },
  ],
}

export default memoClassifierSuite
