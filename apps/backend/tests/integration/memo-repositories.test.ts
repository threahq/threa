/**
 * Memo Repositories Integration Tests
 *
 * Tests verify:
 * 1. PendingItemRepository: queue/dedupe/markProcessed behavior
 * 2. StreamStateRepository: debounce logic (cap/quiet intervals)
 * 3. MemoRepository: basic CRUD operations
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { ConversationRepository } from "../../src/features/conversations"
import { PendingItemRepository } from "../../src/features/memos"
import { StreamStateRepository } from "../../src/features/streams"
import { MemoRepository } from "../../src/features/memos"
import { setupTestDatabase } from "./setup"
import { userId, workspaceId, streamId, memoId, pendingItemId, conversationId } from "../../src/lib/id"

describe("Memo Repositories", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Test Workspace",
        slug: `memo-test-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("PendingItemRepository", () => {
    describe("queue", () => {
      test("queues new pending items", async () => {
        const itemId = `msg_${Date.now()}`
        const pendingId = pendingItemId()

        const result = await withTransaction(pool, async (client) => {
          return PendingItemRepository.queue(client, [
            {
              id: pendingId,
              workspaceId: testWorkspaceId,
              streamId: testStreamId,
              itemType: "message",
              itemId,
            },
          ])
        })

        expect(result.length).toBe(1)
        expect(result[0].itemId).toBe(itemId)
        expect(result[0].itemType).toBe("message")
        expect(result[0].processedAt).toBeNull()
      })

      test("deduplicates items by workspace/type/itemId", async () => {
        const itemId = `msg_dedupe_${Date.now()}`

        await withTransaction(pool, async (client) => {
          await PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: testStreamId,
              itemType: "message",
              itemId,
            },
          ])
        })

        // Queue same item again - should not create duplicate
        const secondQueue = await withTransaction(pool, async (client) => {
          return PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: testStreamId,
              itemType: "message",
              itemId,
            },
          ])
        })

        // Returns empty because ON CONFLICT does nothing for unprocessed items
        expect(secondQueue.length).toBe(0)

        // Verify only one exists
        const count = await withTransaction(pool, async (client) => {
          return PendingItemRepository.countUnprocessed(client, testWorkspaceId, testStreamId)
        })

        // Count should include this item (exact count depends on other tests, but at least 1)
        expect(count).toBeGreaterThanOrEqual(1)
      })

      test("allows re-queue after item is processed", async () => {
        const itemId = `msg_requeue_${Date.now()}`
        const firstId = pendingItemId()

        // Queue and process
        await withTransaction(pool, async (client) => {
          await PendingItemRepository.queue(client, [
            {
              id: firstId,
              workspaceId: testWorkspaceId,
              streamId: testStreamId,
              itemType: "message",
              itemId,
            },
          ])
          await PendingItemRepository.markProcessed(client, [firstId])
        })

        // Queue same item again - should work since previous was processed
        const result = await withTransaction(pool, async (client) => {
          return PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: testStreamId,
              itemType: "message",
              itemId,
            },
          ])
        })

        expect(result.length).toBe(1)
        expect(result[0].itemId).toBe(itemId)
        expect(result[0].processedAt).toBeNull()
      })
    })

    describe("findUnprocessed", () => {
      test("returns only unprocessed items for stream", async () => {
        const localStreamId = streamId()
        const unprocessedItemId = `msg_unproc_${Date.now()}`
        const processedItemId = `msg_proc_${Date.now()}`
        const processedPendingId = pendingItemId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          await PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: localStreamId,
              itemType: "message",
              itemId: unprocessedItemId,
            },
            {
              id: processedPendingId,
              workspaceId: testWorkspaceId,
              streamId: localStreamId,
              itemType: "message",
              itemId: processedItemId,
            },
          ])

          await PendingItemRepository.markProcessed(client, [processedPendingId])
        })

        const unprocessed = await withTransaction(pool, async (client) => {
          return PendingItemRepository.findUnprocessed(client, testWorkspaceId, localStreamId)
        })

        expect(unprocessed.some((i) => i.itemId === unprocessedItemId)).toBe(true)
        expect(unprocessed.some((i) => i.itemId === processedItemId)).toBe(false)
      })

      test("respects limit parameter", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          // Queue 5 items
          const items = Array.from({ length: 5 }, (_, i) => ({
            id: pendingItemId(),
            workspaceId: testWorkspaceId,
            streamId: localStreamId,
            itemType: "message" as const,
            itemId: `msg_limit_${Date.now()}_${i}`,
          }))
          await PendingItemRepository.queue(client, items)
        })

        const limited = await withTransaction(pool, async (client) => {
          return PendingItemRepository.findUnprocessed(client, testWorkspaceId, localStreamId, {
            limit: 3,
          })
        })

        expect(limited.length).toBe(3)
      })
    })

    describe("markProcessed", () => {
      test("marks items as processed with timestamp", async () => {
        const itemId = `msg_mark_${Date.now()}`
        const pendingId = pendingItemId()

        await withTransaction(pool, async (client) => {
          await PendingItemRepository.queue(client, [
            {
              id: pendingId,
              workspaceId: testWorkspaceId,
              streamId: testStreamId,
              itemType: "message",
              itemId,
            },
          ])
        })

        const beforeProcess = await withTransaction(pool, async (client) => {
          return PendingItemRepository.findUnprocessed(client, testWorkspaceId, testStreamId)
        })
        expect(beforeProcess.some((i) => i.id === pendingId)).toBe(true)

        await withTransaction(pool, async (client) => {
          await PendingItemRepository.markProcessed(client, [pendingId])
        })

        const afterProcess = await withTransaction(pool, async (client) => {
          return PendingItemRepository.findUnprocessed(client, testWorkspaceId, testStreamId)
        })
        expect(afterProcess.some((i) => i.id === pendingId)).toBe(false)
      })
    })
  })

  describe("StreamStateRepository", () => {
    describe("upsertActivity", () => {
      test("creates stream state on first activity", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })
          await StreamStateRepository.upsertActivity(client, testWorkspaceId, localStreamId)
        })

        const state = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findByStream(client, testWorkspaceId, localStreamId)
        })

        expect(state).not.toBeNull()
        expect(state?.lastProcessedAt).toBeNull()
        expect(state?.lastActivityAt).toBeInstanceOf(Date)
      })

      test("updates lastActivityAt on subsequent calls", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })
          await StreamStateRepository.upsertActivity(client, testWorkspaceId, localStreamId)
        })

        const firstState = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findByStream(client, testWorkspaceId, localStreamId)
        })

        await new Promise((r) => setTimeout(r, 50))

        await withTransaction(pool, async (client) => {
          await StreamStateRepository.upsertActivity(client, testWorkspaceId, localStreamId)
        })

        const secondState = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findByStream(client, testWorkspaceId, localStreamId)
        })

        expect(secondState!.lastActivityAt.getTime()).toBeGreaterThan(firstState!.lastActivityAt.getTime())
      })
    })

    describe("markProcessed", () => {
      test("sets lastProcessedAt timestamp", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })
          await StreamStateRepository.markProcessed(client, testWorkspaceId, localStreamId)
        })

        const state = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findByStream(client, testWorkspaceId, localStreamId)
        })

        expect(state?.lastProcessedAt).toBeInstanceOf(Date)
      })
    })

    describe("findStreamsReadyToProcess (debounce logic)", () => {
      test("includes stream that was never processed", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          // Queue a pending item (required for stream to appear)
          await PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: localStreamId,
              itemType: "message",
              itemId: `msg_never_${Date.now()}`,
            },
          ])
        })

        const ready = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findStreamsReadyToProcess(client)
        })

        expect(ready.some((s) => s.streamId === localStreamId)).toBe(true)
      })

      test("excludes stream with recent processing and recent activity", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          // Mark as processed (simulates recent processing)
          await StreamStateRepository.markProcessed(client, testWorkspaceId, localStreamId)

          // Update activity (simulates recent message)
          await StreamStateRepository.upsertActivity(client, testWorkspaceId, localStreamId)

          // Queue a pending item
          await PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: localStreamId,
              itemType: "message",
              itemId: `msg_recent_${Date.now()}`,
            },
          ])
        })

        // Both lastProcessedAt and lastActivityAt are NOW(), so:
        // - Cap interval (5 min) NOT exceeded
        // - Quiet interval (30s) NOT exceeded
        // Therefore: NOT ready
        const ready = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findStreamsReadyToProcess(client)
        })

        expect(ready.some((s) => s.streamId === localStreamId)).toBe(false)
      })

      test("includes stream when quiet interval exceeded (activity stopped)", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          // Mark as just processed
          await StreamStateRepository.markProcessed(client, testWorkspaceId, localStreamId)

          // Set lastActivityAt to 2 seconds ago (use short interval for test)
          await client.query(
            `
            UPDATE memo_stream_state
            SET last_activity_at = NOW() - INTERVAL '2 seconds'
            WHERE workspace_id = $1 AND stream_id = $2
          `,
            [testWorkspaceId, localStreamId]
          )

          // Queue a pending item
          await PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: localStreamId,
              itemType: "message",
              itemId: `msg_quiet_${Date.now()}`,
            },
          ])
        })

        // Use 1-second quiet interval for test (activity was 2s ago)
        const ready = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findStreamsReadyToProcess(client, {
            quietIntervalSeconds: 1,
            capIntervalSeconds: 300,
          })
        })

        expect(ready.some((s) => s.streamId === localStreamId)).toBe(true)
      })

      test("includes stream when cap interval exceeded", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          // Set lastProcessedAt to 10 seconds ago (use short cap for test)
          await client.query(
            `
            INSERT INTO memo_stream_state (workspace_id, stream_id, last_processed_at, last_activity_at)
            VALUES ($1, $2, NOW() - INTERVAL '10 seconds', NOW())
            ON CONFLICT (workspace_id, stream_id) DO UPDATE
            SET last_processed_at = NOW() - INTERVAL '10 seconds',
                last_activity_at = NOW()
          `,
            [testWorkspaceId, localStreamId]
          )

          // Queue a pending item
          await PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: localStreamId,
              itemType: "message",
              itemId: `msg_cap_${Date.now()}`,
            },
          ])
        })

        // Use 5-second cap interval for test (processed 10s ago)
        const ready = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findStreamsReadyToProcess(client, {
            capIntervalSeconds: 5,
            quietIntervalSeconds: 300, // Long quiet so it doesn't trigger
          })
        })

        expect(ready.some((s) => s.streamId === localStreamId)).toBe(true)
      })

      test("excludes stream with no pending items", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          // Only create state, no pending items
          await StreamStateRepository.upsertActivity(client, testWorkspaceId, localStreamId)
        })

        const ready = await withTransaction(pool, async (client) => {
          return StreamStateRepository.findStreamsReadyToProcess(client)
        })

        expect(ready.some((s) => s.streamId === localStreamId)).toBe(false)
      })
    })
  })

  describe("MemoRepository", () => {
    describe("insert", () => {
      test("creates message memo with all fields", async () => {
        const id = memoId()
        const sourceMessageId = `msg_source_${Date.now()}`

        const memo = await withTransaction(pool, async (client) => {
          return MemoRepository.insert(client, {
            id,
            workspaceId: testWorkspaceId,
            memoType: "message",
            sourceMessageId,
            title: "Test Memo",
            abstract: "This is a test abstract for the memo.",
            keyPoints: ["Point 1", "Point 2"],
            sourceMessageIds: [sourceMessageId],
            participantIds: [testUserId],
            knowledgeType: "decision",
            tags: ["test", "memo"],
            status: "active",
          })
        })

        expect(memo.id).toBe(id)
        expect(memo.memoType).toBe("message")
        expect(memo.sourceMessageId).toBe(sourceMessageId)
        expect(memo.title).toBe("Test Memo")
        expect(memo.keyPoints).toEqual(["Point 1", "Point 2"])
        expect(memo.tags).toEqual(["test", "memo"])
        expect(memo.status).toBe("active")
      })

      test("creates conversation memo", async () => {
        const id = memoId()
        const sourceConvId = conversationId()

        await withTransaction(pool, async (client) => {
          await ConversationRepository.insert(client, {
            id: sourceConvId,
            streamId: testStreamId,
            workspaceId: testWorkspaceId,
          })
        })

        const memo = await withTransaction(pool, async (client) => {
          return MemoRepository.insert(client, {
            id,
            workspaceId: testWorkspaceId,
            memoType: "conversation",
            sourceConversationId: sourceConvId,
            title: "Conversation Memo",
            abstract: "Summary of the conversation.",
            keyPoints: [],
            sourceMessageIds: ["msg1", "msg2"],
            participantIds: [testUserId],
            knowledgeType: "learning",
            tags: [],
            status: "active",
          })
        })

        expect(memo.memoType).toBe("conversation")
        expect(memo.sourceConversationId).toBe(sourceConvId)
        expect(memo.sourceMessageId).toBeNull()
      })
    })

    describe("findById", () => {
      test("returns memo when exists", async () => {
        const id = memoId()

        await withTransaction(pool, async (client) => {
          await MemoRepository.insert(client, {
            id,
            workspaceId: testWorkspaceId,
            memoType: "message",
            sourceMessageId: `msg_find_${Date.now()}`,
            title: "Findable Memo",
            abstract: "Test abstract",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "context",
            tags: [],
            status: "active",
          })
        })

        const found = await withTransaction(pool, async (client) => {
          return MemoRepository.findById(client, id)
        })

        expect(found).not.toBeNull()
        expect(found?.id).toBe(id)
        expect(found?.title).toBe("Findable Memo")
      })

      test("returns null when not exists", async () => {
        const found = await withTransaction(pool, async (client) => {
          return MemoRepository.findById(client, "memo_nonexistent")
        })

        expect(found).toBeNull()
      })
    })

    describe("findActiveBySourceConversation", () => {
      test("returns all active memos for conversation", async () => {
        const firstId = memoId()
        const secondId = memoId()
        const convId = conversationId()

        await withTransaction(pool, async (client) => {
          await ConversationRepository.insert(client, {
            id: convId,
            streamId: testStreamId,
            workspaceId: testWorkspaceId,
          })

          for (const [id, title] of [
            [firstId, "First topic memo"],
            [secondId, "Second topic memo"],
          ] as const) {
            await MemoRepository.insert(client, {
              id,
              workspaceId: testWorkspaceId,
              memoType: "conversation",
              sourceConversationId: convId,
              title,
              abstract: "Test abstract",
              keyPoints: [],
              sourceMessageIds: [],
              participantIds: [],
              knowledgeType: "decision",
              tags: [],
              status: "active",
            })
          }
        })

        const found = await withTransaction(pool, async (client) => {
          return MemoRepository.findActiveBySourceConversation(client, convId)
        })

        expect(found.map((m) => m.id).sort()).toEqual([firstId, secondId].sort())
        expect(found.every((m) => m.status === "active")).toBe(true)
      })

      test("does not return superseded memos", async () => {
        const convId = conversationId()

        await withTransaction(pool, async (client) => {
          await ConversationRepository.insert(client, {
            id: convId,
            streamId: testStreamId,
            workspaceId: testWorkspaceId,
          })

          await MemoRepository.insert(client, {
            id: memoId(),
            workspaceId: testWorkspaceId,
            memoType: "conversation",
            sourceConversationId: convId,
            title: "Superseded Memo",
            abstract: "Old version",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "decision",
            tags: [],
            status: "superseded",
          })
        })

        const found = await withTransaction(pool, async (client) => {
          return MemoRepository.findActiveBySourceConversation(client, convId)
        })

        expect(found).toEqual([])
      })
    })

    describe("supersede", () => {
      test("marks memo as superseded with reason", async () => {
        const id = memoId()

        await withTransaction(pool, async (client) => {
          await MemoRepository.insert(client, {
            id,
            workspaceId: testWorkspaceId,
            memoType: "message",
            sourceMessageId: `msg_supersede_${Date.now()}`,
            title: "To Be Superseded",
            abstract: "Original content",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "context",
            tags: [],
            status: "active",
          })
        })

        const superseded = await withTransaction(pool, async (client) => {
          return MemoRepository.supersede(client, id, "New information available")
        })

        expect(superseded?.status).toBe("superseded")
        expect(superseded?.revisionReason).toBe("New information available")
      })
    })

    describe("getAllTags", () => {
      test("returns unique tags from all memos in workspace", async () => {
        const localWorkspaceId = workspaceId()
        const localStreamId = streamId()
        const localUserId = userId()
        let localMemberId = ""

        await withTransaction(pool, async (client) => {
          await WorkspaceRepository.insert(client, {
            id: localWorkspaceId,
            name: "Tags Test Workspace",
            slug: `tags-test-${localWorkspaceId}`,
            createdBy: localUserId,
          })
          localMemberId = (await addTestMember(client, localWorkspaceId, localUserId)).id
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: localWorkspaceId,
            type: "scratchpad",
            visibility: "private",
            companionMode: "off",
            createdBy: localMemberId,
          })

          await MemoRepository.insert(client, {
            id: memoId(),
            workspaceId: localWorkspaceId,
            memoType: "message",
            sourceMessageId: `msg_tags1_${Date.now()}`,
            title: "Memo with tags 1",
            abstract: "Abstract",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "decision",
            tags: ["architecture", "api"],
            status: "active",
          })

          await MemoRepository.insert(client, {
            id: memoId(),
            workspaceId: localWorkspaceId,
            memoType: "message",
            sourceMessageId: `msg_tags2_${Date.now()}`,
            title: "Memo with tags 2",
            abstract: "Abstract",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "learning",
            tags: ["api", "database"],
            status: "active",
          })
        })

        const tags = await withTransaction(pool, async (client) => {
          return MemoRepository.getAllTags(client, localWorkspaceId)
        })

        expect(tags).toContain("architecture")
        expect(tags).toContain("api")
        expect(tags).toContain("database")
        // "api" appears in both but should only appear once
        expect(tags.filter((t) => t === "api").length).toBe(1)
      })
    })

    describe("findByStream", () => {
      test("returns conversation memos ordered by createdAt descending", async () => {
        const localStreamId = streamId()
        const conv1Id = conversationId()
        const conv2Id = conversationId()
        const memo1Id = memoId()
        const memo2Id = memoId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          await ConversationRepository.insert(client, {
            id: conv1Id,
            streamId: localStreamId,
            workspaceId: testWorkspaceId,
          })

          await MemoRepository.insert(client, {
            id: memo1Id,
            workspaceId: testWorkspaceId,
            memoType: "conversation",
            sourceConversationId: conv1Id,
            title: "First Memo",
            abstract: "Created first",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "context",
            tags: [],
            status: "active",
          })
        })

        await new Promise((r) => setTimeout(r, 10))

        await withTransaction(pool, async (client) => {
          await ConversationRepository.insert(client, {
            id: conv2Id,
            streamId: localStreamId,
            workspaceId: testWorkspaceId,
          })

          await MemoRepository.insert(client, {
            id: memo2Id,
            workspaceId: testWorkspaceId,
            memoType: "conversation",
            sourceConversationId: conv2Id,
            title: "Second Memo",
            abstract: "Created second",
            keyPoints: [],
            sourceMessageIds: [],
            participantIds: [],
            knowledgeType: "context",
            tags: [],
            status: "active",
          })
        })

        const memos = await withTransaction(pool, async (client) => {
          return MemoRepository.findByStream(client, localStreamId, { status: "active" })
        })

        const memo1Index = memos.findIndex((m) => m.id === memo1Id)
        const memo2Index = memos.findIndex((m) => m.id === memo2Id)

        // memo2 should come first (more recent)
        expect(memo2Index).toBeLessThan(memo1Index)
      })

      test("respects limit parameter", async () => {
        const localStreamId = streamId()

        await withTransaction(pool, async (client) => {
          await StreamRepository.insert(client, {
            id: localStreamId,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })

          for (let i = 0; i < 5; i++) {
            const convId = conversationId()
            await ConversationRepository.insert(client, {
              id: convId,
              streamId: localStreamId,
              workspaceId: testWorkspaceId,
            })

            await MemoRepository.insert(client, {
              id: memoId(),
              workspaceId: testWorkspaceId,
              memoType: "conversation",
              sourceConversationId: convId,
              title: `Memo ${i}`,
              abstract: "Abstract",
              keyPoints: [],
              sourceMessageIds: [],
              participantIds: [],
              knowledgeType: "context",
              tags: [],
              status: "active",
            })
          }
        })

        const memos = await withTransaction(pool, async (client) => {
          return MemoRepository.findByStream(client, localStreamId, { limit: 3 })
        })

        expect(memos.length).toBe(3)
      })
    })
  })
})
