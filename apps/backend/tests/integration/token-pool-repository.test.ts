import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { QueueRepository, TokenPoolRepository } from "../../src/lib/queue"
import { setupTestDatabase, withTestTransaction } from "./setup"

describe("TokenPoolRepository", () => {
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

  describe("batchLeaseTokens", () => {
    test("should lease tokens for available (queue, workspace) pairs", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert messages for different (queue, workspace) pairs
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_test2",
          queueName: "test.queue",
          workspaceId: "ws_test2",
          payload: { order: 2 },
          processAfter: now,
          insertedAt: now,
        })

        // Lease tokens
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(2)
        expect(tokens[0].queueName).toBe("test.queue")
        expect(tokens[0].leasedBy).toBe("ticker_test")
        expect(tokens[1].queueName).toBe("test.queue")
      })
    })

    test("should return empty array if no work available", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(0)
      })
    })

    test("should exclude pairs that already have active tokens", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Lease first batch
        const firstBatch = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_1",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(firstBatch.length).toBe(1)

        // Try to lease again (should skip pairs with active tokens)
        const secondBatch = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_2",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(secondBatch.length).toBe(0)
      })
    })

    test("should allow leasing after tokens expire", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Lease with expired token
        await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_1",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() - 1000), // Already expired
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Should be able to lease again
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_2",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(1)
      })
    })

    test("should respect limit parameter", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert messages for 5 different workspaces
        for (let i = 1; i <= 5; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test${i}`,
            queueName: "test.queue",
            workspaceId: `ws_test${i}`,
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Lease with limit=3
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 3,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(3)
      })
    })

    test("should prioritize earliest process_after (fairness)", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert messages with different process_after times
        // ws_test3 has earliest message
        await QueueRepository.insert(client, {
          id: "queue_test3",
          queueName: "test.queue",
          workspaceId: "ws_test3",
          payload: { order: 3 },
          processAfter: new Date(now.getTime() - 3000), // Oldest
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: new Date(now.getTime() - 1000), // Newest
          insertedAt: now,
        })

        await QueueRepository.insert(client, {
          id: "queue_test2",
          queueName: "test.queue",
          workspaceId: "ws_test2",
          payload: { order: 2 },
          processAfter: new Date(now.getTime() - 2000), // Middle
          insertedAt: now,
        })

        // Lease tokens
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(3)

        // Should be ordered by earliest process_after
        expect(tokens[0].workspaceId).toBe("ws_test3")
        expect(tokens[1].workspaceId).toBe("ws_test2")
        expect(tokens[2].workspaceId).toBe("ws_test1")
      })
    })

    test("should only include messages ready to process (processAfter <= now)", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message ready now
        await QueueRepository.insert(client, {
          id: "queue_ready",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Insert message scheduled for future
        await QueueRepository.insert(client, {
          id: "queue_future",
          queueName: "test.queue",
          workspaceId: "ws_test2",
          payload: { order: 2 },
          processAfter: new Date(now.getTime() + 60000), // 1 minute future
          insertedAt: now,
        })

        // Lease tokens
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Should only get token for ready message
        expect(tokens.length).toBe(1)
        expect(tokens[0].workspaceId).toBe("ws_test1")
      })
    })

    test("should exclude completed messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and complete message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test1",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 1,
        })

        await QueueRepository.complete(client, {
          messageId: claimed[0].id,
          claimedBy: "worker_test",
          completedAt: now,
        })

        // Lease tokens
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(0)
      })
    })

    test("should exclude DLQ messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert and move to DLQ
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const claimed = await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test1",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 1,
        })

        await QueueRepository.failDlq(client, {
          messageId: claimed[0].id,
          claimedBy: "worker_test",
          error: "test error",
          dlqAt: now,
        })

        // Lease tokens
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(0)
      })
    })

    test("should exclude cancelled messages (fairness=workspace)", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Cancelled row kept leasable on every other axis (process_after <= now,
        // no claim) so the exclusion is proven to come from cancelled_at alone.
        await QueueRepository.insert(client, {
          id: "queue_test_cancelled",
          queueName: "test.queue",
          workspaceId: "ws_test_cancelled",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })
        await client.query("UPDATE queue_messages SET cancelled_at = $1 WHERE id = $2", [now, "queue_test_cancelled"])

        // Identical non-cancelled row on a different pair.
        await QueueRepository.insert(client, {
          id: "queue_test_live",
          queueName: "test.queue",
          workspaceId: "ws_test_live",
          payload: { order: 2 },
          processAfter: now,
          insertedAt: now,
        })

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.map((t) => t.workspaceId)).toEqual(["ws_test_live"])
      })
    })

    test("should exclude cancelled messages (fairness=none)", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        await QueueRepository.insert(client, {
          id: "queue_test_cancelled",
          queueName: "test.queue",
          workspaceId: "ws_test_cancelled",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })
        await client.query("UPDATE queue_messages SET cancelled_at = $1 WHERE id = $2", [now, "queue_test_cancelled"])

        await QueueRepository.insert(client, {
          id: "queue_test_live",
          queueName: "test.queue",
          workspaceId: "ws_test_live",
          payload: { order: 2 },
          processAfter: now,
          insertedAt: now,
        })

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
          fairnessMode: "none",
        })

        expect(tokens.map((t) => t.workspaceId)).toEqual(["ws_test_live"])
      })
    })

    test("fairness=none allows multiple concurrent tokens per (queue, workspace) pair", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Single workspace with 5 pending messages on the same queue.
        for (let i = 1; i <= 5; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test_single_${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test_single",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 3,
          queueNames: ["test.queue"],
          fairnessMode: "none",
        })

        // Under fairness=none the workspace can hold up to the requested
        // limit of concurrent tokens for the same queue (versus a single
        // token under workspace fairness).
        expect(tokens.length).toBe(3)
        for (const token of tokens) {
          expect(token.workspaceId).toBe("ws_test_single")
          expect(token.queueName).toBe("test.queue")
        }
      })
    })

    test("fairness=none is capped by pending message count per pair", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Only 2 pending messages but limit=5.
        for (let i = 1; i <= 2; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test_small_${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test_small",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 5,
          queueNames: ["test.queue"],
          fairnessMode: "none",
        })

        // Shouldn't over-allocate tokens beyond what there's work for.
        expect(tokens.length).toBe(2)
      })
    })

    test("fairness=workspace (default) preserves per-pair exclusion", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        for (let i = 1; i <= 5; i++) {
          await QueueRepository.insert(client, {
            id: `queue_test_default_${i}`,
            queueName: "test.queue",
            workspaceId: "ws_test_default",
            payload: { order: i },
            processAfter: now,
            insertedAt: now,
          })
        }

        // Default fairness mode is "workspace" — only one concurrent token
        // per (queue, workspace) pair even when limit would allow more.
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 5,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(1)
      })
    })

    test("should include messages with expired claims", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Claim with expired claim
        await QueueRepository.batchClaimMessages(client, {
          queueName: "test.queue",
          workspaceId: "ws_test1",
          claimedBy: "worker_test",
          claimedAt: now,
          claimedUntil: new Date(now.getTime() - 1000), // Already expired
          now,
          limit: 1,
        })

        // Lease tokens (should include message with expired claim)
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(tokens.length).toBe(1)
      })
    })
  })

  describe("renewLease", () => {
    test("should renew lease for active token", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message and lease token
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Renew lease
        const renewed = await TokenPoolRepository.renewLease(client, {
          tokenId: tokens[0].id,
          leasedBy: "ticker_test",
          leasedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(true)

        // Verify lease extended
        const token = await TokenPoolRepository.getById(client, tokens[0].id)
        expect(token!.leasedUntil).toEqual(new Date(now.getTime() + 20000))
      })
    })

    test("should fail to renew with wrong leasedBy", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message and lease token
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_1",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Try to renew with different leasedBy
        const renewed = await TokenPoolRepository.renewLease(client, {
          tokenId: tokens[0].id,
          leasedBy: "ticker_2",
          leasedUntil: new Date(now.getTime() + 20000),
        })

        expect(renewed).toBe(false)
      })
    })
  })

  describe("deleteToken", () => {
    test("should delete token", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message and lease token
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Delete token
        await TokenPoolRepository.deleteToken(client, {
          tokenId: tokens[0].id,
          leasedBy: "ticker_test",
        })

        // Verify deleted
        const token = await TokenPoolRepository.getById(client, tokens[0].id)
        expect(token).toBeNull()
      })
    })

    test("should throw if wrong leasedBy", async () => {
      await withTestTransaction(pool, async (client) => {
        const now = new Date()

        // Insert message and lease token
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_1",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000),
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Try to delete with different leasedBy
        await expect(
          TokenPoolRepository.deleteToken(client, {
            tokenId: tokens[0].id,
            leasedBy: "ticker_2",
          })
        ).rejects.toThrow()
      })
    })
  })

  describe("deleteExpiredTokens", () => {
    test("should delete expired tokens", async () => {
      await withTestTransaction(pool, async (client) => {
        await client.query("DELETE FROM queue_tokens")

        const now = new Date()
        const pastTime = new Date(now.getTime() - 10000)

        // Insert messages
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: pastTime,
          insertedAt: pastTime,
        })

        await QueueRepository.insert(client, {
          id: "queue_test2",
          queueName: "test.queue",
          workspaceId: "ws_test2",
          payload: { order: 2 },
          processAfter: pastTime,
          insertedAt: pastTime,
        })

        // Lease tokens at past time
        const allTokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: pastTime,
          leasedUntil: new Date(pastTime.getTime() + 5000), // Expired relative to now
          now: pastTime,
          limit: 10,
          queueNames: ["test.queue"],
        })

        expect(allTokens.length).toBe(2)

        // Delete expired tokens
        const deleted = await TokenPoolRepository.deleteExpiredTokens(client, {
          now,
        })

        expect(deleted).toBe(2)

        // Verify all tokens deleted
        const token1 = await TokenPoolRepository.getById(client, allTokens[0].id)
        const token2 = await TokenPoolRepository.getById(client, allTokens[1].id)

        expect(token1).toBeNull()
        expect(token2).toBeNull()
      })
    })

    test("should not delete non-expired tokens", async () => {
      await withTestTransaction(pool, async (client) => {
        await client.query("DELETE FROM queue_tokens")

        const now = new Date()

        // Insert message
        await QueueRepository.insert(client, {
          id: "queue_test1",
          queueName: "test.queue",
          workspaceId: "ws_test1",
          payload: { order: 1 },
          processAfter: now,
          insertedAt: now,
        })

        // Lease token with future expiry
        const tokens = await TokenPoolRepository.batchLeaseTokens(client, {
          leasedBy: "ticker_test",
          leasedAt: now,
          leasedUntil: new Date(now.getTime() + 10000), // Not expired
          now,
          limit: 10,
          queueNames: ["test.queue"],
        })

        // Delete expired tokens
        const deleted = await TokenPoolRepository.deleteExpiredTokens(client, {
          now,
        })

        expect(deleted).toBe(0)

        // Verify token still exists
        const token = await TokenPoolRepository.getById(client, tokens[0].id)
        expect(token).not.toBeNull()
      })
    })
  })
})
