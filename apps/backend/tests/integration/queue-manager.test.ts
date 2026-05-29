import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { QueueManager, QueueRepository, TokenPoolRepository } from "../../src/lib/queue"
import { AttachmentRepository } from "../../src/features/attachments"
import { setupTestDatabase } from "./setup"
import type {
  Job,
  JobHandler,
  JobQueueName,
  OnDLQHook,
  QueueMessageMeta,
  ImageCaptionJobData,
} from "../../src/lib/queue"
import type { Querier } from "../../src/db"
import { ProcessingStatuses, type ProcessingStatus } from "@threa/types"

const TEST_QUEUE = "test.dlq-hook" as JobQueueName
const IMAGE_CAPTION_TEST_QUEUE = "test.image-caption.dlq-hook" as JobQueueName

interface TestJobData {
  workspaceId: string
  testValue: string
}

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  errorMessage: string,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(errorMessage)
}

describe("QueueManager", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM queue_messages WHERE workspace_id LIKE 'ws_test%'")
    await pool.query("DELETE FROM queue_tokens WHERE workspace_id LIKE 'ws_test%'")
  })

  describe("onDLQ hook", () => {
    test("should call onDLQ hook when message exhausts retries", async () => {
      const hookCalls: Array<{ job: Job<TestJobData>; error: Error; meta: QueueMessageMeta }> = []
      let resolveHookCalled: () => void
      const hookCalled = new Promise<void>((resolve) => {
        resolveHookCalled = resolve
      })

      const failingHandler: JobHandler<TestJobData> = async () => {
        throw new Error("intentional failure")
      }

      const onDLQHook: OnDLQHook<TestJobData> = async (_querier, job, error, meta) => {
        hookCalls.push({ job, error, meta })
        resolveHookCalled()
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        maxRetries: 1,
        pollIntervalMs: 50,
        lockDurationMs: 5000,
      })

      manager.registerHandler(TEST_QUEUE, failingHandler as JobHandler<unknown>, {
        hooks: { onDLQ: onDLQHook as OnDLQHook<unknown> },
      })

      const now = new Date()
      const messageId = `queue_test_${Date.now()}`

      await QueueRepository.insert(pool, {
        id: messageId,
        queueName: TEST_QUEUE,
        workspaceId: "ws_test_dlq",
        payload: { workspaceId: "ws_test_dlq", testValue: "hook-test" },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        await Promise.race([
          hookCalled,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for hook")), 5000)),
        ])

        expect(hookCalls.length).toBe(1)
        expect(hookCalls[0].job.id).toBe(messageId)
        expect(hookCalls[0].job.name).toBe(TEST_QUEUE)
        expect(hookCalls[0].job.data).toEqual({ workspaceId: "ws_test_dlq", testValue: "hook-test" })
        expect(hookCalls[0].error.message).toBe("intentional failure")
        expect(hookCalls[0].meta.workspaceId).toBe("ws_test_dlq")
        expect(hookCalls[0].meta.failedCount).toBe(0)
        expect(hookCalls[0].meta.insertedAt).toBeInstanceOf(Date)

        // The onDLQ hook resolves `hookCalled` from inside the DLQ-move
        // transaction's savepoint — i.e. before the outer transaction commits.
        // Wait until the committed DLQ state is visible on a fresh connection
        // rather than reading once and racing the commit (INV-22).
        await waitForCondition(
          async () => (await QueueRepository.getById(pool, messageId))?.dlqAt != null,
          2000,
          `Message ${messageId} did not reach a committed DLQ state`
        )
        const message = await QueueRepository.getById(pool, messageId)
        expect(message).not.toBeNull()
        expect(message!.dlqAt).not.toBeNull()
      } finally {
        await manager.stop()
      }
    })

    test("should pass querier to hook for transactional operations", async () => {
      let querierPassed: Querier | null = null
      let resolveHookCalled: () => void
      const hookCalled = new Promise<void>((resolve) => {
        resolveHookCalled = resolve
      })

      const failingHandler: JobHandler<TestJobData> = async () => {
        throw new Error("intentional failure")
      }

      const onDLQHook: OnDLQHook<TestJobData> = async (querier, _job, _error, _meta) => {
        querierPassed = querier
        resolveHookCalled()
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        maxRetries: 1,
        pollIntervalMs: 50,
        lockDurationMs: 5000,
      })

      manager.registerHandler(TEST_QUEUE, failingHandler as JobHandler<unknown>, {
        hooks: { onDLQ: onDLQHook as OnDLQHook<unknown> },
      })

      const now = new Date()
      const messageId = `queue_test_${Date.now()}`

      await QueueRepository.insert(pool, {
        id: messageId,
        queueName: TEST_QUEUE,
        workspaceId: "ws_test_dlq",
        payload: { workspaceId: "ws_test_dlq", testValue: "querier-test" },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        await Promise.race([
          hookCalled,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for hook")), 5000)),
        ])

        expect(querierPassed).not.toBeNull()
        expect(typeof querierPassed!.query).toBe("function")
      } finally {
        await manager.stop()
      }
    })

    test("should still move to DLQ even if hook throws (hook runs in savepoint)", async () => {
      let hookCallCount = 0
      let resolveHookCalled: () => void
      const hookCalled = new Promise<void>((resolve) => {
        resolveHookCalled = resolve
      })

      const failingHandler: JobHandler<TestJobData> = async () => {
        throw new Error("intentional failure")
      }

      const throwingHook: OnDLQHook<TestJobData> = async (_querier, _job, _error, _meta) => {
        hookCallCount++
        resolveHookCalled()
        throw new Error("hook failure")
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        maxRetries: 1,
        pollIntervalMs: 50,
        lockDurationMs: 5000,
        baseBackoffMs: 100,
      })

      manager.registerHandler(TEST_QUEUE, failingHandler as JobHandler<unknown>, {
        hooks: { onDLQ: throwingHook as OnDLQHook<unknown> },
      })

      const now = new Date()
      const messageId = `queue_test_${Date.now()}`

      await QueueRepository.insert(pool, {
        id: messageId,
        queueName: TEST_QUEUE,
        workspaceId: "ws_test_dlq",
        payload: { workspaceId: "ws_test_dlq", testValue: "savepoint-test" },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        await Promise.race([
          hookCalled,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for hook")), 5000)),
        ])

        // Wait briefly for the transaction to complete
        await new Promise((resolve) => setTimeout(resolve, 200))

        const message = await QueueRepository.getById(pool, messageId)
        expect(message).not.toBeNull()
        // Message SHOULD be in DLQ - hook failure doesn't prevent DLQ move
        // Hook runs in a savepoint, so its failure is isolated
        expect(message!.dlqAt).not.toBeNull()
        // Hook was called once
        expect(hookCallCount).toBe(1)
      } finally {
        await manager.stop()
      }
    })

    test("should move message to DLQ without hook when no hook registered", async () => {
      let resolveProcessed: () => void
      const processed = new Promise<void>((resolve) => {
        resolveProcessed = resolve
      })

      const failingHandler: JobHandler<TestJobData> = async () => {
        throw new Error("intentional failure")
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        maxRetries: 1,
        pollIntervalMs: 50,
        lockDurationMs: 5000,
      })

      // Register without hooks
      manager.registerHandler(TEST_QUEUE, failingHandler as JobHandler<unknown>)

      const now = new Date()
      const messageId = `queue_test_${Date.now()}`

      await QueueRepository.insert(pool, {
        id: messageId,
        queueName: TEST_QUEUE,
        workspaceId: "ws_test_dlq",
        payload: { workspaceId: "ws_test_dlq", testValue: "no-hook-test" },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        // Poll for DLQ status since we don't have a hook to signal completion
        const startTime = Date.now()
        while (Date.now() - startTime < 5000) {
          const message = await QueueRepository.getById(pool, messageId)
          if (message?.dlqAt) {
            resolveProcessed()
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        await Promise.race([
          processed,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for DLQ")), 5000)),
        ])

        const message = await QueueRepository.getById(pool, messageId)
        expect(message).not.toBeNull()
        expect(message!.dlqAt).not.toBeNull()
        expect(message!.lastError).toBe("intentional failure")
      } finally {
        await manager.stop()
      }
    })

    test("should only move to DLQ after exhausting all retries", async () => {
      let handlerCallCount = 0
      let resolveAllRetries: () => void
      const allRetriesExhausted = new Promise<void>((resolve) => {
        resolveAllRetries = resolve
      })

      const failingHandler: JobHandler<TestJobData> = async () => {
        handlerCallCount++
        throw new Error(`failure ${handlerCallCount}`)
      }

      const onDLQHook: OnDLQHook<TestJobData> = async (_querier, _job, _error, _meta) => {
        resolveAllRetries()
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        maxRetries: 3,
        pollIntervalMs: 50,
        lockDurationMs: 5000,
        baseBackoffMs: 50,
      })

      manager.registerHandler(TEST_QUEUE, failingHandler as JobHandler<unknown>, {
        hooks: { onDLQ: onDLQHook as OnDLQHook<unknown> },
      })

      const now = new Date()
      const messageId = `queue_test_${Date.now()}`

      await QueueRepository.insert(pool, {
        id: messageId,
        queueName: TEST_QUEUE,
        workspaceId: "ws_test_dlq",
        payload: { workspaceId: "ws_test_dlq", testValue: "retry-test" },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        await Promise.race([
          allRetriesExhausted,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for retries")), 10000)),
        ])

        // Hook signals from inside the transaction - wait for commit
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Handler should have been called maxRetries times
        expect(handlerCallCount).toBe(3)

        const message = await QueueRepository.getById(pool, messageId)
        expect(message).not.toBeNull()
        expect(message!.dlqAt).not.toBeNull()
        // failedCount is maxRetries - 1 because it's incremented on retry, not on final DLQ move
        // (1st failure → retry → count=1, 2nd failure → retry → count=2, 3rd failure → DLQ → count stays 2)
        expect(message!.failedCount).toBe(2)
      } finally {
        await manager.stop()
      }
    })
  })

  describe("image caption onDLQ hook", () => {
    test("should mark attachment FAILED on DLQ and COMPLETED after un-DLQ retry", async () => {
      const workspaceId = `ws_test_${Date.now()}`
      const attachmentId = `attach_test_${Date.now()}`
      const messageId = `queue_test_${Date.now()}`

      // Create attachment in PENDING state
      await AttachmentRepository.insert(pool, {
        id: attachmentId,
        workspaceId,
        uploadedBy: "user_test",
        filename: "test.png",
        mimeType: "image/png",
        sizeBytes: 1000,
        storagePath: "test/path.png",
      })

      // Controllable handler: fails until shouldSucceed is true
      let shouldSucceed = false
      let handlerCalls = 0
      const handler: JobHandler<ImageCaptionJobData> = async () => {
        handlerCalls++
        if (!shouldSucceed) {
          throw new Error("intentional failure")
        }
        // On success, mark completed (simulating what the real service does)
        await AttachmentRepository.updateProcessingStatus(pool, attachmentId, ProcessingStatuses.COMPLETED)
      }

      // onDLQ hook marks attachment as FAILED (mirrors server.ts)
      const onDLQHook: OnDLQHook<ImageCaptionJobData> = async (querier, job) => {
        await AttachmentRepository.updateProcessingStatus(querier, job.data.attachmentId, ProcessingStatuses.FAILED)
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        maxRetries: 2, // DLQ after 2 failures
        pollIntervalMs: 10,
        lockDurationMs: 5000,
        baseBackoffMs: 10,
      })

      manager.registerHandler(IMAGE_CAPTION_TEST_QUEUE, handler as JobHandler<unknown>, {
        hooks: { onDLQ: onDLQHook as OnDLQHook<unknown> },
      })

      // Enqueue the job
      const now = new Date()
      await QueueRepository.insert(pool, {
        id: messageId,
        queueName: IMAGE_CAPTION_TEST_QUEUE,
        workspaceId,
        payload: {
          attachmentId,
          workspaceId,
          filename: "test.png",
          mimeType: "image/png",
          storagePath: "test/path.png",
        },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        await waitForCondition(
          async () => {
            const attachment = await AttachmentRepository.findById(pool, attachmentId)
            return attachment?.processingStatus === ProcessingStatuses.FAILED
          },
          5000,
          "Timeout waiting for attachment to be marked FAILED"
        )

        await waitForCondition(
          async () => {
            const message = await QueueRepository.getById(pool, messageId)
            return message?.dlqAt !== null
          },
          5000,
          "Timeout waiting for message to be moved to DLQ"
        )

        // Verify attachment is FAILED
        const failedAttachment = await AttachmentRepository.findById(pool, attachmentId)
        expect(failedAttachment?.processingStatus).toBe(ProcessingStatuses.FAILED)

        // Verify message is in DLQ
        const dlqMessage = await QueueRepository.getById(pool, messageId)
        expect(dlqMessage?.dlqAt).not.toBeNull()

        // Un-DLQ and allow success
        shouldSucceed = true
        await QueueRepository.unDlq(pool, { messageId, processAfter: new Date() })

        await waitForCondition(
          async () => {
            const attachment = await AttachmentRepository.findById(pool, attachmentId)
            return attachment?.processingStatus === ProcessingStatuses.COMPLETED
          },
          5000,
          "Timeout waiting for attachment to be marked COMPLETED after un-DLQ"
        )

        // Verify attachment is COMPLETED
        const completedAttachment = await AttachmentRepository.findById(pool, attachmentId)
        expect(completedAttachment?.processingStatus).toBe(ProcessingStatuses.COMPLETED)

        // Handler was called: 2 times for DLQ + 1 time after un-DLQ
        expect(handlerCalls).toBe(3)
      } finally {
        await manager.stop()
        // Cleanup
        await pool.query("DELETE FROM attachments WHERE id = $1", [attachmentId])
        await pool.query("DELETE FROM queue_messages WHERE id = $1", [messageId])
      }
    })
  })

  describe("tier budgets", () => {
    const INTERACTIVE_QUEUE = "test.tier.interactive" as JobQueueName
    const HEAVY_QUEUE = "test.tier.heavy" as JobQueueName
    const HUNG_INTERACTIVE_QUEUE = "test.tier.interactive.hung" as JobQueueName

    beforeEach(async () => {
      await pool.query("DELETE FROM queue_messages WHERE queue_name IN ($1, $2, $3)", [
        INTERACTIVE_QUEUE,
        HEAVY_QUEUE,
        HUNG_INTERACTIVE_QUEUE,
      ])
      await pool.query("DELETE FROM queue_tokens WHERE queue_name IN ($1, $2, $3)", [
        INTERACTIVE_QUEUE,
        HEAVY_QUEUE,
        HUNG_INTERACTIVE_QUEUE,
      ])
    })

    test("heavy tier can't starve interactive tier under load", async () => {
      // Track max concurrent by tier.
      let heavyInFlight = 0
      let interactiveInFlight = 0
      let heavyPeak = 0
      let interactivePeak = 0

      // Heavy handler blocks so the tier's budget stays saturated.
      let releaseHeavy: () => void = () => {}
      const heavyBlocked = new Promise<void>((resolve) => {
        releaseHeavy = resolve
      })
      const heavyHandler: JobHandler<TestJobData> = async () => {
        heavyInFlight++
        heavyPeak = Math.max(heavyPeak, heavyInFlight)
        try {
          await heavyBlocked
        } finally {
          heavyInFlight--
        }
      }

      let interactiveCompleted = 0
      const interactiveHandler: JobHandler<TestJobData> = async () => {
        interactiveInFlight++
        interactivePeak = Math.max(interactivePeak, interactiveInFlight)
        await new Promise((resolve) => setTimeout(resolve, 30))
        interactiveInFlight--
        interactiveCompleted++
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        pollIntervalMs: 50,
        lockDurationMs: 10_000,
        // claimBatchSize=1 forces each token to claim exactly one message, so
        // tier budget (tokens in flight) equals concurrent handler count —
        // otherwise one token could claim all messages and hide the tier
        // parallelism we're trying to exercise.
        claimBatchSize: 1,
        processingConcurrency: 1,
        tiers: {
          interactive: { maxActiveTokens: 3 },
          heavy: { maxActiveTokens: 2 },
        },
      })

      manager.registerHandler(HEAVY_QUEUE, heavyHandler as JobHandler<unknown>, {
        tier: "heavy",
        fairness: "none",
      })
      manager.registerHandler(INTERACTIVE_QUEUE, interactiveHandler as JobHandler<unknown>, {
        tier: "interactive",
        fairness: "none",
      })

      // Seed many heavy jobs (enough to over-subscribe the heavy budget if it
      // leaked into other tiers) and a few interactive jobs.
      const now = new Date()
      for (let i = 0; i < 10; i++) {
        await QueueRepository.insert(pool, {
          id: `queue_tier_heavy_${i}_${Date.now()}`,
          queueName: HEAVY_QUEUE,
          workspaceId: "ws_test_tier",
          payload: { workspaceId: "ws_test_tier", testValue: `h${i}` },
          processAfter: now,
          insertedAt: now,
        })
      }
      for (let i = 0; i < 5; i++) {
        await QueueRepository.insert(pool, {
          id: `queue_tier_interactive_${i}_${Date.now()}`,
          queueName: INTERACTIVE_QUEUE,
          workspaceId: "ws_test_tier",
          payload: { workspaceId: "ws_test_tier", testValue: `i${i}` },
          processAfter: now,
          insertedAt: now,
        })
      }

      manager.start()

      try {
        // Interactive jobs should drain even while heavy is fully saturated
        // and blocked. If the tier budgets were shared, the heavy jobs would
        // claim all 3 slots and interactive work would wait forever.
        await waitForCondition(
          async () => interactiveCompleted >= 5,
          5000,
          "Interactive jobs did not drain while heavy tier was saturated"
        )

        // Heavy tier should never exceed its budget (2).
        expect(heavyPeak).toBeLessThanOrEqual(2)
        // Interactive tier should actually use parallelism — with 5 jobs and
        // a budget of 3, we expect at least 2 concurrent handlers at some
        // point, proving the tiers drain independently of blocked heavy work.
        expect(interactivePeak).toBeGreaterThanOrEqual(2)
      } finally {
        releaseHeavy()
        await manager.stop()
        await pool.query("DELETE FROM queue_messages WHERE queue_name IN ($1, $2)", [INTERACTIVE_QUEUE, HEAVY_QUEUE])
        await pool.query("DELETE FROM queue_tokens WHERE queue_name IN ($1, $2)", [INTERACTIVE_QUEUE, HEAVY_QUEUE])
      }
    })

    test("later interactive work still drains when one token is hung", async () => {
      let releaseBlocked: () => void = () => {}
      const blocked = new Promise<void>((resolve) => {
        releaseBlocked = resolve
      })

      let blockedStarted = false
      let fastCompleted = 0

      const handler: JobHandler<TestJobData> = async (job) => {
        if (job.data.testValue === "block") {
          blockedStarted = true
          await blocked
          return
        }

        fastCompleted++
      }

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        pollIntervalMs: 50,
        lockDurationMs: 10_000,
        claimBatchSize: 1,
        processingConcurrency: 1,
        tiers: {
          interactive: { maxActiveTokens: 2 },
        },
      })

      manager.registerHandler(HUNG_INTERACTIVE_QUEUE, handler as JobHandler<unknown>, {
        tier: "interactive",
        fairness: "none",
      })

      const workspaceId = "ws_test_tier_hung"
      const now = new Date()

      await QueueRepository.insert(pool, {
        id: `queue_tier_hung_block_${Date.now()}`,
        queueName: HUNG_INTERACTIVE_QUEUE,
        workspaceId,
        payload: { workspaceId, testValue: "block" },
        processAfter: now,
        insertedAt: now,
      })

      manager.start()

      try {
        await waitForCondition(
          async () => blockedStarted,
          5000,
          "Timed out waiting for the first interactive token to start"
        )

        await QueueRepository.insert(pool, {
          id: `queue_tier_hung_fast_${Date.now()}`,
          queueName: HUNG_INTERACTIVE_QUEUE,
          workspaceId,
          payload: { workspaceId, testValue: "fast" },
          processAfter: new Date(),
          insertedAt: new Date(),
        })

        await waitForCondition(
          async () => fastCompleted === 1,
          5000,
          "Fresh interactive work starved while another token was hung"
        )
      } finally {
        releaseBlocked()
        await manager.stop()
        await pool.query("DELETE FROM queue_messages WHERE queue_name = $1", [HUNG_INTERACTIVE_QUEUE])
        await pool.query("DELETE FROM queue_tokens WHERE queue_name = $1", [HUNG_INTERACTIVE_QUEUE])
      }
    })
  })
})
