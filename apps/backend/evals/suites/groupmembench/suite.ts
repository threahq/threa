/**
 * GroupMemBench, Technology domain: 30k messages from 18 people across seven
 * channels, asked 213 questions in six types (`dataset.ts`).
 *
 * Setup replays each channel through the production pipeline on a simulated
 * clock (`fixtures/replay.ts`): boundary extraction, memo capture and
 * embeddings run as they would have live, up to the moment the questions are
 * asked. The channels replay in parallel, each in its own database on its own
 * clock, and are copied into the run's database as they finish. Each top-level
 * post with replies gets a thread, nested replies flattened into it and titled
 * with the post's phase, since the questions name phases the message text
 * mostly does not. Every question is then asked by its own user in a fresh
 * scratchpad, through the production `PersonaAgent.run`, as of the day after
 * the data ends:
 *
 *   groupmembench            memory on, prepared recall on, every tool
 *   groupmembench-no-memory  channels' memory off: message search only
 *
 * Graded with GroupMemBench's own judge prompt, correct or not.
 *
 *   bun run eval -- -s groupmembench
 *   GROUPMEMBENCH_CHANNELS=MonitoringAgent bun run eval -- -s groupmembench -c temporal_1
 *
 * `GROUPMEMBENCH_CHANNELS` (comma-separated) seeds only those channels, for a
 * smoke run; questions about the others then have nothing to find.
 *
 * The replay takes hours. `--keep-db` keeps a run's database, and `--from-db <name>`
 * clones it into later runs, which then measure recall over the same memos.
 */

import type { CaseResult, EvalContext, EvalSuite, Evaluator, RunEvaluator } from "../../framework/types"
import { EVAL_JUDGE_MODEL } from "../../framework/judge-config"
import { startReplayPipeline, type ReplayMessage, type ReplayResult } from "../../fixtures/replay"
import { copyDatabaseRows, setupEvalDatabase, type EvalDatabaseResult } from "../../framework/database"
import { runCompanionTask } from "../companion/suite"
import type { CompanionTrajectoryStep } from "../companion/types"
import {
  QUESTION_TYPES,
  datasetDir,
  loadChannels,
  loadQuestions,
  type BenchChannel,
  type BenchMessage,
  type BenchQuestion,
} from "./dataset"
import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "../../../src/features/agents"
import { MEMO_MAX_FAILED_ATTEMPTS } from "../../../src/features/memos/config"
import { StreamService } from "../../../src/features/streams"
import { UserRepository } from "../../../src/features/workspaces"
import { userId as generateUserId } from "../../../src/lib/id"
import { AgentStepTypes, MemoryModes, StreamTypes } from "@threahq/types"
import type { Pool } from "pg"
import { z } from "zod"

type Variant = "memory" | "no-memory"

export interface GroupMemBenchInput {
  question: BenchQuestion
}

export type GroupMemBenchExpected = BenchQuestion

/** Which source answered: memos prepared before the first model call, the agent's own retrieval, or neither. */
type Tier = "prepared" | "research" | "none"

export interface GroupMemBenchOutput {
  reply: string
  error?: string
  firstReplyMs?: number
  tier: Tier
  retrievalSteps: number
  recalledMemos: number
  /** Generation spend only: embeddings are not tracked. */
  costUsd: number
  trajectory: CompanionTrajectoryStep[]
}

/** The data ends on 2025-07-28; temporal answers are absolute dates in that range. */
const ASKED_AT = "2025-07-29T09:00:00Z"
const RETRIEVAL_STEP_TYPES = new Set<string>([AgentStepTypes.WORKSPACE_SEARCH, AgentStepTypes.RESEARCH])

interface SeededWorkspace {
  userIds: Map<string, string>
  /** Streams that exist after setup; each case's scratchpad is hidden from later cases. */
  baselineStreamIds: Set<string>
}

const seeded = new Map<string, SeededWorkspace>()

export function seededWorkspace(workspaceId: string): SeededWorkspace {
  const state = seeded.get(workspaceId)
  if (!state) throw new Error("groupmembench setup did not run for this workspace")
  return state
}

