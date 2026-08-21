/**
 * Memorizer Evaluation Suite
 *
 * Tests memo generation quality from settled conversations: selectivity (only
 * durable knowledge, no banter/hot-takes), revision discipline (already-covered
 * topics are not re-emitted), and terseness. Runs the production Memorizer
 * (INV-45) with production config (INV-44).
 *
 * ## Usage
 *
 *   bun run eval -- -s memorizer
 *   bun run eval -- -s memorizer -c revision-all-covered-001
 *
 * ## Key Evaluators
 *
 * - memo-count: within expected min/max (0 = must return nothing)
 * - coverage: durable facts are captured
 * - exclusion: banter/hot-take words never appear in memos
 * - over-capture-rate (run-level): memos emitted where none were warranted
 */

import { ulid } from "ulid"
import type { EvalSuite, EvalContext } from "../../framework/types"
import { memorizerCases } from "./cases"
import type { MemorizerInput, MemorizerOutput, MemorizerExpected } from "./types"
import {
  memoCountEvaluator,
  coverageEvaluator,
  exclusionEvaluator,
  conclusionEvaluator,
  supersessionEvaluator,
  accuracyEvaluator,
  overCaptureRateEvaluator,
} from "./evaluators"
import { Memorizer, MEMO_MEMORIZER_MODEL_ID, MEMO_TEMPERATURES } from "../../../src/features/memos"
import { MessageFormatter } from "../../../src/lib/ai/message-formatter"
import { formatEvalMessages, toMemo } from "../../fixtures/memo"
import type { Message } from "../../../src/features/messaging"

/**
 * Minimal Message rows matching the ids rendered into the prompt, so the
 * production source-citation resolution has real ids to validate against.
 */
function toMessages(input: MemorizerInput, now: Date): { messages: Message[]; formatted: string } {
  const withIds = input.messages.map((m) => ({ ...m, id: m.id ?? `msg_${ulid()}` }))
  const formatted = formatEvalMessages(withIds, now)
  const messages = withIds.map(
    (m, i) =>
      ({
        id: m.id,
        streamId: "stream_eval",
        sequence: BigInt(i + 1),
        authorId: m.authorId,
        authorType: m.authorType,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: m.contentMarkdown,
        replyCount: 0,
        reactions: {},
        metadata: {},
        conversationIntent: null,
        revision: 1,
        clientMessageId: null,
        sentVia: null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date(now.getTime() - (m.minutesAgo ?? (withIds.length - i) * 2) * 60_000),
        ciphertext: null,
        envelope: null,
        e2eVersion: null,
      }) satisfies Message
  )
  return { messages, formatted }
}

async function runMemorizerTask(input: MemorizerInput, ctx: EvalContext): Promise<MemorizerOutput> {
  const memorizer = new Memorizer(ctx.ai, ctx.configResolver, new MessageFormatter())
  const now = new Date()
  const { messages, formatted } = toMessages(input, now)
  const conversationId = `conv_${ulid()}`
  const existingMemos = (input.existingMemos ?? []).map((m) => toMemo(m, conversationId))

  const context = {
    memoryContext: input.memoryContext ?? [],
    content: messages,
    existingMemos,
    workspaceId: ctx.workspaceId,
  }

  try {
    const memos =
      existingMemos.length > 0
        ? await memorizer.reviseMemo(formatted, context)
        : await memorizer.memorizeConversation(formatted, context)

    return {
      input,
      memos: memos.map((m) => ({
        title: m.title,
        abstract: m.abstract,
        knowledgeType: m.knowledgeType,
        keyPoints: m.keyPoints,
        tags: m.tags,
        supersedesMemoIds: m.supersedesMemoIds,
      })),
    }
  } catch (error) {
    return { input, memos: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export const memorizerSuite: EvalSuite<MemorizerInput, MemorizerOutput, MemorizerExpected> = {
  name: "memorizer",
  description: "Tests memo generation selectivity and revision discipline",

  cases: memorizerCases,

  task: runMemorizerTask,

  evaluators: [memoCountEvaluator, coverageEvaluator, exclusionEvaluator, conclusionEvaluator, supersessionEvaluator],

  runEvaluators: [accuracyEvaluator, overCaptureRateEvaluator],

  defaultPermutations: [
    {
      model: MEMO_MEMORIZER_MODEL_ID,
      temperature: MEMO_TEMPERATURES.memorization,
    },
  ],
}

export default memorizerSuite
