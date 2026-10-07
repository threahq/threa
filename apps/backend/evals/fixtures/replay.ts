/**
 * Replays seeded messages through the production memory pipeline under a
 * simulated clock. The harness only posts messages and drives time; extraction,
 * conversations, memos and embeddings are the services server.ts composes,
 * woken by the real outbox dispatcher and queue workers.
 */

import type { Pool } from "pg"
import { DecisionsAvailability, type AI } from "@threahq/agent-runtime"
import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { parseMarkdown } from "@threahq/prosemirror"
import { AuthorTypes, StreamTypes } from "@threahq/types"
import { createDatabasePool } from "../../src/db"
import { WorkspaceAIResidencyPolicy } from "../../src/features/ai-usage"
import {
  BoundaryExtractionHandler,
  BoundaryExtractionService,
  ConversationEmbeddingHandler,
  conversationAssigner,
  createBoundaryExtractionWorker,
  createBoundaryExtractor,
  createConversationEmbeddingWorker,
  createStalenessSweepWorker,
} from "../../src/features/conversations"
import {
  EmbeddingHandler,
  EmbeddingService,
  MemoAccumulatorHandler,
  createEmbeddingWorker,
  createMemoService,
} from "../../src/features/memos"
import { EventService } from "../../src/features/messaging"
import { StreamService, StreamStateRepository } from "../../src/features/streams"
import { MessageFormatter } from "../../src/lib/ai/message-formatter"
import { createStaticConfigResolver } from "../../src/lib/ai/static-config-resolver"
import { OutboxDispatcher } from "../../src/lib/outbox"
import {
  JobQueues,
  QueueFairness,
  QueueManager,
  QueueRepository,
  QueueTiers,
  TokenPoolRepository,
} from "../../src/lib/queue"
import { SIM_CLOCK_POOL_CONFIG, type SimClock } from "../framework/sim-clock"

/** The memo batch-check and staleness-sweep cron cadences in server.ts. */
const BATCH_TICK_MS = 30_000
const SWEEP_TICK_MS = 600_000
/** Past the sweep's 7-day resolve threshold, so every conversation ends resolved. */
const TAIL_MS = 8 * 24 * 60 * 60 * 1000
const IDLE_POLL_MS = 100
const DRAIN_TIMEOUT_MS = 10 * 60 * 1000

const PIPELINE_QUEUES = [
  JobQueues.BOUNDARY_EXTRACT,
  JobQueues.EMBEDDING_GENERATE,
  JobQueues.CONVERSATION_EMBEDDING_GENERATE,
]

interface ReplayMessageBase {
  /** Caller's id for the message, so a later reply can name it as its thread root. */
  key: string
  authorId: string
  content: string
  createdAt: Date
}

/** A top-level post in `streamId`, or a reply in the thread under the message keyed `threadOf`. */
export type ReplayMessage = ReplayMessageBase & ({ streamId: string } | { threadOf: string })

export interface ReplayResult {
  /** Pipeline jobs that exhausted their retries; their work is missing from the replay. */
  deadLetteredJobs: number
}

export interface ReplayPipeline {
  /** Posts `messages` (oldest first) at their timestamps, then advances time until every memo is processed. */
  replay(messages: ReplayMessage[]): Promise<ReplayResult>
  stop(): Promise<void>
}