function selectedChannels(): BenchChannel[] {
  const channels = loadChannels(datasetDir())
  const only = process.env.GROUPMEMBENCH_CHANNELS?.split(",").map((name) => name.trim())
  if (!only) return channels
  const unknown = only.filter((name) => !channels.some((c) => c.name === name))
  if (unknown.length > 0) {
    throw new Error(`GROUPMEMBENCH_CHANNELS names unknown channels ${unknown.join(", ")}`)
  }
  return channels.filter((c) => only.includes(c.name))
}

async function insertUsers(ctx: EvalContext, names: string[]): Promise<Map<string, string>> {
  const userIds = new Map<string, string>()
  for (const name of names) {
    const id = generateUserId()
    const handle = name.toLowerCase().replace(/_/g, "-")
    await UserRepository.insert(ctx.pool, {
      id,
      workspaceId: ctx.workspaceId,
      workosUserId: `workos_gmb_${handle}_${ctx.workspaceId}`,
      email: `${handle}@groupmembench.test`,
      role: "member",
      slug: handle,
      name,
    })
    userIds.set(name, id)
  }
  return userIds
}

/** The clock starts just before the first post, so the channels exist before anything is said in them. */
export function replayStart(channels = selectedChannels()): Date {
  const first = channels
    .flatMap((channel) => channel.posts)
    .reduce((min, post) => Math.min(min, post.createdAt.getTime()), Infinity)
  return new Date(first - 60_000)
}

function requireClock(ctx: EvalContext) {
  if (!ctx.clock) throw new Error("groupmembench runs on a simulated clock")
  return ctx.clock
}

/**
 * Creates a channel as its first author would, and returns its history as
 * replay input: posts in the channel, replies in a thread under their root post.
 */
async function seedChannel(
  ctx: EvalContext,
  streamService: StreamService,
  channel: BenchChannel,
  userIds: Map<string, string>,
  variant: Variant
): Promise<ReplayMessage[]> {
  const { workspaceId } = ctx
  const createdBy = userIds.get(channel.authors[0]!)!
  const stream = await streamService.create({
    workspaceId,
    type: StreamTypes.CHANNEL,
    slug: channel.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
    visibility: "public",
    createdBy,
    memberIds: channel.authors.map((author) => userIds.get(author)!),
  })
  if (variant === "no-memory") {
    await streamService.updateStream(
      stream.id,
      { memoryMode: MemoryModes.OFF },
      { workspaceId, principal: { kind: "user", userId: createdBy } }
    )
  }

  const key = (message: BenchMessage) => `${channel.name}/${message.node}`
  const base = (message: BenchMessage) => ({
    key: key(message),
    authorId: userIds.get(message.author)!,
    content: message.content,
    createdAt: message.createdAt,
  })
  return [
    ...channel.posts.map((post) => ({ ...base(post), streamId: stream.id })),
    ...channel.threads.flatMap((thread) =>
      thread.replies.map((reply) => ({ ...base(reply), threadOf: key(thread.root), threadName: thread.root.phase }))
    ),
  ]
}

/** A kept database already holds the replayed channels and their memos; only the lookup state is rebuilt. */
async function reuseWorkspace(ctx: EvalContext): Promise<void> {
  const users = await ctx.pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE workspace_id = $1 AND email LIKE '%@groupmembench.test'`,
    [ctx.workspaceId]
  )
  const streams = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM streams WHERE workspace_id = $1 AND type = ANY($2::text[])`,
    [ctx.workspaceId, [StreamTypes.CHANNEL, StreamTypes.THREAD]]
  )
  const memos = await ctx.pool.query<{ count: string }>(
    `SELECT count(*) FROM memos WHERE workspace_id = $1 AND status = 'active'`,
    [ctx.workspaceId]
  )
  if (users.rows.length === 0 || streams.rows.length === 0) {
    throw new Error(`${ctx.reusedDatabase} holds no seeded GroupMemBench workspace`)
  }
  seeded.set(ctx.workspaceId, {
    userIds: new Map(users.rows.map((row) => [row.name, row.id])),
    baselineStreamIds: new Set(streams.rows.map((row) => row.id)),
  })
  // The kept run's scratchpads lost their members case by case, except one still open when it was kept.
  await ctx.pool.query(
    `DELETE FROM stream_members sm USING streams s
     WHERE s.id = sm.stream_id AND s.workspace_id = $1 AND NOT (s.id = ANY($2::text[]))`,
    [ctx.workspaceId, streams.rows.map((row) => row.id)]
  )
  await requireClock(ctx).set(new Date(ASKED_AT))
  console.log(
    `\n  Reusing ${ctx.reusedDatabase}: ${streams.rows.length} channels and threads, ${memos.rows[0]!.count} active memos\n`
  )
}

