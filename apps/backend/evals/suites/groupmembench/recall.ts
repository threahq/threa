/**
 * GroupMemBench retrieval only: each question goes straight to the workspace
 * researcher from the asker's scratchpad, with no answering model and no judge,
 * and is scored on what the researcher brought back.
 *
 * The dataset names no evidence, so a question's gold is the seeded messages
 * containing its answer verbatim. Most answers are paraphrases that match
 * nothing, and short ones match too much; those questions count only towards
 * "answer in context". A hit is a gold message retrieved directly or as the
 * source of a retrieved memo, and a stream hit is any retrieval from the
 * channel or thread holding one.
 *
 *   bun run eval -- -s groupmembench-recall --from-db threa_gmb_capture_v4
 */

import type { CaseResult, EvalContext, EvalSuite, Evaluator, RunEvaluator } from "../../framework/types"
import { seedWorkspace, seededWorkspace, percentile, seconds } from "./suite"
import { QUESTION_TYPES, datasetDir, loadQuestions, type BenchQuestion } from "./dataset"
import { WorkspaceAgent, WORKSPACE_AGENT_MODEL_ID, WORKSPACE_AGENT_TEMPERATURE } from "../../../src/features/agents"
import { WORKSPACE_AGENT_TOTAL_BUDGET_MS } from "../../../src/features/agents/researcher/config"
import { EmbeddingService } from "../../../src/features/memos"
import { StreamRepository, StreamMemberRepository } from "../../../src/features/streams"
import { streamId as generateStreamId } from "../../../src/lib/id"
import { StreamTypes } from "@threahq/types"

/** Answers shorter than this, or found in more messages than `MAX_GOLD_MESSAGES`, name no evidence. */
const MIN_GOLD_ANSWER_CHARS = 4
const MAX_GOLD_MESSAGES = 10

interface RecallInput {
  question: BenchQuestion
}

interface RecallOutput {
  goldMessages: number
  messageHit: boolean
  streamHit: boolean
  answerInContext: boolean
  partial: boolean
  latencyMs: number
  retrievedMessages: number
  retrievedMemos: number
}

async function findGold(ctx: EvalContext, answer: string, streamIds: string[]) {
  if (answer.trim().length < MIN_GOLD_ANSWER_CHARS) return []
  const { rows } = await ctx.pool.query<{ id: string; stream_id: string }>(
    `SELECT id, stream_id FROM messages
     WHERE workspace_id = $1 AND stream_id = ANY($2::text[]) AND deleted_at IS NULL
       AND strpos(lower(content_markdown), lower($3)) > 0
     LIMIT $4`,
    [ctx.workspaceId, streamIds, answer.trim(), MAX_GOLD_MESSAGES + 1]
  )
  return rows.length > MAX_GOLD_MESSAGES ? [] : rows
}

async function runRecall({ question }: RecallInput, ctx: EvalContext): Promise<RecallOutput> {
  const state = seededWorkspace(ctx.workspaceId)
  const askerId = state.userIds.get(question.askingUser)
  if (!askerId) throw new Error(`${question.id}: no seeded user ${question.askingUser}`)

  const scratchpadId = generateStreamId()
  await StreamRepository.insert(ctx.pool, {
    id: scratchpadId,
    workspaceId: ctx.workspaceId,
    type: StreamTypes.SCRATCHPAD,
    visibility: "private",
    companionMode: "off",
    createdBy: askerId,
  })
  await StreamMemberRepository.insert(ctx.pool, ctx.workspaceId, scratchpadId, askerId)

  const gold = await findGold(ctx, question.answer, [...state.baselineStreamIds])
  const researcher = new WorkspaceAgent({
    pool: ctx.pool,
    ai: ctx.ai,
    configResolver: ctx.configResolver,
    embeddingService: new EmbeddingService({ ai: ctx.ai }),
  })
  const startedAt = Date.now()
  const result = await researcher.search({
    workspaceId: ctx.workspaceId,
    streamId: scratchpadId,
    query: question.question,
    conversationHistory: [],
    invokingUserId: askerId,
    searchFlag: "on",
    deadlineAt: startedAt + WORKSPACE_AGENT_TOTAL_BUDGET_MS,
  })
  const latencyMs = Date.now() - startedAt

  const retrievedIds = new Set([
    ...result.messages.map((m) => m.id),
    ...result.memos.flatMap((m) => m.memo.sourceMessageIds),
  ])
  const retrievedStreams = new Set([
    ...result.messages.map((m) => m.streamId),
    ...result.memos.flatMap((m) => (m.sourceStream ? [m.sourceStream.id] : [])),
  ])
  return {
    goldMessages: gold.length,
    messageHit: gold.some((g) => retrievedIds.has(g.id)),
    streamHit: gold.some((g) => retrievedStreams.has(g.stream_id)),
    answerInContext: (result.retrievedContext ?? "").toLowerCase().includes(question.answer.trim().toLowerCase()),
    partial: result.partial === true,
    latencyMs,
    retrievedMessages: result.messages.length,
    retrievedMemos: result.memos.length,
  }
}

