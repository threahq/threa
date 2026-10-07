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
  MemoExplorerService,
  Reranker,
  createEmbeddingWorker,
  createMemoBatchCheckWorker,
  createMemoBatchProcessWorker,
  createMemoService,
} from "../../src/features/memos"
import { DelegationService } from "../../src/features/delegations"
import { LinkPreviewOutboxHandler, LinkPreviewService, createLinkPreviewWorker } from "../../src/features/link-previews"
import { EventService } from "../../src/features/messaging"
import { StreamService } from "../../src/features/streams"
import { WorkspaceIntegrationService } from "../../src/features/workspace-integrations"
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
const IDLE_POLL_MS = 100
/** A hang guard; one tick's memo batches can run a few hundred model calls. */
const DRAIN_TIMEOUT_MS = 30 * 60 * 1000

const PIPELINE_QUEUES = [
  JobQueues.BOUNDARY_EXTRACT,
  JobQueues.EMBEDDING_GENERATE,
  JobQueues.CONVERSATION_EMBEDDING_GENERATE,
  JobQueues.LINK_PREVIEW_EXTRACT,
  JobQueues.MEMO_BATCH_PROCESS,
]

interface ReplayMessageBase {
  /** Caller's id for the message, so a later reply can name it as its thread root. */
  key: string
  authorId: string
  content: string
  createdAt: Date
}

/**
 * A top-level post in `streamId`, or a reply in the thread under the message
 * keyed `threadOf`; the thread's first reply names it `threadName`.
 */
export type ReplayMessage = ReplayMessageBase & ({ streamId: string } | { threadOf: string; threadName?: string })

export interface ReplayResult {
  /** Pipeline jobs that exhausted their retries; their work is missing from the replay. */
  deadLetteredJobs: number
  /** Outbox events a pipeline listener gave up on; whatever they would have triggered is missing too. */
  deadLetteredEvents: number
  /** Memo work production would still have pending at `until`, such as conversations active then. */
  unprocessedMemoItems: number
}

export interface ReplayPipeline {
  /** Posts `messages` (oldest first) at their timestamps, then runs the pipeline on to `until`. */
  replay(messages: ReplayMessage[], until: Date): Promise<ReplayResult>
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
  // AI context assembly waits on the previews of the messages it reads, so the
  // replay settles them the way production does rather than letting each wait time out.
  const linkPreviewService = new LinkPreviewService({
    pool,
    streamService,
    memoExplorerService: new MemoExplorerService({
      pool,
      embeddingService,
      reranker: new Reranker({ ai, subject: "knowledge memos", functionId: "memo-rerank" }),
    }),
    delegationService: new DelegationService({ pool }),
  })
  const workspaceIntegrationService = new WorkspaceIntegrationService({
    pool,
    github: { enabled: false, appId: "", appSlug: "", privateKey: "", integrationSecret: "" },
    linear: { enabled: false, clientId: "", clientSecret: "", redirectUri: "", integrationSecret: "" },
  })

  const jobQueue = new QueueManager({
    pool,
    queueRepository: QueueRepository,
    tokenPoolRepository: TokenPoolRepository,
    pollIntervalMs: 500,
    refillDebounceMs: 100,
    processingConcurrency: 3,
    tiers: { [QueueTiers.LIGHT]: { maxActiveTokens: 6 }, [QueueTiers.HEAVY]: { maxActiveTokens: 3 } },
  })
  const light = { tier: QueueTiers.LIGHT, fairness: QueueFairness.NONE }
  const memoBatchCheck = createMemoBatchCheckWorker({ pool, memoService, jobQueue })
  jobQueue.registerHandler(
    JobQueues.MEMO_BATCH_PROCESS,
    createMemoBatchProcessWorker({ pool, memoService, jobQueue }),
    { tier: QueueTiers.HEAVY, fairness: QueueFairness.WORKSPACE }
  )
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
  jobQueue.registerHandler(
    JobQueues.LINK_PREVIEW_EXTRACT,
    createLinkPreviewWorker({ linkPreviewService, workspaceIntegrationService }),
    light
  )

  const listenPool = createDatabasePool(deps.connectionString, SIM_CLOCK_POOL_CONFIG)
  const outboxDispatcher = new OutboxDispatcher({ listenPool, fallbackPollMs: 2000 })
  const handlers = [
    new EmbeddingHandler(pool, jobQueue),
    new BoundaryExtractionHandler(pool, jobQueue),
    new MemoAccumulatorHandler(pool),
    new ConversationEmbeddingHandler(pool, jobQueue),
    new LinkPreviewOutboxHandler(pool, jobQueue),
  ]
  const listenerIds = handlers.map((handler) => handler.listenerId)