/** Replays one channel in a database of its own, on its own clock, and returns what the pipeline left behind. */
async function replayChannel(
  ctx: EvalContext & { connectionString: string },
  runStart: Date,
  channel: BenchChannel,
  userIds: Map<string, string>,
  variant: Variant
): Promise<{ db: EvalDatabaseResult; messageCount: number; result: ReplayResult }> {
  // Migrations stamp their seed rows with the clock, so every database starts on the run's.
  const db = await setupEvalDatabase({ label: `gmb_${channel.name}`, simClock: runStart })
  try {
    await copyDatabaseRows(db.pool, ctx.connectionString)
    const clock = requireClock({ ...ctx, clock: db.clock })
    await clock.set(replayStart([channel]))
    const pipeline = await startReplayPipeline({
      pool: db.pool,
      connectionString: db.connectionString,
      clock,
      ai: ctx.ai,
      workspaceId: ctx.workspaceId,
    })
    try {
      const messages = await seedChannel(ctx, new StreamService(db.pool), channel, userIds, variant)
      messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      return { db, messageCount: messages.length, result: await pipeline.replay(messages, new Date(ASKED_AT)) }
    } finally {
      await pipeline.stop()
    }
  } catch (error) {
    await db.cleanup()
    throw error
  }
}

async function captureCounts(pool: Pool, workspaceId: string) {
  const { rows } = await pool.query<{ conversations: string; memos: string; abandoned: string }>(
    `SELECT
       (SELECT count(*) FROM conversations WHERE workspace_id = $1) AS conversations,
       (SELECT count(*) FROM memos WHERE workspace_id = $1 AND status = 'active') AS memos,
       (SELECT count(*) FROM memo_pending_items WHERE workspace_id = $1 AND failed_attempts >= $2) AS abandoned`,
    [workspaceId, MEMO_MAX_FAILED_ATTEMPTS]
  )
  return rows[0]!
}

/**
 * Channels share no conversations, so each replays in parallel in a clone of
 * the seeded users, and its rows are copied back once its replay finishes.
 * Memo capture reads its own stream, except the tag vocabulary: production
 * offers tags from every public channel, here only the channel's own.
 */
