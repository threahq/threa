import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { QueueRepository } from "../../src/lib/queue"
import { setupTestDatabase, withTestTransaction } from "./setup"

describe("QueueRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    // Clean up test data between tests
    await pool.query("DELETE FROM queue_messages WHERE workspace_id LIKE 'ws_test%'")
    await pool.query("DELETE FROM queue_tokens WHERE workspace_id LIKE 'ws_test%'")
  })

  async function claimNext(
    client: any,
    params: {
      queueName: string
      workspaceId: string
      claimedBy: string
      claimedAt: Date
      claimedUntil: Date
      now: Date
    }
  ) {
    const claimed = await QueueRepository.batchClaimMessages(client, { ...params, limit: 1 })
    return claimed[0] ?? null
  }

  async function renewClaim(client: any, params: { messageId: string; claimedBy: string; claimedUntil: Date }) {
    const renewed = await QueueRepository.batchRenewClaims(client, {
      messageIds: [params.messageId],
      claimedBy: params.claimedBy,
      claimedUntil: params.claimedUntil,
    })
    return renewed === 1
  }

  describe("insert", () => {
    test("should insert a message", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()
        const message = await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { foo: "bar" },
          processAfter: now,
          insertedAt: now,
        })

        expect(message.id).toBe("queue_test1")
        expect(message.queueName).toBe("test.queue")
        expect(message.workspaceId).toBe("ws_test")
        expect(message.payload).toEqual({ foo: "bar" })
        expect(message.processAfter).toEqual(now)
        expect(message.insertedAt).toEqual(now)
        expect(message.claimedAt).toBeNull()
        expect(message.claimedBy).toBeNull()
        expect(message.claimedUntil).toBeNull()
        expect(message.claimedCount).toBe(0)
        expect(message.failedCount).toBe(0)
        expect(message.lastError).toBeNull()
        expect(message.dlqAt).toBeNull()
        expect(message.completedAt).toBeNull()
      })
    })
  })

  describe("claimNext", () => {
    test("should claim next available message", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert two messages
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_test2",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 2 },
          processAfter: new Date(now.getTime() + 1000),
          insertedAt: now,
        })

        // Claim next (should get first one)
        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(claimed).not.toBeNull()
        expect(claimed!.id).toBe("queue_test1")
        expect(claimed!.claimedBy).toBe("worker_test")
        expect(claimed!.claimedCount).toBe(1)
      })
    })

    test("should return null if no messages available", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(claimed).toBeNull()
      })
    })

    test("should skip messages not ready yet (processAfter > now)", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message scheduled for future
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: new Date(now.getTime() + 60000), // 1 minute future
          insertedAt: now,
        })

        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(claimed).toBeNull()
      })
    })

    test("should skip messages with active claims", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and claim a message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const firstClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(firstClaim).not.toBeNull()

        // Try to claim again (should skip claimed message)
        const secondClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(secondClaim).toBeNull()
      })
    })

    test("should reclaim messages with expired claims", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Claim with expired claimedUntil
        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() - 1000), // Already expired
          now,
        })

        // Should be able to reclaim
        const reclaimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(reclaimed).not.toBeNull()
        expect(reclaimed!.id).toBe("queue_test1")
        expect(reclaimed!.claimedBy).toBe("worker_2")
        expect(reclaimed!.claimedCount).toBe(2) // Incremented on reclaim
      })
    })

    test("should skip completed messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Claim and complete
        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        await QueueRepository.complete(client, {
          messageId: claimed!.id,
          claimedBy: "worker_1",
          completedAt: now,
        })

        // Try to claim again (should not get completed message)
        const secondClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(secondClaim).toBeNull()
      })
    })

    test("should skip DLQ messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Claim and move to DLQ
        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        await QueueRepository.failDlq(client, {
          messageId: claimed!.id,
          claimedBy: "worker_1",
          error: "test error",
          dlqAt: now,
        })

        // Try to claim again (should not get DLQ message)
        const secondClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        expect(secondClaim).toBeNull()
      })
    })
  })

  describe("renewClaim", () => {
    test("should renew claim for active message", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and claim message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Renew claim
        const renewed = await renewClaim(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(true)

        // Verify claim was extended
        const message = await QueueRepository.getById(client, "queue_test1")
        expect(message!.claimedUntil).toEqual(new Date(now.getTime() + 20000))
      })
    })

    test("should fail to renew with wrong claimedBy", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and claim message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const firstClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Try to renew with different worker
        const renewed = await renewClaim(client, {
          messageId: "queue_test1",
          claimedBy: "worker_2",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(false)
      })
    })

    test("should fail to renew completed message", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert, claim, and complete message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        await QueueRepository.complete(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          completedAt: now,
        })

        // Try to renew completed message
        const renewed = await renewClaim(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(false)
      })
    })
  })

  describe("complete", () => {
    test("should mark message as completed", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and claim message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Complete
        await QueueRepository.complete(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          completedAt: now,
        })

        // Verify completion
        const message = await QueueRepository.getById(client, "queue_test1")
        expect(message!.completedAt).toEqual(now)
        expect(message!.claimedBy).toBeNull()
        expect(message!.claimedUntil).toBeNull()
      })
    })

    test("should throw if wrong claimedBy", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and claim message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const firstClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Try to complete with different worker
        await expect(
          QueueRepository.complete(client, {
            messageId: "queue_test1",
            claimedBy: "worker_2",
            completedAt: now,
          })
        ).rejects.toThrow()
      })
    })
  })

  describe("fail", () => {
    test("should record failure and set retry backoff", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()
        const retryAfter = new Date(now.getTime() + 5000)

        // Insert and claim message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Fail
        await QueueRepository.fail(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          error: "test error",
          processAfter: retryAfter,
          now,
        })

        // Verify failure recorded
        const message = await QueueRepository.getById(client, "queue_test1")
        expect(message!.failedCount).toBe(1)
        expect(message!.lastError).toBe("test error")
        expect(message!.processAfter).toEqual(retryAfter)
        expect(message!.claimedBy).toBeNull()
        expect(message!.claimedUntil).toBeNull()
      })
    })

    test("should increment failedCount on multiple failures", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Fail twice
        for (let i = 1; i <= 2; i++) {
          const claimed = await claimNext(client, {
            queueName: "test.queue",
            workspaceId: "ws_test",
            claimedBy: "worker_test",
            claimedAt: now,
            claimedUntil: new Date(now.getTime() + 10000),
            now,
          })

          await QueueRepository.fail(client, {
            messageId: claimed!.id,
            claimedBy: "worker_test",
            error: `error ${i}`,
            processAfter: now,
            now,
          })
        }

        // Verify failedCount
        const message = await QueueRepository.getById(client, "queue_test1")
        expect(message!.failedCount).toBe(2)
      })
    })
  })

  describe("failDlq", () => {
    test("should move message to DLQ", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and claim message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Move to DLQ
        await QueueRepository.failDlq(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          error: "fatal error",
          dlqAt: now,
        })

        // Verify DLQ
        const message = await QueueRepository.getById(client, "queue_test1")
        expect(message!.dlqAt).toEqual(now)
        expect(message!.lastError).toBe("fatal error")
        expect(message!.claimedBy).toBeNull()
        expect(message!.claimedUntil).toBeNull()
      })
    })
  })

  describe("unDlq", () => {
    test("should remove message from DLQ and reset for retry", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert, claim, and move to DLQ
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        await QueueRepository.failDlq(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          error: "fatal error",
          dlqAt: now,
        })

        // Un-DLQ
        await QueueRepository.unDlq(client, {
          messageId: "queue_test1",
          processAfter: now,
        })

        // Verify removed from DLQ
        const message = await QueueRepository.getById(client, "queue_test1")
        expect(message!.dlqAt).toBeNull()
        expect(message!.failedCount).toBe(0)
        expect(message!.lastError).toBeNull()
        expect(message!.processAfter).toEqual(now)
      })
    })
  })

  describe("batchClaimMessages", () => {
    test("should batch claim multiple messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 5 messages
        for (let i = 1; i <= 5; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Batch claim 3 messages
        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 3,
        })

        // Don't assert specific order since parallel processing makes order non-deterministic
        expect(claimed.length).toBe(3)
        expect(claimed.every((m) => m.claimedBy === "worker_test")).toBe(true)
        expect(claimed.every((m) => m.claimedCount === 1)).toBe(true)

        // Verify the claimed messages are distinct
        const claimedIds = claimed.map((m) => m.id)
        expect(new Set(claimedIds).size).toBe(3) // No duplicates
      })
    })

    test("should return empty array if no messages available", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(claimed.length).toBe(0)
      })
    })

    test("should return fewer messages than limit if not enough available", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 2 messages
        for (let i = 1; i <= 2; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Request 10 but only 2 available
        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(claimed.length).toBe(2)
      })
    })

    test("should claim all ready messages regardless of insert order", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert messages with different processAfter timestamps
        const messageIds = ["queue_old", "queue_middle", "queue_recent"]
        await QueueRepository.insert(client, {
          id: "queue_old",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: new Date(now.getTime() - 1000),
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_middle",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 2 },
          processAfter: new Date(now.getTime() - 500),
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_recent",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 3 },
          processAfter: now,
          insertedAt: now,
        })

        // Batch claim - all are ready
        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        // Should get all 3 (order doesn't matter for parallel processing)
        expect(claimed.length).toBe(3)
        const claimedIds = claimed.map((m) => m.id).sort()
        expect(claimedIds).toEqual(messageIds.sort())
      })
    })

    test("should skip messages not ready yet (processAfter > now)", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 2 ready, 1 future
        await QueueRepository.insert(client, {
          id: "queue_ready1",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_future",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 2 },
          processAfter: new Date(now.getTime() + 60000), // Future
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_ready2",
          queueName: "test.queue",
          workspaceId: "ws_test",
          payload: { order: 3 },
          processAfter: now,
          insertedAt: now,
        })

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(claimed.length).toBe(2)
        expect(claimed.some((m) => m.id === "queue_future")).toBe(false)
      })
    })

    test("should skip messages with active claims", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 3 messages
        for (let i = 1; i <= 3; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Worker 1 claims one message
        const firstClaim = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Worker 2 batch claims (should skip the one worker 1 has)
        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(claimed.length).toBe(2)
        expect(claimed.some((m) => m.id === firstClaim!.id)).toBe(false)
        expect(claimed.every((m) => m.claimedBy === "worker_2")).toBe(true)
      })
    })

    test("should reclaim messages with expired claims", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 2 messages
        for (let i = 1; i <= 2; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Claim with expired claimedUntil
        await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() - 1000), // Already expired
          now,
          limit: 10,
        })

        // Should be able to reclaim
        const reclaimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(reclaimed.length).toBe(2)
        expect(reclaimed.every((m) => m.claimedBy === "worker_2")).toBe(true)
        expect(reclaimed.every((m) => m.claimedCount === 2)).toBe(true) // Incremented on reclaim
      })
    })

    test("should skip completed messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 3 messages
        for (let i = 1; i <= 3; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Claim and complete first message
        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        await QueueRepository.complete(client, {
          messageId: claimed!.id,
          claimedBy: "worker_1",
          completedAt: now,
        })

        // Batch claim (should not get completed message)
        const batchClaimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(batchClaimed.length).toBe(2)
        expect(batchClaimed.some((m) => m.id === claimed!.id)).toBe(false)
      })
    })

    test("should skip DLQ messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 3 messages
        for (let i = 1; i <= 3; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Claim and DLQ first message
        const claimed = await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        await QueueRepository.failDlq(client, {
          messageId: claimed!.id,
          claimedBy: "worker_1",
          error: "test error",
          dlqAt: now,
        })

        // Batch claim (should not get DLQ message)
        const batchClaimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        expect(batchClaimed.length).toBe(2)
        expect(batchClaimed.some((m) => m.id === claimed!.id)).toBe(false)
      })
    })
  })

  describe("batchRenewClaims", () => {
    test("should batch renew claims for all messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and batch claim 3 messages
        for (let i = 1; i <= 3; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        const messageIds = claimed.map((m) => m.id)

        // Batch renew all claims
        const renewed = await QueueRepository.batchRenewClaims(client, {
          messageIds,
          claimedBy: "worker_test",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(3)

        // Verify all claims were extended
        for (const id of messageIds) {
          const message = await QueueRepository.getById(client, id)
          expect(message!.claimedUntil).toEqual(new Date(now.getTime() + 20000))
        }
      })
    })

    test("should support partial success - skip completed messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and batch claim 3 messages
        for (let i = 1; i <= 3; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        const messageIds = claimed.map((m) => m.id)

        // Complete first message (simulating concurrent processing)
        await QueueRepository.complete(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          completedAt: now,
        })

        // Batch renew - should only renew the 2 remaining
        const renewed = await QueueRepository.batchRenewClaims(client, {
          messageIds,
          claimedBy: "worker_test",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(2) // Only 2 renewed (1 was completed)

        // Verify completed message not renewed
        const completedMsg = await QueueRepository.getById(client, "queue_test1")
        expect(completedMsg!.claimedUntil).toBeNull() // Still null (completed messages clear claimedUntil)
      })
    })

    test("should support partial success - skip DLQ messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and batch claim 3 messages
        for (let i = 1; i <= 3; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
        })

        const messageIds = claimed.map((m) => m.id)

        // Move first message to DLQ
        await QueueRepository.failDlq(client, {
          messageId: "queue_test1",
          claimedBy: "worker_test",
          error: "fatal error",
          dlqAt: now,
        })

        // Batch renew - should only renew the 2 remaining
        const renewed = await QueueRepository.batchRenewClaims(client, {
          messageIds,
          claimedBy: "worker_test",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(2) // Only 2 renewed (1 in DLQ)
      })
    })

    test("should verify claimedBy - only renew messages owned by worker", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert 2 messages
        for (let i = 1; i <= 2; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Worker 1 claims first message
        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_1",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Worker 2 claims second message
        await claimNext(client, {
          queueName: "test.queue",
          workspaceId: "ws_test",
          claimedBy: "worker_2",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
        })

        // Worker 1 tries to renew both (should only renew their own)
        const renewed = await QueueRepository.batchRenewClaims(client, {
          messageIds: ["queue_test1", "queue_test2"],
          claimedBy: "worker_1",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(1) // Only renewed their own message
      })
    })

    test("should return 0 if no messages renewed", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Try to renew non-existent messages
        const renewed = await QueueRepository.batchRenewClaims(client, {
          messageIds: ["queue_fake1", "queue_fake2"],
          claimedBy: "worker_test",
          claimedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(0)
      })
    })
  })
})