const recallEvaluator: Evaluator<RecallOutput, BenchQuestion> = {
  name: "gold-retrieved",
  evaluate: (output) => {
    if (output.goldMessages === 0) {
      return { name: "gold-retrieved", score: 1, passed: true, details: "no verbatim gold" }
    }
    return {
      name: "gold-retrieved",
      score: output.messageHit ? 1 : 0,
      passed: output.messageHit,
      details: `message ${output.messageHit} · stream ${output.streamHit} · ${output.retrievedMessages} messages, ${output.retrievedMemos} memos`,
    }
  },
}

type Result = CaseResult<RecallOutput, BenchQuestion>

function rateLine(label: string, results: Result[], hit: (o: RecallOutput) => boolean): string {
  const pct =
    results.length === 0 ? "–" : `${Math.round((100 * results.filter((r) => hit(r.output)).length) / results.length)}%`
  return `${label}: ${results.filter((r) => hit(r.output)).length}/${results.length} (${pct})`
}

const summaryEvaluator: RunEvaluator<RecallOutput, BenchQuestion> = {
  name: "summary",
  evaluate: (results) => {
    const ran = results.filter((r) => r.output !== undefined)
    const withGold = ran.filter((r) => r.output.goldMessages > 0)
    const latency = ran.map((r) => r.output.latencyMs)
    const lines = [
      rateLine("gold message retrieved", withGold, (o) => o.messageHit),
      rateLine("gold stream retrieved", withGold, (o) => o.streamHit),
      rateLine("answer in context", ran, (o) => o.answerInContext),
      ...QUESTION_TYPES.map((type) =>
        rateLine(
          `${type} answer in context`,
          ran.filter((r) => r.expectedOutput.type === type),
          (o) => o.answerInContext
        )
      ),
      `partial ${ran.filter((r) => r.output.partial).length} · errored ${results.length - ran.length}`,
      `research p50 ${seconds(percentile(latency, 50))} p95 ${seconds(percentile(latency, 95))}`,
    ]
    return { name: "summary", score: 1, passed: true, details: lines.join("\n") }
  },
}

export const groupMemBenchRecallSuite: EvalSuite<RecallInput, RecallOutput, BenchQuestion> = {
  name: "groupmembench-recall",
  description: "GroupMemBench Technology, researcher only: gold evidence retrieved, answer in context, latency",
  get cases() {
    return loadQuestions(datasetDir()).map((question) => ({
      id: question.id,
      name: `${question.id} [${question.askingUser}]`,
      input: { question },
      expectedOutput: question,
    }))
  },
  setup: seedWorkspace("memory"),
  reusesDatabase: true,
  task: runRecall,
  evaluators: [recallEvaluator],
  runEvaluators: [summaryEvaluator],
  defaultPermutations: [{ model: WORKSPACE_AGENT_MODEL_ID, temperature: WORKSPACE_AGENT_TEMPERATURE }],
}
