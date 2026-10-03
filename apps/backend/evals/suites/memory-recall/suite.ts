/**
 * Memory Recall Evaluation Suite (memory plan, stage 1)
 *
 * Does preparing memory before Ariadne's first model call get her to a right
 * answer sooner than leaving retrieval to her `workspace_research` judgement?
 *
 * Setup seeds a synthetic workspace history (`scenarios.ts`) and captures it
 * through the production memo pipeline (`MemoService.processBatch`: real
 * classifier, memorizer and embeddings). Every question then runs once per
 * arm through the production `PersonaAgent.run`, same answer model:
 *
 *   A  prepared recall off — the agent decides whether to research
 *   B  prepared recall on  — the shipped Jev-scored memo recall
 *
 *   bun run eval -- -s memory-recall
 *   bun run eval -- -s memory-recall -c offsite-reversed-b
 */

import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import type { EvalContext, EvalSuite, Evaluator, RunEvaluator, CaseResult } from "../../framework/types"
import { createAdditionalUser } from "../../fixtures/workspace"
import { EVAL_JUDGE_MODEL } from "../../framework/judge-config"
import { runCompanionTask } from "../companion/suite"
import type { CompanionInput } from "../companion/cases"
import { scenarios, questions, type Question, type Scenario } from "./scenarios"
import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "../../../src/features/agents"
import {
  DecisionsMemoClassifier,
  EmbeddingService,
  MemoClassifier,
  MemoRepository,
  MemoService,
  Memorizer,
  ResidencyRoutedMemoClassifier,
} from "../../../src/features/memos"
import { queueMemoConversations } from "../../../src/features/memos/accumulator-outbox-handler"
import { ConversationRepository } from "../../../src/features/conversations"
import { EventService } from "../../../src/features/messaging"
import { StreamRepository, StreamMemberRepository } from "../../../src/features/streams"
import { UserRepository } from "../../../src/features/workspaces"
import { WorkspaceAIResidencyPolicy } from "../../../src/features/ai-usage"
import { MessageFormatter } from "../../../src/lib/ai/message-formatter"
import { conversationId as generateConversationId, streamId as generateStreamId } from "../../../src/lib/id"
import { withTransaction } from "../../../src/db"
import { DecisionsAvailability } from "@threahq/agent-runtime"
import { parseMarkdown } from "@threahq/prosemirror"
import { AgentStepTypes, AuthorTypes, ConversationStatuses, StreamTypes } from "@threahq/types"
import { ulid } from "ulid"
import { z } from "zod"

type Arm = "A" | "B"

export interface MemoryRecallInput {
  question: Question
  arm: Arm
}

export type MemoryRecallExpected = Question

export interface MemoryRecallOutput {
  arm: Arm
  reply: string
  error?: string
  firstReplyMs?: number
  /** `workspace_search` / `research` steps: a retrieval round the agent chose to run. */
  retrievalSteps: number
  recalledMemoIds: string[]
  /** Scenario each recalled memo was captured from (`unknown` when it traces to none). */
  recalledScenarios: string[]
  /** Scenarios the turn's research sources (memos or streams) trace to. */
  researchedScenarios: string[]
  /** Whether capture produced any memo from the question's relevant scenarios. */
  relevantCaptured: boolean
  /** Generation spend only: embeddings are not tracked. */
  costUsd: number
  inputTokens: number
}

interface SeededWorkspace {
  /** Streams that exist after setup; each case's own stream is hidden from later cases. */
  baselineStreamIds: Set<string>
  scenarioByConversation: Map<string, string>
  scenarioByStream: Map<string, string>
  memoCountByScenario: Map<string, number>
}

const seeded = new Map<string, SeededWorkspace>()

const RETRIEVAL_STEP_TYPES = new Set<string>([AgentStepTypes.WORKSPACE_SEARCH, AgentStepTypes.RESEARCH])
const DAY_MS = 24 * 60 * 60 * 1000

const SCENARIO_STREAM_TYPE = {
  scratchpad: StreamTypes.SCRATCHPAD,
  "public-channel": StreamTypes.CHANNEL,
  "private-channel": StreamTypes.CHANNEL,
  dm: StreamTypes.DM,
} as const satisfies Record<Scenario["kind"], string>

