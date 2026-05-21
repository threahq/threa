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
import { setupTestDatabase, testMessageContent } from "./setup"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"
import { ConversationStatuses } from "@threa/types"

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
        await ConversationRepository.bumpActivity(client, convId)
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
})
