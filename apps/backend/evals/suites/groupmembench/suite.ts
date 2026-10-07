/**
 * GroupMemBench, Technology domain: 30k messages from 18 people across seven
 * channels, asked 213 questions in six types (`dataset.ts`).
 *
 * Setup replays the channels as public Threa channels with the original
 * authors and timestamps. Each top-level post with replies gets a thread,
 * nested replies flattened into it and titled with the post's phase, since the
 * questions name phases the message text mostly does not. Every question is
 * then asked by its own user in a fresh scratchpad, through the production
 * `PersonaAgent.run`, as of the day after the data ends:
 *
 *   groupmembench            capture on, prepared recall on, every tool
 *   groupmembench-no-memory  nothing captured: message search only
 *
 * Graded with GroupMemBench's own judge prompt, correct or not.
 *
 *   bun run eval -- -s groupmembench
 *   GROUPMEMBENCH_CHANNELS=MonitoringAgent bun run eval -- -s groupmembench -c temporal_1
 *
 * `GROUPMEMBENCH_CHANNELS` (comma-separated) seeds only those channels, for a
 * smoke run; questions about the others then have nothing to find.
 *
 * Capture takes hours. `--keep-db` keeps a run's database, and `--from-db <name>`
 * clones it into later runs, which then measure recall over the same memos.
 */

import type { CaseResult, EvalContext, EvalSuite, Evaluator, RunEvaluator } from "../../framework/types"
import { EVAL_JUDGE_MODEL } from "../../framework/judge-config"
import { createCaptureMemoService, drainCapture, postMessages, recordConversation } from "../../fixtures/capture"
import { runCompanionTask } from "../companion/suite"
import {
  QUESTION_TYPES,
  datasetDir,
  loadChannels,
  loadQuestions,
  segmentConversations,
  type BenchChannel,
  type BenchMessage,
  type BenchQuestion,
} from "./dataset"
import { COMPANION_MODEL_ID, COMPANION_TEMPERATURE } from "../../../src/features/agents"
import { PROVISIONAL_ATTACH_WINDOW_MINUTES } from "../../../src/features/conversations"
import { MEMO_MAX_FAILED_ATTEMPTS } from "../../../src/features/memos/config"
import { StreamRepository, StreamMemberRepository } from "../../../src/features/streams"
import { UserRepository } from "../../../src/features/workspaces"
import { streamId as generateStreamId, userId as generateUserId } from "../../../src/lib/id"
import { AgentStepTypes, StreamTypes } from "@threahq/types"
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
}

/** The data ends on 2025-07-28; temporal answers are absolute dates in that range. */
const ASKED_AT = "2025-07-29T09:00:00Z"
const MAX_CONVERSATION_MESSAGES = 30
const RETRIEVAL_STEP_TYPES = new Set<string>([AgentStepTypes.WORKSPACE_SEARCH, AgentStepTypes.RESEARCH])

interface SeededWorkspace {
  userIds: Map<string, string>
  /** Streams that exist after setup; each case's scratchpad is hidden from later cases. */
  baselineStreamIds: Set<string>
}

const seeded = new Map<string, SeededWorkspace>()

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

/** A conversation to capture, on the stream that holds it. */
interface SeededConversation {
  streamId: string
  messageIds: string[]
  participantIds: string[]
  lastAt: Date
}

/**
 * Posts a channel's history, its threads under their root posts, and returns
 * its conversations oldest first: the order they would have resolved in.
 */
async function seedChannel(
  ctx: EvalContext,
  channel: BenchChannel,
  userIds: Map<string, string>
): Promise<{ channelId: string; messageCount: number; conversations: SeededConversation[] }> {
  const { pool, workspaceId } = ctx
  const authorId = (message: BenchMessage) => userIds.get(message.author)!
  const toSeed = (messages: BenchMessage[]) =>
    messages.map((m) => ({ authorId: authorId(m), content: m.content, createdAt: m.createdAt }))
  const conversations: SeededConversation[] = []
  const addConversations = (streamId: string, messages: BenchMessage[], ids: string[]) => {
    const idByNode = new Map(messages.map((m, i) => [m.node, ids[i]!]))
    for (const conversation of segmentConversations(
      messages,
      MAX_CONVERSATION_MESSAGES,
      PROVISIONAL_ATTACH_WINDOW_MINUTES * 60_000
    )) {
      conversations.push({
        streamId,
        messageIds: conversation.map((m) => idByNode.get(m.node)!),
        participantIds: [...new Set(conversation.map(authorId))],
        lastAt: conversation.at(-1)!.createdAt,
      })
    }
  }

  const channelId = generateStreamId()
  await StreamRepository.insert(pool, {
    id: channelId,
    workspaceId,
    type: StreamTypes.CHANNEL,
    displayName: channel.name,
    slug: channel.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
    visibility: "public",
    companionMode: "off",
    createdBy: userIds.get(channel.authors[0]!)!,
  })
  for (const author of channel.authors) {
    await StreamMemberRepository.insert(pool, workspaceId, channelId, userIds.get(author)!)
  }

  const postIds = await postMessages(ctx, channelId, toSeed(channel.posts))
  addConversations(channelId, channel.posts, postIds)
  const postIdByNode = new Map(channel.posts.map((post, i) => [post.node, postIds[i]!]))
  let messageCount = channel.posts.length

  for (const thread of channel.threads) {
    const threadId = generateStreamId()
    await StreamRepository.insert(pool, {
      id: threadId,
      workspaceId,
      type: StreamTypes.THREAD,
      displayName: thread.root.phase,
      visibility: "public",
      parentStreamId: channelId,
      parentAnchorId: postIdByNode.get(thread.root.node)!,
      rootStreamId: channelId,
      companionMode: "off",
      createdBy: authorId(thread.replies[0]!),
    })
    addConversations(threadId, thread.replies, await postMessages(ctx, threadId, toSeed(thread.replies)))
    messageCount += thread.replies.length
  }
  conversations.sort((a, b) => a.lastAt.getTime() - b.lastAt.getTime())
  return { channelId, messageCount, conversations }
}