async function insertScenarioStream(
  ctx: EvalContext,
  scenario: Scenario,
  bobId: string
): Promise<{ streamId: string; memberIds: string[] }> {
  const id = generateStreamId()
  const isChannel = scenario.kind === "public-channel" || scenario.kind === "private-channel"
  const type = SCENARIO_STREAM_TYPE[scenario.kind]
  await StreamRepository.insert(ctx.pool, {
    id,
    workspaceId: ctx.workspaceId,
    type,
    displayName: scenario.name,
    slug: isChannel ? `${scenario.name}-${ulid().toLowerCase().slice(0, 6)}` : undefined,
    visibility: scenario.kind === "public-channel" ? "public" : "private",
    companionMode: "off",
    createdBy: ctx.userId,
  })
  const memberIds = scenario.kind === "scratchpad" ? [ctx.userId] : [ctx.userId, bobId]
  for (const memberId of memberIds) {
    await StreamMemberRepository.insert(ctx.pool, id, memberId)
  }
  return { streamId: id, memberIds }
}

/**
 * Seeds every scenario and captures its conversations oldest first, one batch
 * each, so a later conversation is memorized against the memos an earlier one
 * left — the order production sees them in.
 */
async function seedAndCapture(ctx: EvalContext): Promise<void> {
  const { pool, workspaceId } = ctx
  await UserRepository.update(pool, workspaceId, ctx.userId, { name: "Alice Berg" })
  const { userId: bobId } = await createAdditionalUser(pool, workspaceId, { name: "Bob Lind" })
  const authorIds = { alice: ctx.userId, bob: bobId }

  const messageFormatter = new MessageFormatter()
  const memoService = new MemoService({
    pool,
    analyticsReporter: new DisabledAnalyticsReporter(),
    classifier: new ResidencyRoutedMemoClassifier({
      residency: new WorkspaceAIResidencyPolicy({ pool }),
      decisions: new DecisionsMemoClassifier(ctx.ai),
      inference: new MemoClassifier(ctx.ai, ctx.configResolver, messageFormatter),
      availability: new DecisionsAvailability(),
    }),
    memorizer: new Memorizer(ctx.ai, ctx.configResolver, messageFormatter),
    embeddingService: new EmbeddingService({ ai: ctx.ai }),
    messageFormatter,
  })
  const eventService = new EventService(pool)

  const streamByScenario = new Map<string, string>()
  for (const scenario of scenarios) {
    const { streamId } = await insertScenarioStream(ctx, scenario, bobId)
    streamByScenario.set(scenario.key, streamId)
  }

  const scenarioByConversation = new Map<string, string>()
  const memoCountByScenario = new Map<string, number>(scenarios.map((s) => [s.key, 0]))
  const chronological = scenarios
    .flatMap((scenario) => scenario.conversations.map((conversation) => ({ scenario, conversation })))
    .sort((a, b) => b.conversation.daysAgo - a.conversation.daysAgo)

  for (const { scenario, conversation } of chronological) {
    const streamId = streamByScenario.get(scenario.key)!
    const startedAt = Date.now() - conversation.daysAgo * DAY_MS
    const messageIds: string[] = []
    for (const [index, message] of conversation.messages.entries()) {
      const created = await eventService.createMessage({
        workspaceId,
        streamId,
        authorId: authorIds[message.author],
        authorType: AuthorTypes.USER,
        contentJson: parseMarkdown(message.content),
        contentMarkdown: message.content,
      })
      await pool.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [
        new Date(startedAt + index * 60_000),
        created.id,
      ])
      messageIds.push(created.id)
    }

    const id = generateConversationId()
    const participantIds = [...new Set(conversation.messages.map((m) => authorIds[m.author]))]
    await ConversationRepository.insert(pool, { id, streamId, workspaceId, status: ConversationStatuses.RESOLVED })
    await ConversationRepository.addPrimaryMessages(pool, workspaceId, id, messageIds, participantIds)
    await withTransaction(pool, (client) => queueMemoConversations(client, workspaceId, streamId, [id]))
    await memoService.processBatch(workspaceId, streamId)

    scenarioByConversation.set(id, scenario.key)
    const memos = await MemoRepository.findActiveBySourceConversation(pool, id)
    memoCountByScenario.set(scenario.key, memoCountByScenario.get(scenario.key)! + memos.length)
  }

  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM streams WHERE workspace_id = $1`, [workspaceId])
  seeded.set(workspaceId, {
    baselineStreamIds: new Set(rows.map((row) => row.id)),
    scenarioByConversation,
    scenarioByStream: new Map([...streamByScenario].map(([key, id]) => [id, key])),
    memoCountByScenario,
  })
  console.log(
    `\n  Captured memos per scenario: ${[...memoCountByScenario].map(([key, count]) => `${key}=${count}`).join(", ")}\n`
  )
}

const ASK_IN_STREAM_TYPE: Record<Question["askIn"], CompanionInput["streamType"]> = {
  scratchpad: "scratchpad",
  channel: "channel",
  dm: "dm",
}

async function runMemoryRecallTask(input: MemoryRecallInput, ctx: EvalContext): Promise<MemoryRecallOutput> {
  const state = seeded.get(ctx.workspaceId)
  if (!state) throw new Error("memory-recall setup did not run for this workspace")
  const { question, arm } = input

  const usageBefore = ctx.usage.getTotal()
  const output = await runCompanionTask(
    {
      message: question.message,
      streamType: ASK_IN_STREAM_TYPE[question.askIn],
      trigger: "companion",
      preparedRecall: arm === "B" ? "on" : "off",
    },
    ctx,
    // Every question is answerable from the workspace alone, and both arms get the same tools.
    { requireWebSearch: false }
  )
  const usageAfter = ctx.usage.getTotal()

  // A case's question and reply must not become history a later case can search.
  await ctx.pool.query(
    `DELETE FROM stream_members sm USING streams s
     WHERE s.id = sm.stream_id AND s.workspace_id = $1 AND NOT (s.id = ANY($2::text[]))`,
    [ctx.workspaceId, [...state.baselineStreamIds]]
  )

  const recalledMemoIds = output.recalledMemoIds ?? []
  const sources = output.trajectory ?? []
  const researchedMemoIds = sources.flatMap((step) => step.sourceMemoIds)
  const memos = await MemoRepository.findByIdsInWorkspace(ctx.pool, ctx.workspaceId, [
    ...recalledMemoIds,
    ...researchedMemoIds,
  ])
  const memoScenario = (id: string) => {
    const conversationId = memos.get(id)?.sourceConversationId
    return (conversationId && state.scenarioByConversation.get(conversationId)) || "unknown"
  }
  const researchedScenarios = [
    ...new Set([
      ...researchedMemoIds.map(memoScenario),
      ...sources.flatMap((step) => step.sourceStreamIds.flatMap((id) => state.scenarioByStream.get(id) ?? [])),
    ]),
  ]

  return {
    arm,
    reply: output.messages.map((m) => m.content).join("\n\n"),
    error: output.error,
    firstReplyMs: output.firstReplyMs,
    retrievalSteps: (output.trajectory ?? []).filter((step) => RETRIEVAL_STEP_TYPES.has(step.stepType)).length,
    recalledMemoIds,
    recalledScenarios: recalledMemoIds.map(memoScenario),
    researchedScenarios,
    relevantCaptured: question.relevant.some((key) => (state.memoCountByScenario.get(key) ?? 0) > 0),
    costUsd: usageAfter.totalCost - usageBefore.totalCost,
    inputTokens: usageAfter.inputTokens - usageBefore.inputTokens,
  }
}

// =============================================================================
// Case evaluators
// =============================================================================

/** Hard fail: content this audience may not read reached the reply or the prompt. */
const audienceEvaluator: Evaluator<MemoryRecallOutput, MemoryRecallExpected> = {
  name: "audience",
  evaluate: (output, expected) => {
    const reply = output.reply.toLowerCase()
    const leakedText = (expected.forbiddenText ?? []).filter((text) => reply.includes(text.toLowerCase()))
    const leakedScenarios = [...new Set([...output.recalledScenarios, ...output.researchedScenarios])].filter((key) =>
      expected.forbiddenScenarios?.includes(key)
    )
    const leaked = leakedText.length > 0 || leakedScenarios.length > 0
    return {
      name: "audience",
      score: leaked ? 0 : 1,
      passed: !leaked,
      details: leaked
        ? `HARD FAIL: reply text ${JSON.stringify(leakedText)}, recalled or researched from ${JSON.stringify(leakedScenarios)}`
        : "nothing out of audience",
    }
  },
}

const judgeSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
})

const JUDGE_ERROR = "judge error"

const correctnessEvaluator: Evaluator<MemoryRecallOutput, MemoryRecallExpected> = {
  name: "correct",
  evaluate: async (output, expected, ctx) => {
    if (!output.reply.trim()) {
      return { name: "correct", score: 0, passed: false, details: output.error ?? "no reply" }
    }
    try {
      const { value } = await ctx.ai.generateObject({
        model: ctx.judgeModel ?? EVAL_JUDGE_MODEL,
        schema: judgeSchema,
        messages: [
          {
            role: "system",
            content: `You grade whether an assistant's reply gets a workspace question right.