export async function startReplayPipeline(deps: {
  pool: Pool
  /** For the dispatcher's LISTEN pool, which needs its own connection like server.ts's `pools.listen`. */
  connectionString: string
  clock: SimClock
  ai: AI
  workspaceId: string
}): Promise<ReplayPipeline> {
  const { pool, clock, ai, workspaceId } = deps

  const configResolver = createStaticConfigResolver()
  const aiResidency = new WorkspaceAIResidencyPolicy({ pool })
  const decisionsAvailability = new DecisionsAvailability()
  const embeddingService = new EmbeddingService({ ai })
  const eventService = new EventService(pool, conversationAssigner, undefined, clock.now)
  const streamService = new StreamService(pool)
  const boundaryExtractionService = new BoundaryExtractionService(
    pool,
    createBoundaryExtractor({ ai, configResolver, aiResidency, decisionsAvailability })
  )
  const memoService = createMemoService({
    pool,
    ai,
    configResolver,
    messageFormatter: new MessageFormatter(),
    aiResidency,
    decisionsAvailability,
    embeddingService,
    analyticsReporter: new DisabledAnalyticsReporter(),
    now: clock.now,
  })
  const stalenessSweep = createStalenessSweepWorker({ pool })

  const jobQueue = new QueueManager({
    pool,
    queueRepository: QueueRepository,
    tokenPoolRepository: TokenPoolRepository,
    pollIntervalMs: 500,
    refillDebounceMs: 100,
    processingConcurrency: 3,
    tiers: { [QueueTiers.LIGHT]: { maxActiveTokens: 6 } },
  })
  const light = { tier: QueueTiers.LIGHT, fairness: QueueFairness.NONE }
  jobQueue.registerHandler(JobQueues.EMBEDDING_GENERATE, createEmbeddingWorker({ pool, embeddingService }), light)
  jobQueue.registerHandler(
    JobQueues.CONVERSATION_EMBEDDING_GENERATE,
    createConversationEmbeddingWorker({ pool, embeddingService }),
    light
  )
  jobQueue.registerHandler(
    JobQueues.BOUNDARY_EXTRACT,
    createBoundaryExtractionWorker({ service: boundaryExtractionService }),
    light
  )

  const listenPool = createDatabasePool(deps.connectionString, SIM_CLOCK_POOL_CONFIG)
  const outboxDispatcher = new OutboxDispatcher({ listenPool, fallbackPollMs: 2000 })
  const handlers = [
    new EmbeddingHandler(pool, jobQueue),
    new BoundaryExtractionHandler(pool, jobQueue),
    new MemoAccumulatorHandler(pool),
    new ConversationEmbeddingHandler(pool, jobQueue),
  ]
  for (const handler of handlers) {
    await handler.ensureListener()
    outboxDispatcher.register(handler)
  }
  const listenerIds = handlers.map((handler) => handler.listenerId)

  jobQueue.start()
  await outboxDispatcher.start()

  // One statement reads one snapshot, so work in flight between the outbox and
  // the queue is always visible on one side or the other.
  const isIdle = async (streamId: string | null): Promise<boolean> => {
    const result = await pool.query<{ busy: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM outbox_listeners l JOIN outbox o ON o.id > l.last_processed_id
         WHERE l.listener_id = ANY($1) AND NOT l.processed_ids ? o.id::text
       ) OR EXISTS (
         SELECT 1 FROM queue_messages q
         WHERE q.queue_name = ANY($2)
           AND q.completed_at IS NULL AND q.cancelled_at IS NULL AND q.dlq_at IS NULL
           AND ($3::text IS NULL OR (q.queue_name = $4 AND q.payload->>'streamId' = $3))
       ) AS busy`,
      [listenerIds, PIPELINE_QUEUES, streamId, JobQueues.BOUNDARY_EXTRACT]
    )
    return !result.rows[0].busy
  }

  const waitIdle = async (streamId: string | null): Promise<void> => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (!(await isIdle(streamId))) {
      if (Date.now() > deadline) {
        throw new Error(`Replay pipeline still busy after ${DRAIN_TIMEOUT_MS}ms (stream ${streamId ?? "all"})`)
      }
      await Bun.sleep(IDLE_POLL_MS)
    }
  }
  const drain = () => waitIdle(null)

  const hasPendingMemoItems = async (): Promise<boolean> => {
    const result = await pool.query<{ pending: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM memo_pending_items WHERE processed_at IS NULL) AS pending"
    )
    return result.rows[0].pending
  }

  const runBatchCheck = async (): Promise<void> => {
    for (const ready of await StreamStateRepository.findStreamsReadyToProcess(pool)) {
      await memoService.processBatch(ready.workspaceId, ready.streamId)
    }
  }

  const nextBoundary = (stepMs: number): number => (Math.floor(clock.now().getTime() / stepMs) + 1) * stepMs

  /**
   * Fires each cron tick up to `target` at its own instant, after the pipeline
   * has finished what production would have finished by then. A batch tick with
   * no unprocessed memo items is a no-op, so those are skipped for the next
   * sweep tick until the pipeline queues memo work again.
   */
  const advanceTo = async (target: Date): Promise<void> => {
    while (nextBoundary(BATCH_TICK_MS) <= target.getTime()) {
      await drain()
      const tick = (await hasPendingMemoItems()) ? nextBoundary(BATCH_TICK_MS) : nextBoundary(SWEEP_TICK_MS)
      if (tick > target.getTime()) return
      await clock.set(new Date(tick))
      await runBatchCheck()
      if (tick % SWEEP_TICK_MS === 0) {
        await stalenessSweep({
          id: `replay_sweep_${tick}`,
          name: JobQueues.CONVERSATION_STALENESS_SWEEP,
          data: { workspaceId: "system" },
        })
      }
    }
  }

  const replay = async (messages: ReplayMessage[]): Promise<ReplayResult> => {
    const posted = new Map<string, { id: string; streamId: string }>()
    const threadIds = new Map<string, string>()
    const rootOf = (key: string) => {
      const root = posted.get(key)
      if (!root) throw new Error(`Reply to unknown message ${key}`)
      return root
    }

    for (const message of messages) {
      await advanceTo(message.createdAt)

      // A thread's first reply waits on the stream its root was posted in.
      const knownStreamId =
        "streamId" in message
          ? message.streamId
          : (threadIds.get(message.threadOf) ?? rootOf(message.threadOf).streamId)
      await waitIdle(knownStreamId)
      await clock.set(message.createdAt)

      let streamId = knownStreamId
      if ("threadOf" in message && !threadIds.has(message.threadOf)) {
        const root = rootOf(message.threadOf)
        const thread = await streamService.create({
          workspaceId,
          type: StreamTypes.THREAD,
          parentStreamId: root.streamId,
          parentAnchorId: root.id,
          createdBy: message.authorId,
        })
        threadIds.set(message.threadOf, thread.id)
        streamId = thread.id
      }

      const created = await eventService.createMessage({
        workspaceId,
        streamId,
        authorId: message.authorId,
        authorType: AuthorTypes.USER,
        contentJson: parseMarkdown(message.content),
        contentMarkdown: message.content,
      })
      posted.set(message.key, { id: created.id, streamId })
    }

    const last = messages.at(-1)
    if (last) await advanceTo(new Date(last.createdAt.getTime() + TAIL_MS))
    await drain()
    if (await hasPendingMemoItems()) throw new Error("Replay ended with unprocessed memo items")

    const dead = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM queue_messages WHERE queue_name = ANY($1) AND dlq_at IS NOT NULL",
      [PIPELINE_QUEUES]
    )
    return { deadLetteredJobs: Number(dead.rows[0].count) }
  }

  return {
    replay,
    stop: async () => {
      await outboxDispatcher.stop()
      await jobQueue.stop()
      await listenPool.end()
    },
  }
}