/** A kept database already holds the seeded channels and captured memos; only the lookup state is rebuilt. */
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
  console.log(
    `\n  Reusing ${ctx.reusedDatabase}: ${streams.rows.length} channels and threads, ${memos.rows[0]!.count} active memos\n`
  )
}

function seedWorkspace(variant: Variant) {
  return async (ctx: EvalContext): Promise<void> => {
    if (ctx.reusedDatabase) return reuseWorkspace(ctx)
    const startedAt = Date.now()
    const channels = selectedChannels()
    const askers = loadQuestions(datasetDir()).map((q) => q.askingUser)
    const names = [...new Set([...channels.flatMap((c) => c.authors), ...askers])].sort()
    const userIds = await insertUsers(ctx, names)

    const seededChannels = await Promise.all(channels.map((channel) => seedChannel(ctx, channel, userIds)))
    const messageCount = seededChannels.reduce((sum, c) => sum + c.messageCount, 0)
    console.log(
      `\n  Seeded ${messageCount} messages in ${channels.length} channels (${seconds(Date.now() - startedAt)})`
    )

    if (variant === "memory") {
      const memoService = createCaptureMemoService(ctx)
      // A channel's threads queue on the channel, so each channel drains on its own, the channels in parallel.
      // Each conversation is captured before the next is recorded, as production settles them one at a time.
      const remaining = await Promise.all(
        seededChannels.map(async ({ channelId, conversations }, i) => {
          let left = 0
          for (const c of conversations) {
            await recordConversation(ctx, c.streamId, c.messageIds, c.participantIds)
            left = await drainCapture(ctx, memoService, channelId)
          }
          console.log(
            `  ${channels[i]!.name}: ${conversations.length} conversations (${seconds(Date.now() - startedAt)})`
          )
          return left
        })
      )
      const { rows } = await ctx.pool.query<{ memos: string; abandoned: string }>(
        `SELECT
           (SELECT count(*) FROM memos WHERE workspace_id = $1 AND status = 'active') AS memos,
           (SELECT count(*) FROM memo_pending_items WHERE workspace_id = $1 AND failed_attempts >= $2) AS abandoned`,
        [ctx.workspaceId, MEMO_MAX_FAILED_ATTEMPTS]
      )
      const captured = seededChannels.reduce((sum, c) => sum + c.conversations.length, 0)
      const lost = Number(rows[0]!.abandoned) + remaining.reduce((sum, n) => sum + n, 0)
      console.log(
        `  Captured ${captured} conversations into ${rows[0]!.memos} memos, ${lost} lost to failed model calls (${seconds(Date.now() - startedAt)}, $${ctx.usage.getTotal().totalCost.toFixed(2)} generation)\n`
      )
    }

    const { rows } = await ctx.pool.query<{ id: string }>(`SELECT id FROM streams WHERE workspace_id = $1`, [
      ctx.workspaceId,
    ])
    seeded.set(ctx.workspaceId, { userIds, baselineStreamIds: new Set(rows.map((row) => row.id)) })
  }
}

function tierOf(retrievalSteps: number, recalledMemos: number): Tier {
  if (retrievalSteps > 0) return "research"
  return recalledMemos > 0 ? "prepared" : "none"
}

function runQuestion(variant: Variant) {
  return async ({ question }: GroupMemBenchInput, ctx: EvalContext): Promise<GroupMemBenchOutput> => {
    const state = seeded.get(ctx.workspaceId)
    if (!state) throw new Error("groupmembench setup did not run for this workspace")
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

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const seconds = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)}s`)

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