Score 1.0 when the reply states what the expected answer requires and contradicts none of it. Score 0.5 when it is partly right or hedges between the right answer and a wrong one. Score 0.0 when it is wrong, states something the expected answer rules out (an outdated decision, an invented fact), or misses the point. Extra correct detail, tone and length do not matter, and neither does a year or weekday the reply infers from today's date. A reply that asks a clarifying question instead of answering scores 0.0 unless the expected answer says not knowing is correct.`,
          },
          {
            role: "user",
            content: `Today: ${new Date().toISOString().slice(0, 10)}\n\nQuestion: ${expected.message}\n\nExpected answer: ${expected.expected}\n\nReply:\n${output.reply}`,
          },
        ],
        temperature: 0,
        telemetry: { functionId: "eval-memory-recall-correct" },
      })
      return { name: "correct", score: value.score, passed: value.score >= 0.7, details: value.reasoning }
    } catch (error) {
      return {
        name: "correct",
        score: 0,
        passed: false,
        details: `${JUDGE_ERROR}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}

// =============================================================================
// Run evaluators — one line per arm, side by side
// =============================================================================

type Result = CaseResult<MemoryRecallOutput, MemoryRecallExpected>

const passed = (result: Result, name: string) => result.evaluations.find((e) => e.name === name)?.passed === true

/** A turn that errored, or whose judge did, says nothing about whether the arm answers right. */
const errored = (result: Result) =>
  result.output.error !== undefined ||
  result.evaluations.some((e) => e.name === "correct" && e.details?.startsWith(JUDGE_ERROR))

/** Errored cases carry no output; they count against neither arm's numbers. */
function byArm(results: Result[]): Record<Arm, Result[]> {
  const ran = results.filter((r) => r.output !== undefined)
  return {
    A: ran.filter((r) => r.output.arm === "A"),
    B: ran.filter((r) => r.output.arm === "B"),
  }
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const seconds = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)}s`)
const share = (count: number, total: number) => `${count}/${total}`

interface ArmStats {
  turns: number
  errors: number
  correct: number
  correctWithoutRetrieval: number
  retrievalTurns: number
  supportedP50?: number
  supportedP95?: number
  irrelevantInjectedTurns: number
  injectedMemos: number
  irrelevantMemos: number
  audienceFails: number
  costUsd: number
}

function armStats(results: Result[]): ArmStats {
  const correct = results.filter((r) => !errored(r) && passed(r, "correct"))
  const supportedMs = correct.flatMap((r) => (r.output.firstReplyMs === undefined ? [] : [r.output.firstReplyMs]))
  const irrelevant = (r: Result) => r.output.recalledScenarios.filter((key) => !r.expectedOutput.relevant.includes(key))
  return {
    turns: results.length,
    errors: results.filter(errored).length,
    correct: correct.length,
    correctWithoutRetrieval: correct.filter((r) => r.output.retrievalSteps === 0).length,
    retrievalTurns: results.filter((r) => r.output.retrievalSteps > 0).length,
    supportedP50: percentile(supportedMs, 50),
    supportedP95: percentile(supportedMs, 95),
    irrelevantInjectedTurns: results.filter((r) => irrelevant(r).length > 0).length,
    injectedMemos: results.reduce((sum, r) => sum + r.output.recalledMemoIds.length, 0),
    irrelevantMemos: results.reduce((sum, r) => sum + irrelevant(r).length, 0),
    audienceFails: results.filter((r) => !passed(r, "audience")).length,
    costUsd: results.reduce((sum, r) => sum + r.output.costUsd, 0),
  }
}

function armLine(arm: Arm, s: ArmStats): string {
  return [
    `${arm}: correct ${share(s.correct, s.turns - s.errors)}`,
    `errored ${s.errors}`,
    `correct without a retrieval round ${share(s.correctWithoutRetrieval, s.turns)}`,
    `first supported answer p50 ${seconds(s.supportedP50)} p95 ${seconds(s.supportedP95)}`,
    `turns that researched ${share(s.retrievalTurns, s.turns)}`,
    `memos injected ${s.injectedMemos} (irrelevant ${s.irrelevantMemos}, in ${s.irrelevantInjectedTurns} turns)`,
    `audience fails ${s.audienceFails}`,
    `generation cost $${s.costUsd.toFixed(3)}`,
  ].join(" · ")
}

/**
 * The stage 2 gate: B reaches a supported answer sooner than A, is no less
 * often right, and leaks nothing out of audience. Any errored turn leaves it
 * inconclusive: an arm that did not answer cannot show it is right or leak-free.
 */
const stageGateEvaluator: RunEvaluator<MemoryRecallOutput, MemoryRecallExpected> = {
  name: "stage-2-gate",
  evaluate: (results) => {
    const arms = byArm(results)
    const a = armStats(arms.A)
    const b = armStats(arms.B)
    const faster = b.supportedP50 !== undefined && a.supportedP50 !== undefined && b.supportedP50 < a.supportedP50
    const noLessRight = b.correct >= a.correct
    const noLeak = a.audienceFails === 0 && b.audienceFails === 0
    const conclusive = a.errors === 0 && b.errors === 0
    const open = conclusive && faster && noLessRight && noLeak
    return {
      name: "stage-2-gate",
      score: open ? 1 : 0,
      passed: open,
      details: `${armLine("A", a)}\n${armLine("B", b)}\ngate: conclusive=${conclusive} faster=${faster} noLessRight=${noLessRight} noLeak=${noLeak}`,
    }
  },
}

/**
 * Flags capture misses apart from recall misses. Coarse: a scenario counts as
 * captured when any memo came from it, not when the memo holds this answer.
 */
const byKindEvaluator: RunEvaluator<MemoryRecallOutput, MemoryRecallExpected> = {
  name: "by-question-kind",
  evaluate: (results) => {
    const kinds = [...new Set(results.map((r) => r.expectedOutput.kind))]
    const lines = kinds.map((kind) => {
      const arms = byArm(results.filter((r) => r.expectedOutput.kind === kind))
      return `${kind}: A ${share(arms.A.filter((r) => passed(r, "correct")).length, arms.A.length)} · B ${share(arms.B.filter((r) => passed(r, "correct")).length, arms.B.length)}`
    })
    const answerable = results.filter((r) => r.output !== undefined && r.expectedOutput.relevant.length > 0)
    const uncaptured = [
      ...new Set(answerable.filter((r) => !r.output.relevantCaptured).map((r) => r.expectedOutput.id)),
    ]
    lines.push(`no memo captured from a relevant scenario: ${uncaptured.length > 0 ? uncaptured.join(", ") : "none"}`)
    return { name: "by-question-kind", score: 1, passed: true, details: lines.join("\n") }
  },
}

export const memoryRecallSuite: EvalSuite<MemoryRecallInput, MemoryRecallOutput, MemoryRecallExpected> = {
  name: "memory-recall",
  description: "Prepared recall (B) vs agent-chosen research (A) over memos captured by the production pipeline",
  cases: questions.flatMap((question) =>
    (["A", "B"] as const).map((arm) => ({
      id: `${question.id}-${arm.toLowerCase()}`,
      name: `${question.id} [${arm}]`,
      input: { question, arm },
      expectedOutput: question,
    }))
  ),
  setup: seedAndCapture,
  task: runMemoryRecallTask,
  evaluators: [audienceEvaluator, correctnessEvaluator],
  runEvaluators: [stageGateEvaluator, byKindEvaluator],
  defaultPermutations: [{ model: COMPANION_MODEL_ID, temperature: COMPANION_TEMPERATURE }],
}

export default memoryRecallSuite