export function seedWorkspace(variant: Variant) {
  return async (ctx: EvalContext): Promise<void> => {
    if (ctx.reusedDatabase) return reuseWorkspace(ctx)
    const startedAt = Date.now()
    const channels = selectedChannels()
    const askers = loadQuestions(datasetDir()).map((q) => q.askingUser)
    const names = [...new Set([...channels.flatMap((c) => c.authors), ...askers])].sort()
    const userIds = await insertUsers(ctx, names)
    const { connectionString } = ctx
    if (!connectionString) throw new Error("groupmembench replays against a database")
    const runStart = replayStart()

    let merging = Promise.resolve()
    const replays = await Promise.allSettled(
      channels.map(async (channel) => {
        const { db, messageCount, result } = await replayChannel(
          { ...ctx, connectionString },
          runStart,
          channel,
          userIds,
          variant
        )
        try {
          const counts = await captureCounts(db.pool, ctx.workspaceId)
          console.log(
            `  ${channel.name}: ${messageCount} messages into ${counts.conversations} conversations and ${counts.memos} memos (${seconds(Date.now() - startedAt)}); ${result.unprocessedMemoItems} memo items pending, ${counts.abandoned} abandoned, ${result.deadLetteredJobs} jobs and ${result.deadLetteredEvents} outbox events dead-lettered`
          )
          // One copy at a time, so rows two channels share are compared against what the first copied.
          const copy = merging.then(() => copyDatabaseRows(ctx.pool, db.connectionString))
          merging = copy.then(
            () => undefined,
            () => undefined
          )
          await copy
          return messageCount
        } finally {
          await db.cleanup()
        }
      })
    )
    const failed = replays.flatMap((replay) => (replay.status === "rejected" ? [replay.reason] : []))
    if (failed.length > 0)
      throw new AggregateError(failed, `${failed.length} of ${channels.length} channel replays failed`)
    await requireClock(ctx).set(new Date(ASKED_AT))

    const messageCount = replays.reduce((sum, replay) => sum + (replay.status === "fulfilled" ? replay.value : 0), 0)
    const counts = await captureCounts(ctx.pool, ctx.workspaceId)
    console.log(
      `\n  Replayed ${messageCount} messages in ${channels.length} channels into ${counts.conversations} conversations and ${counts.memos} memos (${seconds(Date.now() - startedAt)}, $${ctx.usage.getTotal().totalCost.toFixed(2)} generation)\n`
    )

    const streams = await ctx.pool.query<{ id: string }>(`SELECT id FROM streams WHERE workspace_id = $1`, [
      ctx.workspaceId,
    ])
    seeded.set(ctx.workspaceId, { userIds, baselineStreamIds: new Set(streams.rows.map((row) => row.id)) })
  }
}

function tierOf(retrievalSteps: number, recalledMemos: number): Tier {
  if (retrievalSteps > 0) return "research"
  return recalledMemos > 0 ? "prepared" : "none"
}

function runQuestion(variant: Variant) {
  return async ({ question }: GroupMemBenchInput, ctx: EvalContext): Promise<GroupMemBenchOutput> => {
    const state = seededWorkspace(ctx.workspaceId)
    const askerId = state.userIds.get(question.askingUser)
    if (!askerId) throw new Error(`${question.id}: no seeded user ${question.askingUser}`)

    const usageBefore = ctx.usage.getTotal().totalCost
    const output = await runCompanionTask(
      {
        message: question.question,
        streamType: "scratchpad",
        trigger: "companion",
        currentTime: ASKED_AT,
        preparedRecall: variant === "memory" ? "on" : "off",
      },
      { ...ctx, userId: askerId },
      { requireWebSearch: false }
    )
    const costUsd = ctx.usage.getTotal().totalCost - usageBefore

    // A case's question and reply must not become history a later case can search.
    await ctx.pool.query(
      `DELETE FROM stream_members sm USING streams s
       WHERE s.id = sm.stream_id AND s.workspace_id = $1 AND NOT (s.id = ANY($2::text[]))`,
      [ctx.workspaceId, [...state.baselineStreamIds]]
    )

    const retrievalSteps = (output.trajectory ?? []).filter((step) => RETRIEVAL_STEP_TYPES.has(step.stepType)).length
    const recalledMemos = output.recalledMemoIds?.length ?? 0
    return {
      reply: output.messages.map((m) => m.content).join("\n\n"),
      error: output.error,
      firstReplyMs: output.firstReplyMs,
      tier: tierOf(retrievalSteps, recalledMemos),
      retrievalSteps,
      recalledMemos,
      costUsd,
      trajectory: output.trajectory ?? [],
    }
  }
}

// =============================================================================
// Judge: GroupMemBench's `prompts/hipporag_judge_system.txt`, as structured output
// =============================================================================

const judgeSchema = z.object({ reasoning: z.string(), correct: z.boolean() })

const JUDGE_ERROR = "judge error"

