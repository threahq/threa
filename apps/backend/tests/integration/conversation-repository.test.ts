/**
 * Conversation Repository Integration Tests
 *
 * Tests verify:
 * 1. CRUD operations work correctly
 * 2. Message and participant associations live in the arrays on the
 *    conversations row; addPrimaryMessage / addSecondaryMessage / etc maintain them.
 * 3. Status filtering works
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository } from "../../src/features/memos"
import { sql } from "../../src/db"
import { setupTestDatabase, testMessageContent } from "./setup"
import { userId, workspaceId, streamId, messageId, conversationId, memoId } from "../../src/lib/id"
import { ConversationStatuses, type BoardLens } from "@threa/types"

describe("ConversationRepository", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    // Create shared test data
    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Test Workspace",
        slug: `test-ws-${testWorkspaceId}`,
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

  describe("insert", () => {
    test("creates conversation with minimal fields", async () => {
      const convId = conversationId()

      const conversation = await withTransaction(pool, async (client) => {
        return ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
      })

      expect(conversation.id).toBe(convId)
      expect(conversation.streamId).toBe(testStreamId)
      expect(conversation.workspaceId).toBe(testWorkspaceId)
      expect(conversation.messageIds).toEqual([])
      expect(conversation.participantIds).toEqual([])
      expect(conversation.topicSummary).toBeNull()
      expect(conversation.completenessScore).toBe(1)
      expect(conversation.confidence).toBe(0.5)
      expect(conversation.status).toBe(ConversationStatuses.ACTIVE)
      expect(conversation.parentConversationId).toBeNull()
    })

    test("creates conversation with all fields and derives messageIds/participantIds from assignments", async () => {
      const convId = conversationId()
      const msgId = messageId()

      const conversation = await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Test message"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Discussion about testing",
          completenessScore: 3,
          confidence: 0.85,
          status: ConversationStatuses.ACTIVE,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)

        return ConversationRepository.findById(client, convId)
      })

      expect(conversation?.id).toBe(convId)
      expect(conversation?.messageIds).toEqual([msgId])
      expect(conversation?.participantIds).toEqual([testUserId])
      expect(conversation?.topicSummary).toBe("Discussion about testing")
      expect(conversation?.completenessScore).toBe(3)
      expect(conversation?.confidence).toBe(0.85)
      expect(conversation?.status).toBe(ConversationStatuses.ACTIVE)
    })
  })

  describe("findById", () => {
    test("returns conversation when exists", async () => {
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Findable conversation",
        })
      })

      const found = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, convId)
      })

      expect(found).not.toBeNull()
      expect(found?.id).toBe(convId)
      expect(found?.topicSummary).toBe("Findable conversation")
    })

    test("returns null when not exists", async () => {
      const found = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, "conv_nonexistent")
      })

      expect(found).toBeNull()
    })
  })

  describe("findByStream", () => {
    test("returns conversations for stream ordered by last activity", async () => {
      const localStreamId = streamId()
      const conv1Id = conversationId()
      const conv2Id = conversationId()

      // Create stream first
      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })
      })

      // Insert conversations in separate transactions so NOW() gives different times
      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: conv1Id,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "First conversation",
        })
      })

      // Small delay between transactions
      await new Promise((r) => setTimeout(r, 10))

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: conv2Id,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Second conversation",
        })
      })

      const conversations = await withTransaction(pool, async (client) => {
        return ConversationRepository.findByStream(client, localStreamId)
      })

      expect(conversations.length).toBeGreaterThanOrEqual(2)
      // Most recent first (conv2 should appear before conv1)
      const conv2Index = conversations.findIndex((c) => c.id === conv2Id)
      const conv1Index = conversations.findIndex((c) => c.id === conv1Id)
      expect(conv2Index).toBeLessThan(conv1Index)
    })

    test("filters by status when provided", async () => {
      const localStreamId = streamId()
      const activeConvId = conversationId()
      const stalledConvId = conversationId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await ConversationRepository.insert(client, {
          id: activeConvId,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
          status: ConversationStatuses.ACTIVE,
        })

        await ConversationRepository.insert(client, {
          id: stalledConvId,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
          status: ConversationStatuses.STALLED,
        })
      })

      const activeConversations = await withTransaction(pool, async (client) => {
        return ConversationRepository.findByStream(client, localStreamId, {
          status: ConversationStatuses.ACTIVE,
        })
      })

      expect(activeConversations.every((c) => c.status === ConversationStatuses.ACTIVE)).toBe(true)
      expect(activeConversations.some((c) => c.id === activeConvId)).toBe(true)
      expect(activeConversations.some((c) => c.id === stalledConvId)).toBe(false)
    })
  })

  describe("findActiveByStream", () => {
    test("returns only active conversations", async () => {
      const localStreamId = streamId()
      const activeConvId = conversationId()
      const resolvedConvId = conversationId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await ConversationRepository.insert(client, {
          id: activeConvId,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
          status: ConversationStatuses.ACTIVE,
        })

        await ConversationRepository.insert(client, {
          id: resolvedConvId,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
          status: ConversationStatuses.RESOLVED,
        })
      })

      const conversations = await withTransaction(pool, async (client) => {
        return ConversationRepository.findActiveByStream(client, localStreamId)
      })

      expect(conversations.every((c) => c.status === ConversationStatuses.ACTIVE)).toBe(true)
      expect(conversations.some((c) => c.id === activeConvId)).toBe(true)
      expect(conversations.some((c) => c.id === resolvedConvId)).toBe(false)
    })
  })

  describe("findByMessageId", () => {
    test("returns conversations containing the message", async () => {
      const msgId = messageId()
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(100),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Message in conversation"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)
      })

      const conversations = await withTransaction(pool, async (client) => {
        return ConversationRepository.findByMessageId(client, testWorkspaceId, msgId)
      })

      expect(conversations.some((c) => c.id === convId)).toBe(true)
    })

    test("returns empty array when message not in any conversation", async () => {
      const conversations = await withTransaction(pool, async (client) => {
        return ConversationRepository.findByMessageId(client, testWorkspaceId, "msg_orphan")
      })

      expect(conversations).toEqual([])
    })
  })

  describe("findByWorkspace", () => {
    test("returns conversations for workspace", async () => {
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Workspace conversation",
        })
      })

      const conversations = await withTransaction(pool, async (client) => {
        return ConversationRepository.findByWorkspace(client, testWorkspaceId)
      })

      expect(conversations.some((c) => c.id === convId)).toBe(true)
    })
  })

  describe("findByWorkspaceForViewer — board lenses", () => {
    // A public channel so the viewer reads these without a stream_members row
    // (INV-62), keeping the lens filter — not access — the thing under test.
    let lensStreamId: string
    let activeConv: string
    let stalledConv: string
    let idleIncompleteConv: string
    let idleCompleteConv: string
    let resolvedIdleConv: string
    let decisionConv: string
    let archivedMemoConv: string
    let seq = 1

    async function seedConversation(
      client: Parameters<typeof ConversationRepository.insert>[0],
      opts: { status?: (typeof ConversationStatuses)[keyof typeof ConversationStatuses]; completenessScore?: number }
    ): Promise<string> {
      const convId = conversationId()
      const msgId = messageId()
      await MessageRepository.insert(client, {
        id: msgId,
        streamId: lensStreamId,
        sequence: BigInt(seq++),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Lens message"),
      })
      await ConversationRepository.insert(client, {
        id: convId,
        streamId: lensStreamId,
        workspaceId: testWorkspaceId,
        status: opts.status,
        completenessScore: opts.completenessScore,
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)
      return convId
    }

    beforeAll(async () => {
      lensStreamId = streamId()
      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: lensStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })
        activeConv = await seedConversation(client, { status: ConversationStatuses.ACTIVE, completenessScore: 5 })
        stalledConv = await seedConversation(client, { status: ConversationStatuses.STALLED, completenessScore: 5 })
        idleIncompleteConv = await seedConversation(client, {
          status: ConversationStatuses.ACTIVE,
          completenessScore: 2,
        })
        idleCompleteConv = await seedConversation(client, { status: ConversationStatuses.ACTIVE, completenessScore: 7 })
        // Resolved but idle + low-score: done, so it must NOT read as a loose end.
        resolvedIdleConv = await seedConversation(client, {
          status: ConversationStatuses.RESOLVED,
          completenessScore: 2,
        })
        decisionConv = await seedConversation(client, { status: ConversationStatuses.ACTIVE, completenessScore: 5 })
        archivedMemoConv = await seedConversation(client, { status: ConversationStatuses.ACTIVE, completenessScore: 5 })

        // A captured memo makes decisionConv a member of the Decisions lens.
        await MemoRepository.insert(client, {
          id: memoId(),
          workspaceId: testWorkspaceId,
          memoType: "conversation",
          sourceConversationId: decisionConv,
          title: "A decision",
          abstract: "What got settled.",
          keyPoints: [],
          sourceMessageIds: [],
          participantIds: [testUserId],
          knowledgeType: "decision",
          tags: [],
          status: "active",
        })
        // An archived memo is no longer captured knowledge — its conversation must
        // drop off the Decisions lens.
        await MemoRepository.insert(client, {
          id: memoId(),
          workspaceId: testWorkspaceId,
          memoType: "conversation",
          sourceConversationId: archivedMemoConv,
          title: "An archived note",
          abstract: "No longer active.",
          keyPoints: [],
          sourceMessageIds: [],
          participantIds: [testUserId],
          knowledgeType: "decision",
          tags: [],
          status: "archived",
        })
      })
      // Backdate the "idle" conversations past the staleness window; the fresh ones
      // keep their insert-time `last_activity_at` (≈ now).
      await pool.query(`UPDATE conversations SET last_activity_at = NOW() - INTERVAL '20 hours' WHERE id = ANY($1)`, [
        [idleIncompleteConv, idleCompleteConv, resolvedIdleConv],
      ])
    })

    test("all lens (and no lens) surfaces every readable conversation regardless of state", async () => {
      for (const lens of ["all", undefined] as const) {
        const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
          lens,
          limit: 100,
        })
        const ids = new Set(rows.map((r) => r.id))
        for (const id of [
          activeConv,
          stalledConv,
          idleIncompleteConv,
          idleCompleteConv,
          resolvedIdleConv,
          decisionConv,
        ]) {
          expect(ids.has(id)).toBe(true)
        }
      }
    })

    // A saved board view created before the status/decisions lenses were retired
    // still holds `base_lens = 'active'` / `'decisions'`. Those must degrade to `all`
    // (same rows, no filter, no throw), never to an empty board.
    test("a retired lens value still stored on a saved view returns exactly the `all` rows", async () => {
      const all = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        lens: "all",
        limit: 100,
      })
      for (const retired of ["active", "needs-resolution", "decisions"] as unknown as BoardLens[]) {
        const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
          lens: retired,
          limit: 100,
        })
        expect(rows.map((r) => r.id)).toEqual(all.map((r) => r.id))
      }
    })

    test("mine lens keeps only the viewer's own conversations", async () => {
      const all = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        lens: "all",
        limit: 100,
      })
      const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        lens: "mine",
        limit: 100,
      })
      const ids = new Set(rows.map((r) => r.id))
      // Every seeded conversation lists the test user as a participant.
      for (const id of [activeConv, stalledConv, decisionConv]) expect(ids.has(id)).toBe(true)

      const stranger = await ConversationRepository.findByWorkspaceForViewer(
        pool,
        testWorkspaceId,
        "usr_not_a_member",
        {
          lens: "mine",
          limit: 100,
        }
      )
      expect(stranger.map((r) => r.id)).toEqual([])
      // The stranger CAN read the public channel — `mine` is what empties it, not access.
      const strangerAll = await ConversationRepository.findByWorkspaceForViewer(
        pool,
        testWorkspaceId,
        "usr_not_a_member",
        { lens: "all", limit: 100 }
      )
      expect(strangerAll.map((r) => r.id)).toEqual(all.map((r) => r.id))
    })
  })

  describe("findByWorkspaceForViewer — stream scope", () => {
    let scopedChannelId: string
    let otherChannelId: string
    let threadId: string
    let channelConv: string
    let threadConv: string
    let otherConv: string

    async function seedScopedConversation(
      client: Parameters<typeof ConversationRepository.insert>[0],
      convStreamId: string,
      sequence: number
    ): Promise<string> {
      const convId = conversationId()
      const msgId = messageId()
      await MessageRepository.insert(client, {
        id: msgId,
        streamId: convStreamId,
        sequence: BigInt(sequence),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Scope message"),
      })
      await ConversationRepository.insert(client, {
        id: convId,
        streamId: convStreamId,
        workspaceId: testWorkspaceId,
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)
      return convId
    }

    beforeAll(async () => {
      scopedChannelId = streamId()
      otherChannelId = streamId()
      threadId = streamId()
      await withTransaction(pool, async (client) => {
        for (const id of [scopedChannelId, otherChannelId]) {
          await StreamRepository.insert(client, {
            id,
            workspaceId: testWorkspaceId,
            type: "channel",
            visibility: "public",
            companionMode: "off",
            createdBy: testUserId,
          })
        }
        channelConv = await seedScopedConversation(client, scopedChannelId, 1)
        // A thread under the scoped channel: its conversation is thread-anchored,
        // and must still match the CHANNEL's scope via the root rule.
        const parentMsgId = messageId()
        await MessageRepository.insert(client, {
          id: parentMsgId,
          streamId: scopedChannelId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Thread parent"),
        })
        await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: testWorkspaceId,
          type: "thread",
          parentStreamId: scopedChannelId,
          parentAnchorId: parentMsgId,
          rootStreamId: scopedChannelId,
          companionMode: "off",
          createdBy: testUserId,
        })
        threadConv = await seedScopedConversation(client, threadId, 1)
        otherConv = await seedScopedConversation(client, otherChannelId, 1)
      })
    })

    test("scope keeps the channel's conversations — including thread-anchored ones — and drops the rest", async () => {
      const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        scopeStreamIds: [scopedChannelId],
        limit: 100,
      })
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has(channelConv)).toBe(true)
      expect(ids.has(threadConv)).toBe(true)
      expect(ids.has(otherConv)).toBe(false)
    })

    test("multi-stream scope unions the scoped streams", async () => {
      const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        scopeStreamIds: [scopedChannelId, otherChannelId],
        limit: 100,
      })
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has(channelConv)).toBe(true)
      expect(ids.has(otherConv)).toBe(true)
    })

    test("no scope surfaces conversations from every readable stream", async () => {
      const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        limit: 100,
      })
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has(channelConv)).toBe(true)
      expect(ids.has(otherConv)).toBe(true)
    })

    test("type scope matches by ROOT type — a thread-anchored conversation counts as its channel", async () => {
      const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        scopeStreamTypes: ["channel"],
        limit: 100,
      })
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has(channelConv)).toBe(true)
      // Anchored in a thread, but its root is a channel — must match.
      expect(ids.has(threadConv)).toBe(true)
    })

    test("type scope drops conversations whose root is another type", async () => {
      const rows = await ConversationRepository.findByWorkspaceForViewer(pool, testWorkspaceId, testUserId, {
        scopeStreamTypes: ["dm"],
        limit: 100,
      })
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has(channelConv)).toBe(false)
      expect(ids.has(threadConv)).toBe(false)
      expect(ids.has(otherConv)).toBe(false)
    })
  })

  describe("update", () => {
    test("updates completeness score and status", async () => {
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          completenessScore: 2,
          status: ConversationStatuses.ACTIVE,
        })
      })

      const updated = await withTransaction(pool, async (client) => {
        return ConversationRepository.update(client, testWorkspaceId, convId, {
          completenessScore: 6,
          status: ConversationStatuses.RESOLVED,
        })
      })

      expect(updated?.completenessScore).toBe(6)
      expect(updated?.status).toBe(ConversationStatuses.RESOLVED)
    })

    test("updates topic summary", async () => {
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Original topic",
        })
      })

      const updated = await withTransaction(pool, async (client) => {
        return ConversationRepository.update(client, testWorkspaceId, convId, {
          topicSummary: "Updated topic",
        })
      })

      expect(updated?.topicSummary).toBe("Updated topic")
    })

    test("returns null for non-existent conversation", async () => {
      const updated = await withTransaction(pool, async (client) => {
        return ConversationRepository.update(client, testWorkspaceId, "conv_nonexistent", {
          completenessScore: 5,
        })
      })

      expect(updated).toBeNull()
    })
  })

  describe("applyExtractionUpdate", () => {
    test("persists score, status, and summary; a user-locked status is never overridden", async () => {
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          completenessScore: 2,
          status: ConversationStatuses.ACTIVE,
        })
      })

      await withTransaction(pool, async (client) => {
        await ConversationRepository.applyExtractionUpdate(client, testWorkspaceId, convId, {
          completenessScore: 5,
          status: ConversationStatuses.STALLED,
          summary: "Rolling summary from the extractor",
        })
      })

      const afterExtraction = await withTransaction(pool, async (client) =>
        ConversationRepository.findById(client, convId)
      )
      expect(afterExtraction).toMatchObject({
        completenessScore: 5,
        status: ConversationStatuses.STALLED,
        summary: "Rolling summary from the extractor",
      })

      // The user resolves the conversation (locking status); a later extraction
      // pass may refine score/summary but must not reopen it.
      await withTransaction(pool, async (client) => {
        await ConversationRepository.update(client, testWorkspaceId, convId, {
          status: ConversationStatuses.RESOLVED,
          statusLockedByUser: true,
        })
        await ConversationRepository.applyExtractionUpdate(client, testWorkspaceId, convId, {
          completenessScore: 7,
          status: ConversationStatuses.ACTIVE,
          summary: "Refined summary",
        })
      })

      const afterLockedPass = await withTransaction(pool, async (client) =>
        ConversationRepository.findById(client, convId)
      )
      expect(afterLockedPass).toMatchObject({
        completenessScore: 7,
        status: ConversationStatuses.RESOLVED,
        summary: "Refined summary",
      })
    })
  })

  describe("assignments + bumpActivity", () => {
    test("derives messageIds from assignments and bumpActivity updates lastActivityAt", async () => {
      const convId = conversationId()
      const msg1Id = messageId()
      const msg2Id = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(200),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("First message"),
        })

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(201),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Second message"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msg1Id, testUserId)
      })

      const originalConv = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, convId)
      })

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10))

      const updated = await withTransaction(pool, async (client) => {
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msg2Id, testUserId)
        await ConversationRepository.bumpActivityForIds(client, testWorkspaceId, [convId])
        return ConversationRepository.findById(client, convId)
      })

      expect(updated?.messageIds).toEqual([msg1Id, msg2Id])
      expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(originalConv!.lastActivityAt.getTime())
    })

    test("participantIds is derived from message authors", async () => {
      const convId = conversationId()
      const msgId = messageId()
      const user2WorkosId = userId()
      let user2UserId = ""

      const conversation = await withTransaction(pool, async (client) => {
        user2UserId = (await addTestMember(client, testWorkspaceId, user2WorkosId)).id

        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(300),
          authorId: user2UserId,
          authorType: "user",
          ...testMessageContent("Participant-deriving message"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, user2UserId)

        return ConversationRepository.findById(client, convId)
      })

      expect(conversation?.participantIds).toEqual([user2UserId])
    })
  })

  describe("workspace scoping (INV-8)", () => {
    test("findByIds filters out conversations from other workspaces", async () => {
      const otherWorkspaceId = workspaceId()
      const otherUserId = userId()
      const otherStreamId = streamId()
      const ownConvId = conversationId()
      const otherConvId = conversationId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: otherWorkspaceId,
          name: "Other Workspace",
          slug: `other-ws-${otherWorkspaceId}`,
          createdBy: otherUserId,
        })
        const otherMember = await addTestMember(client, otherWorkspaceId, otherUserId)
        await StreamRepository.insert(client, {
          id: otherStreamId,
          workspaceId: otherWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: otherMember.id,
        })

        await ConversationRepository.insert(client, {
          id: ownConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.insert(client, {
          id: otherConvId,
          streamId: otherStreamId,
          workspaceId: otherWorkspaceId,
        })
      })

      const ownResult = await withTransaction(pool, async (client) => {
        return ConversationRepository.findByIds(client, testWorkspaceId, [ownConvId, otherConvId])
      })

      // Only the own-workspace conv comes back even though both IDs were requested.
      expect(ownResult.map((c) => c.id)).toEqual([ownConvId])
    })

    test("update returns null when conversation belongs to a different workspace", async () => {
      const otherWorkspaceId = workspaceId()
      const otherUserId = userId()
      const otherStreamId = streamId()
      const foreignConvId = conversationId()

      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: otherWorkspaceId,
          name: "Foreign Workspace",
          slug: `foreign-ws-${otherWorkspaceId}`,
          createdBy: otherUserId,
        })
        const otherMember = await addTestMember(client, otherWorkspaceId, otherUserId)
        await StreamRepository.insert(client, {
          id: otherStreamId,
          workspaceId: otherWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: otherMember.id,
        })

        await ConversationRepository.insert(client, {
          id: foreignConvId,
          streamId: otherStreamId,
          workspaceId: otherWorkspaceId,
          topicSummary: "Foreign topic",
        })
      })

      const result = await withTransaction(pool, async (client) => {
        return ConversationRepository.update(client, testWorkspaceId, foreignConvId, {
          topicSummary: "Hijacked topic",
        })
      })

      expect(result).toBeNull()

      // And the foreign conversation row is untouched.
      const foreignConv = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, foreignConvId)
      })
      expect(foreignConv?.topicSummary).toBe("Foreign topic")
    })
  })

  describe("primary/secondary array maintenance", () => {
    test("addPrimaryMessage promotes a secondary entry in place (clears it from secondary_message_ids)", async () => {
      const convId = conversationId()
      const msgId = messageId()

      const conversation = await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(400),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Promotion test message"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addSecondaryMessage(client, testWorkspaceId, convId, msgId)
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)

        return ConversationRepository.findById(client, convId)
      })

      expect(conversation?.messageIds).toEqual([msgId])
      expect(conversation?.secondaryMessageIds).toEqual([])
    })

    test("addSecondaryMessage is a no-op when the message is already in message_ids", async () => {
      const convId = conversationId()
      const msgId = messageId()

      const conversation = await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(401),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Already-primary message"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)
        await ConversationRepository.addSecondaryMessage(client, testWorkspaceId, convId, msgId)

        return ConversationRepository.findById(client, convId)
      })

      expect(conversation?.messageIds).toEqual([msgId])
      expect(conversation?.secondaryMessageIds).toEqual([])
    })

    test("removePrimaryMessage strips the message but leaves participantIds intact", async () => {
      const convId = conversationId()
      const msgId = messageId()

      const conversation = await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(402),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Removable message"),
        })

        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)
        await ConversationRepository.removePrimaryMessage(client, testWorkspaceId, convId, msgId)

        return ConversationRepository.findById(client, convId)
      })

      expect(conversation?.messageIds).toEqual([])
      expect(conversation?.participantIds).toEqual([testUserId])
    })
  })

  describe("delete", () => {
    test("removes conversation and returns true", async () => {
      const convId = conversationId()

      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
      })

      const deleted = await withTransaction(pool, async (client) => {
        return ConversationRepository.delete(client, convId)
      })

      expect(deleted).toBe(true)

      const found = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, convId)
      })

      expect(found).toBeNull()
    })

    test("returns false for non-existent conversation", async () => {
      const deleted = await withTransaction(pool, async (client) => {
        return ConversationRepository.delete(client, "conv_nonexistent")
      })

      expect(deleted).toBe(false)
    })
  })

  describe("sweepStale", () => {
    const DAY_SECONDS = 24 * 60 * 60
    const WEEK_SECONDS = 7 * DAY_SECONDS

    async function insertIdleConversation(status: string, idleHours: number): Promise<string> {
      const convId = conversationId()
      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          status: status as "active" | "stalled" | "resolved",
        })
        await client.query(sql`
          UPDATE conversations
          SET last_activity_at = NOW() - make_interval(hours => ${idleHours})
          WHERE id = ${convId}
        `)
      })
      return convId
    }

    function sweep() {
      return withTransaction(pool, async (client) =>
        ConversationRepository.sweepStale(client, {
          stalledAfterSeconds: DAY_SECONDS,
          resolvedAfterSeconds: WEEK_SECONDS,
          limit: 100,
        })
      )
    }

    test("fades idle conversations by idle time and leaves live ones alone", async () => {
      const liveActive = await insertIdleConversation(ConversationStatuses.ACTIVE, 1)
      const idleActive = await insertIdleConversation(ConversationStatuses.ACTIVE, 25)
      const longIdleActive = await insertIdleConversation(ConversationStatuses.ACTIVE, 8 * 24)
      const longIdleStalled = await insertIdleConversation(ConversationStatuses.STALLED, 8 * 24)
      const recentStalled = await insertIdleConversation(ConversationStatuses.STALLED, 48)

      const swept = await sweep()
      const byId = new Map(swept.map((c) => [c.id, c]))

      expect(byId.get(idleActive)?.status).toBe(ConversationStatuses.STALLED)
      expect(byId.get(longIdleActive)?.status).toBe(ConversationStatuses.RESOLVED)
      expect(byId.get(longIdleStalled)?.status).toBe(ConversationStatuses.RESOLVED)
      // Live and recently-stalled rows are not transitioned.
      expect(byId.has(liveActive)).toBe(false)
      expect(byId.has(recentStalled)).toBe(false)

      const untouched = await withTransaction(pool, async (client) =>
        ConversationRepository.findById(client, liveActive)
      )
      expect(untouched?.status).toBe(ConversationStatuses.ACTIVE)
    })

    test("is idempotent: a second sweep transitions nothing new", async () => {
      await insertIdleConversation(ConversationStatuses.ACTIVE, 30)

      const first = await sweep()
      expect(first.length).toBeGreaterThan(0)

      const second = await sweep()
      expect(second).toEqual([])
    })
  })
})
