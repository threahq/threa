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

import type { EvalSuite, EvalContext } from "../../framework/types"
import { memoClassifierCases } from "./cases"
import type { MemoClassifierInput, MemoClassifierOutput, MemoClassifierExpected } from "./types"
import { worthinessEvaluator, revisionEvaluator, accuracyEvaluator, garbageLeakRateEvaluator } from "./evaluators"
import { MemoClassifier, MEMO_CLASSIFIER_MODEL_ID, MEMO_TEMPERATURES } from "../../../src/features/memos"
import { MessageFormatter } from "../../../src/lib/ai/message-formatter"
import { formatEvalMessages, toConversation, toMemo } from "../../fixtures/memo"

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