const correctnessEvaluator: Evaluator<GroupMemBenchOutput, GroupMemBenchExpected> = {
  name: "correct",
  evaluate: async (output, expected, ctx) => {
    if (!output.reply.trim()) {
      return { name: "correct", score: 0, passed: false, details: output.error ?? "no reply" }
    }
    try {
      const { value } = await ctx.ai.generateObject({
        context: { workspaceId: ctx.workspaceId, userId: ctx.userId },
        model: ctx.judgeModel ?? EVAL_JUDGE_MODEL,
        schema: judgeSchema,
        messages: [
          {
            role: "system",
            content:
              "You are a strict judge evaluating whether an agent's answer matches the gold answer for a question.\nConsider paraphrases correct if they have the same meaning as the gold answer.\nFirst provide a brief reasoning paragraph, then the final judgment.",
          },
          {
            role: "user",
            content: `Question: ${expected.question}\n\nGold answer: ${expected.answer}\n\nAgent answer:\n${output.reply}`,
          },
        ],
        temperature: 0,
        telemetry: { functionId: "eval-groupmembench-correct" },
      })
      return { name: "correct", score: value.correct ? 1 : 0, passed: value.correct, details: value.reasoning }
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
// Run evaluator: accuracy by question type and by answering tier
// =============================================================================

type Result = CaseResult<GroupMemBenchOutput, GroupMemBenchExpected>

const isCorrect = (r: Result) => r.evaluations.find((e) => e.name === "correct")?.passed === true

/** A turn that errored, or whose judge did: scored wrong, and counted on its own so a flaky run shows. */
const errored = (r: Result) =>
  r.output === undefined ||
  r.output.error !== undefined ||
  r.evaluations.some((e) => e.name === "correct" && e.details?.startsWith(JUDGE_ERROR))

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export const seconds = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)}s`)

/** Every question counts, as upstream scores it: an errored one is a wrong answer. */
function accuracyLine(label: string, results: Result[]): string {
  const correct = results.filter(isCorrect).length
  const pct = results.length === 0 ? "–" : `${Math.round((100 * correct) / results.length)}%`
  return `${label}: ${correct}/${results.length} (${pct})`
}

const summaryEvaluator: RunEvaluator<GroupMemBenchOutput, GroupMemBenchExpected> = {
  name: "summary",
  evaluate: (results) => {
    const ran = results.filter((r) => r.output !== undefined)
    const replyMs = ran.flatMap((r) => (r.output.firstReplyMs === undefined ? [] : [r.output.firstReplyMs]))
    const tiers: Tier[] = ["prepared", "research", "none"]
    const lines = [
      `${accuracyLine("overall", results)} · errored ${results.filter(errored).length}`,
      ...QUESTION_TYPES.map((type) =>
        accuracyLine(
          type,
          results.filter((r) => r.expectedOutput.type === type)
        )
      ),
      ...tiers.map((tier) =>
        accuracyLine(
          `answered from ${tier}`,
          ran.filter((r) => r.output.tier === tier)
        )
      ),
      `first reply p50 ${seconds(percentile(replyMs, 50))} p95 ${seconds(percentile(replyMs, 95))}`,
      `answer generation $${ran.reduce((sum, r) => sum + r.output.costUsd, 0).toFixed(2)}`,
    ]
    return { name: "summary", score: 1, passed: true, details: lines.join("\n") }
  },
}

function buildSuite(variant: Variant): EvalSuite<GroupMemBenchInput, GroupMemBenchOutput, GroupMemBenchExpected> {
  return {
    name: variant === "memory" ? "groupmembench" : "groupmembench-no-memory",
    description:
      variant === "memory"
        ? "GroupMemBench Technology over memos captured by the production pipeline, prepared recall on"
        : "GroupMemBench Technology with nothing captured: message search only",
    // Read on use: the dataset is a local download, and other suites must load without it.
    get cases() {
      return loadQuestions(datasetDir()).map((question) => ({
        id: question.id,
        name: `${question.id} [${question.askingUser}]`,
        input: { question },
        expectedOutput: question,
      }))
    },
    get simClock() {
      return replayStart()
    },
    setup: seedWorkspace(variant),
    reusesDatabase: variant === "memory",
    task: runQuestion(variant),
    evaluators: [correctnessEvaluator],
    runEvaluators: [summaryEvaluator],
    defaultPermutations: [{ model: COMPANION_MODEL_ID, temperature: COMPANION_TEMPERATURE }],
  }
}

export const groupMemBenchSuite = buildSuite("memory")
export const groupMemBenchNoMemorySuite = buildSuite("no-memory")