  try {
    for (const handler of handlers) {
      await handler.ensureListener()
      outboxDispatcher.register(handler)
    }
    jobQueue.start()
    await outboxDispatcher.start()
  } catch (error) {
    await outboxDispatcher.stop()
    await jobQueue.stop()
    await listenPool.end()
    throw error
  }

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

  type MemoItemState = { streamId: string; failedAttempts: number; processed: boolean }
  /** The items still pending, or with `ids` those items whatever became of them. */
  const memoItems = async (ids: string[] | null = null): Promise<Map<string, MemoItemState>> => {
    const result = await pool.query<{ id: string; stream_id: string; failed_attempts: number; processed: boolean }>(
      `SELECT id, stream_id, failed_attempts, processed_at IS NOT NULL AS processed
       FROM memo_pending_items
       WHERE CASE WHEN $1::text[] IS NULL THEN processed_at IS NULL ELSE id = ANY($1) END`,
      [ids]
    )
    return new Map(
      result.rows.map((row) => [
        row.id,
        { streamId: row.stream_id, failedAttempts: row.failed_attempts, processed: row.processed },
      ])
    )
  }

  /**
   * Runs the production memo batch check at `tick` and waits for the batches it
   * dispatched. Returns the streams whose batch left every item as it was, all
   * deferred, and whether any item failed this tick.
   */
  const runBatchCheck = async (tick: number): Promise<{ settled: Set<string>; failed: boolean }> => {
    const before = await memoItems()
    await memoBatchCheck({
      id: `replay_batch_${tick}`,
      name: JobQueues.MEMO_BATCH_CHECK,
      data: { workspaceId: "system" },
    })
    await drain()
    const after = await memoItems([...before.keys()])
    const changed = new Set<string>()
    let failed = false
    for (const [id, prior] of before) {
      const current = after.get(id)
      if (current && !current.processed && current.failedAttempts === prior.failedAttempts) continue
      changed.add(prior.streamId)
      if (current && current.failedAttempts > prior.failedAttempts) failed = true
    }
    const processed = await pool.query<{ stream_id: string }>(
      "SELECT stream_id FROM memo_stream_state WHERE last_processed_at = $1",
      [new Date(tick)]
    )
    const settled = new Set(processed.rows.map((row) => row.stream_id).filter((streamId) => !changed.has(streamId)))
    return { settled, failed }
  }

  const nextBoundary = (stepMs: number): number => (Math.floor(clock.now().getTime() / stepMs) + 1) * stepMs

  /**
   * Fires each cron tick up to `target` at its own instant, after the pipeline
   * has finished what production would have finished by then. A batch tick can
   * only matter while some stream holds memo items it has not yet found settled;
   * items it deferred stay deferred until a sweep moves their conversation or a
   * new message arrives, so those wait for the next sweep tick. That releases a
   * conversation deferred for its quiet period up to one sweep interval late.
   * Production retries a failed memo item on a later 30s tick, so a tick that
   * failed one waits that long in real time too, letting transient AI errors clear.
   */
  const advanceTo = async (target: Date): Promise<void> => {
    let settled = new Set<string>()
    while (nextBoundary(BATCH_TICK_MS) <= target.getTime()) {
      await drain()
      const pending = await memoItems()
      const batchDue = [...pending.values()].some((item) => !settled.has(item.streamId))
      const tick = batchDue ? nextBoundary(BATCH_TICK_MS) : nextBoundary(SWEEP_TICK_MS)
      if (tick > target.getTime()) return
      await clock.set(new Date(tick))
      if (tick % SWEEP_TICK_MS === 0) {
        await stalenessSweep({
          id: `replay_sweep_${tick}`,
          name: JobQueues.CONVERSATION_STALENESS_SWEEP,
          data: { workspaceId: "system" },
        })
        await drain()
      }
      const result = await runBatchCheck(tick)
      settled = result.settled
      if (result.failed) await Bun.sleep(BATCH_TICK_MS)
    }
  }

  const replay = async (messages: ReplayMessage[], until: Date): Promise<ReplayResult> => {
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
        if (message.threadName) {
          await streamService.updateStream(
            thread.id,
            { displayName: message.threadName },
            { workspaceId, principal: { kind: "user", userId: message.authorId } }
          )
        }
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

    await advanceTo(until)
    await drain()
    await clock.set(until)

    const dead = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM queue_messages WHERE queue_name = ANY($1) AND dlq_at IS NOT NULL",
      [PIPELINE_QUEUES]
    )
    const deadEvents = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM outbox_dead_letters WHERE listener_id = ANY($1)",
      [listenerIds]
    )
    return {
      deadLetteredJobs: Number(dead.rows[0].count),
      deadLetteredEvents: Number(deadEvents.rows[0].count),
      unprocessedMemoItems: (await memoItems()).size,
    }
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
