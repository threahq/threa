/**
 * Boundary Extraction Service Integration Tests
 *
 * Tests verify:
 * 1. New message creates new conversation when extractor returns null conversationId
 * 2. New message joins existing conversation when extractor returns existing ID
 * 3. Completeness updates are applied to affected conversations
 * 4. Outbox events are emitted for new and updated conversations
 * 5. Participant is added to conversation
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import { BoundaryExtractionService } from "../../src/features/conversations"
import { setupTestDatabase, testMessageContent } from "./setup"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"
import { ConversationStatuses } from "@threa/types"
import type { BoundaryExtractor, ExtractionContext, ExtractionResult } from "../../src/features/conversations"

/**
 * Stub extractor that returns configurable results and tracks calls.
 */
class StubBoundaryExtractor implements BoundaryExtractor {
  private nextResult: ExtractionResult = {
    assignments: [{ conversationId: null, isPrimary: true }],
    newConversationTopic: "Default topic",
    confidence: 0.8,
  }

  extractCallCount = 0

  setNextResult(result: ExtractionResult): void {
    this.nextResult = result
  }

  resetCallCount(): void {
    this.extractCallCount = 0
  }

  async extract(_context: ExtractionContext): Promise<ExtractionResult> {
    this.extractCallCount++
    return this.nextResult
  }
}

describe("BoundaryExtractionService", () => {
  let pool: Pool
  let service: BoundaryExtractionService
  let stubExtractor: StubBoundaryExtractor
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    // Create shared test data - use withTransaction (commits) not withTransaction (rolls back)
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
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
    })

    stubExtractor = new StubBoundaryExtractor()
    service = new BoundaryExtractionService(pool, stubExtractor)
  })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(async () => {
    // Clean up test data after each test
    await withTransaction(pool, async (client) => {
      // Clean up in reverse dependency order
      await client.query("DELETE FROM outbox")
      await client.query("DELETE FROM conversations")
      await client.query("DELETE FROM messages")
      await client.query(`DELETE FROM streams WHERE id != '${testStreamId}'`)
    })
  })

  beforeEach(() => {
    // Reset extractor to default behavior
    stubExtractor.setNextResult({
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Default topic",
      confidence: 0.8,
    })
    stubExtractor.resetCallCount()
  })

  describe("processMessage", () => {
    test("creates new conversation when extractor returns null conversationId", async () => {
      const msgId = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Starting a new topic"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "Starting a new topic",
        confidence: 0.85,
      })

      const result = await service.processMessage(msgId, testStreamId, testWorkspaceId)

      expect(result).not.toBeNull()
      expect(result?.messageIds).toContain(msgId)
      expect(result?.participantIds).toContain(testUserId)
      expect(result?.topicSummary).toBe("Starting a new topic")
      expect(result?.confidence).toBe(0.85)
      expect(result?.status).toBe(ConversationStatuses.ACTIVE)
    })

    test("adds message to existing conversation when extractor returns conversationId", async () => {
      const existingConvId = conversationId()
      const msg1Id = messageId()
      const msg2Id = messageId()

      // Create existing conversation
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(10),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("First message"),
        })

        await ConversationRepository.insert(client, {
          id: existingConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Existing conversation",
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, existingConvId, msg1Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(11),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Continuation of topic"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: existingConvId, isPrimary: true }],
        confidence: 0.9,
      })

      const result = await service.processMessage(msg2Id, testStreamId, testWorkspaceId)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(existingConvId)
      expect(result?.messageIds).toContain(msg1Id)
      expect(result?.messageIds).toContain(msg2Id)
    })

    test("applies completeness updates to other conversations", async () => {
      const conv1Id = conversationId()
      const conv2Id = conversationId()
      const msg1Id = messageId()
      const msg2Id = messageId()
      const msg3Id = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(20),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Question about X"),
        })

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(21),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Working on Y"),
        })

        await ConversationRepository.insert(client, {
          id: conv1Id,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          completenessScore: 2,
          status: ConversationStatuses.ACTIVE,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, conv1Id, msg1Id, testUserId)

        await ConversationRepository.insert(client, {
          id: conv2Id,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          completenessScore: 3,
          status: ConversationStatuses.ACTIVE,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, conv2Id, msg2Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg3Id,
          streamId: testStreamId,
          sequence: BigInt(22),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Answer to X"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: conv1Id, isPrimary: true }],
        confidence: 0.95,
        completenessUpdates: [{ conversationId: conv1Id, score: 6, status: ConversationStatuses.RESOLVED }],
      })

      await service.processMessage(msg3Id, testStreamId, testWorkspaceId)

      // Check that conv1 was updated
      const updatedConv = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, conv1Id)
      })

      expect(updatedConv?.completenessScore).toBe(6)
      expect(updatedConv?.status).toBe(ConversationStatuses.RESOLVED)
    })

    test("emits conversation:created outbox event for new conversation", async () => {
      const msgId = messageId()
      const localStreamId = streamId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await MessageRepository.insert(client, {
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("New conversation starter"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "New conversation starter",
        confidence: 0.75,
      })

      const result = await service.processMessage(msgId, localStreamId, testWorkspaceId)

      // Check outbox for the event
      const outboxEvents = await withTransaction(pool, async (client) => {
        const res = await client.query(
          `SELECT * FROM outbox WHERE event_type = 'conversation:created' ORDER BY created_at DESC LIMIT 1`
        )
        return res.rows
      })

      expect(outboxEvents.length).toBeGreaterThan(0)
      const payload = outboxEvents[0].payload
      expect(payload.streamId).toBe(localStreamId)
      expect(payload.conversation.id).toBe(result?.id)
      // Staleness fields should be present
      expect(typeof payload.conversation.temporalStaleness).toBe("number")
      expect(typeof payload.conversation.effectiveCompleteness).toBe("number")
    })

    test("emits conversation:updated outbox event for existing conversation", async () => {
      const existingConvId = conversationId()
      const localStreamId = streamId()
      const msg1Id = messageId()
      const msg2Id = messageId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("First message"),
        })

        await ConversationRepository.insert(client, {
          id: existingConvId,
          streamId: localStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, existingConvId, msg1Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: localStreamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Second message"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: existingConvId, isPrimary: true }],
        confidence: 0.9,
      })

      await service.processMessage(msg2Id, localStreamId, testWorkspaceId)

      // Check outbox for the event
      const outboxEvents = await withTransaction(pool, async (client) => {
        const res = await client.query(
          `SELECT * FROM outbox WHERE event_type = 'conversation:updated' ORDER BY created_at DESC LIMIT 1`
        )
        return res.rows
      })

      expect(outboxEvents.length).toBeGreaterThan(0)
      const payload = outboxEvents[0].payload
      expect(payload.conversationId).toBe(existingConvId)
      expect(payload.conversation.messageIds).toContain(msg2Id)
    })

    test("returns null for non-existent message", async () => {
      const result = await service.processMessage("msg_nonexistent", testStreamId, testWorkspaceId)
      expect(result).toBeNull()
    })

    test("returns null for non-existent stream", async () => {
      const msgId = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: testStreamId,
          sequence: BigInt(100),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Test message"),
        })
      })

      const result = await service.processMessage(msgId, "stream_nonexistent", testWorkspaceId)
      expect(result).toBeNull()
    })

    test("adds new participant when different user messages", async () => {
      const existingConvId = conversationId()
      const user2Id = userId()
      let user2UserId = ""
      const msg1Id = messageId()
      const msg2Id = messageId()

      await withTransaction(pool, async (client) => {
        user2UserId = (await addTestMember(client, testWorkspaceId, user2Id)).id

        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(50),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("User 1 message"),
        })

        await ConversationRepository.insert(client, {
          id: existingConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })

        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, existingConvId, msg1Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(51),
          authorId: user2UserId,
          authorType: "user",
          ...testMessageContent("User 2 reply"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: existingConvId, isPrimary: true }],
        confidence: 0.9,
      })

      const result = await service.processMessage(msg2Id, testStreamId, testWorkspaceId)

      expect(result?.participantIds).toContain(testUserId)
      expect(result?.participantIds).toContain(user2UserId)
    })
  })

  describe("multi-assignment", () => {
    test("cross-topic split: new message assigned as primary to a new conv AND secondary to an existing conv", async () => {
      // A message that opens a new topic but also references / belongs in
      // an earlier, related conversation. The extractor returns two
      // assignments — primary on a fresh conv, secondary on the existing one.
      const existingConvId = conversationId()
      const msg1Id = messageId()
      const msg2Id = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(600),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Earlier topic A discussion"),
        })

        await ConversationRepository.insert(client, {
          id: existingConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Topic A",
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, existingConvId, msg1Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(601),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Opening topic B, which also touches topic A"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [
          { conversationId: null, isPrimary: true },
          { conversationId: existingConvId, isPrimary: false },
        ],
        newConversationTopic: "Topic B",
        confidence: 0.82,
      })

      const result = await service.processMessage(msg2Id, testStreamId, testWorkspaceId)

      // Primary lands on the freshly created conv.
      expect(result).not.toBeNull()
      expect(result?.id).not.toBe(existingConvId)
      expect(result?.messageIds).toContain(msg2Id)
      expect(result?.secondaryMessageIds).not.toContain(msg2Id)

      // Existing conv picks up msg2 as a secondary, not a primary.
      const updatedExisting = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, existingConvId)
      })
      expect(updatedExisting?.messageIds).toEqual([msg1Id])
      expect(updatedExisting?.secondaryMessageIds).toContain(msg2Id)

      // Two conversation:message_assigned events, one isPrimary=true, one isPrimary=false.
      const assignedEvents = await withTransaction(pool, async (client) => {
        const res = await client.query<{
          payload: { messageId: string; conversationId: string; isPrimary: boolean; reason: string }
        }>(`SELECT payload FROM outbox WHERE event_type = 'conversation:message_assigned' ORDER BY created_at ASC`)
        return res.rows.map((r) => r.payload)
      })
      const forMsg2 = assignedEvents.filter((e) => e.messageId === msg2Id)
      expect(forMsg2).toHaveLength(2)
      expect(forMsg2).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ conversationId: result?.id, isPrimary: true, reason: "initial" }),
          expect.objectContaining({ conversationId: existingConvId, isPrimary: false, reason: "secondary" }),
        ])
      )
    })

    test("thread root assigned as primary in thread conv AND secondary on parent channel conv", async () => {
      // Parent channel has a conversation anchored on a parent message.
      // A new thread is opened off that parent message; the thread root
      // belongs primarily to the thread's own conversation, and secondarily
      // to the parent channel's conv (cross-references the parent topic).
      const parentConvId = conversationId()
      const parentMsgId = messageId()
      const threadStreamId = streamId()
      const threadRootMsgId = messageId()

      await withTransaction(pool, async (client) => {
        // Parent channel message + conv.
        await MessageRepository.insert(client, {
          id: parentMsgId,
          streamId: testStreamId,
          sequence: BigInt(700),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Parent channel topic"),
        })
        await ConversationRepository.insert(client, {
          id: parentConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Parent topic",
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, parentConvId, parentMsgId, testUserId)

        // Thread stream branching off the parent message.
        await StreamRepository.insert(client, {
          id: threadStreamId,
          workspaceId: testWorkspaceId,
          type: "thread",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
          parentStreamId: testStreamId,
          parentMessageId: parentMsgId,
        })

        // Thread root message in the thread stream.
        await MessageRepository.insert(client, {
          id: threadRootMsgId,
          streamId: threadStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Branching off into related but separate territory"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [
          { conversationId: null, isPrimary: true },
          { conversationId: parentConvId, isPrimary: false },
        ],
        newConversationTopic: "Thread sub-topic",
        confidence: 0.8,
      })

      const result = await service.processMessage(threadRootMsgId, threadStreamId, testWorkspaceId)

      // Primary lands on a freshly created thread conv in the thread stream.
      expect(result).not.toBeNull()
      expect(result?.streamId).toBe(threadStreamId)
      expect(result?.messageIds).toContain(threadRootMsgId)

      // Parent conv gets the thread root as a secondary membership.
      const updatedParent = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, parentConvId)
      })
      expect(updatedParent?.messageIds).toEqual([parentMsgId])
      expect(updatedParent?.secondaryMessageIds).toContain(threadRootMsgId)

      // Both conversation:message_assigned events carry parentStreamId so the
      // parent-channel room receives the membership update too.
      const assignedEvents = await withTransaction(pool, async (client) => {
        const res = await client.query<{
          payload: {
            messageId: string
            conversationId: string
            isPrimary: boolean
            streamId: string
            parentStreamId?: string
          }
        }>(`SELECT payload FROM outbox WHERE event_type = 'conversation:message_assigned'`)
        return res.rows.map((r) => r.payload)
      })
      const forRoot = assignedEvents.filter((e) => e.messageId === threadRootMsgId)
      expect(forRoot).toHaveLength(2)
      for (const ev of forRoot) {
        expect(ev.streamId).toBe(threadStreamId)
        expect(ev.parentStreamId).toBe(testStreamId)
      }
      expect(forRoot.map((e) => e.isPrimary).sort()).toEqual([false, true])
    })
  })

  describe("reassignment", () => {
    test("moves an earlier message to a different existing conversation without aborting the transaction", async () => {
      const convAId = conversationId()
      const convBId = conversationId()
      const msg0Id = messageId()
      const msg1Id = messageId()
      const msg2Id = messageId()
      const msg3Id = messageId()

      await withTransaction(pool, async (client) => {
        // msg0 anchors convB inside the surrounding-window so Phase 1 discovers
        // convB as a candidate target. Without this, the reassignment to convB
        // would fail the validUpdateTargets check and be silently skipped.
        await MessageRepository.insert(client, {
          id: msg0Id,
          streamId: testStreamId,
          sequence: BigInt(299),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Topic B opener"),
        })
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(300),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Topic A start"),
        })
        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(301),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Maybe topic A, maybe topic B"),
        })

        await ConversationRepository.insert(client, {
          id: convAId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Topic A",
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convAId, msg1Id, testUserId)
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convAId, msg2Id, testUserId)

        await ConversationRepository.insert(client, {
          id: convBId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Topic B",
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convBId, msg0Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg3Id,
          streamId: testStreamId,
          sequence: BigInt(302),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Definitely topic B, and so was the ambiguous earlier one"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: convBId, isPrimary: true }],
        confidence: 0.9,
        reassignments: [
          {
            messageId: msg2Id,
            toConversationId: convBId,
            reason: "Earlier ambiguous message now clearly belongs to topic B",
            confidence: 0.85,
          },
        ],
      })

      const result = await service.processMessage(msg3Id, testStreamId, testWorkspaceId)

      expect(result?.id).toBe(convBId)
      expect(result?.messageIds).toEqual(expect.arrayContaining([msg2Id, msg3Id]))

      const convA = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, convAId)
      })
      expect(convA?.messageIds).toEqual([msg1Id])
      expect(convA?.messageIds).not.toContain(msg2Id)
    })

    test("moves an earlier message into a freshly created conversation", async () => {
      const convAId = conversationId()
      const msg1Id = messageId()
      const msg2Id = messageId()
      const msg3Id = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(400),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Initial"),
        })
        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(401),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Pivot point"),
        })

        await ConversationRepository.insert(client, {
          id: convAId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Existing topic",
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convAId, msg1Id, testUserId)
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convAId, msg2Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg3Id,
          streamId: testStreamId,
          sequence: BigInt(402),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Clearly a new topic, and the pivot was its start"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "New topic from pivot",
        confidence: 0.88,
        reassignments: [
          {
            messageId: msg2Id,
            toConversationId: null,
            reason: "Pivot belongs to the new conversation",
          },
        ],
      })

      const result = await service.processMessage(msg3Id, testStreamId, testWorkspaceId)

      expect(result).not.toBeNull()
      expect(result?.id).not.toBe(convAId)
      expect(result?.messageIds).toEqual(expect.arrayContaining([msg2Id, msg3Id]))

      const convA = await withTransaction(pool, async (client) => {
        return ConversationRepository.findById(client, convAId)
      })
      expect(convA?.messageIds).toEqual([msg1Id])
    })

    test("emits conversation:message_reassigned outbox event", async () => {
      const convAId = conversationId()
      const convBId = conversationId()
      const msg0Id = messageId()
      const msg1Id = messageId()
      const msg2Id = messageId()

      await withTransaction(pool, async (client) => {
        // msg0 anchors convB inside the surrounding-window so Phase 1 discovers
        // convB as a valid reassignment target.
        await MessageRepository.insert(client, {
          id: msg0Id,
          streamId: testStreamId,
          sequence: BigInt(499),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Topic B opener"),
        })
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(500),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Was assigned to A"),
        })

        await ConversationRepository.insert(client, {
          id: convAId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convAId, msg1Id, testUserId)

        await ConversationRepository.insert(client, {
          id: convBId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convBId, msg0Id, testUserId)

        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: testStreamId,
          sequence: BigInt(501),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("New message reveals msg1 belonged in B"),
        })
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: convBId, isPrimary: true }],
        confidence: 0.9,
        reassignments: [
          {
            messageId: msg1Id,
            toConversationId: convBId,
            reason: "Belonged in B all along",
          },
        ],
      })

      await service.processMessage(msg2Id, testStreamId, testWorkspaceId)

      const reassignedEvents = await withTransaction(pool, async (client) => {
        const res = await client.query<{
          payload: { messageId: string; fromConversationId: string; toConversationId: string }
        }>(`SELECT payload FROM outbox WHERE event_type = 'conversation:message_reassigned'`)
        return res.rows
      })

      expect(reassignedEvents.length).toBeGreaterThan(0)
      const payload = reassignedEvents[0].payload
      expect(payload.messageId).toBe(msg1Id)
      expect(payload.fromConversationId).toBe(convAId)
      expect(payload.toConversationId).toBe(convBId)
    })
  })

  describe("scratchpad handling", () => {
    test("skips extractor for scratchpad streams", async () => {
      const localStreamId = streamId()
      const msgId = messageId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await MessageRepository.insert(client, {
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Scratchpad message"),
        })
      })

      await service.processMessage(msgId, localStreamId, testWorkspaceId)

      expect(stubExtractor.extractCallCount).toBe(0)
    })

    test("creates single conversation for scratchpad and adds all messages to it", async () => {
      const localStreamId = streamId()
      const msg1Id = messageId()
      const msg2Id = messageId()
      const msg3Id = messageId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          displayName: "My Notes",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("First note"),
        })
      })

      // Process first message - creates conversation
      const result1 = await service.processMessage(msg1Id, localStreamId, testWorkspaceId)
      expect(result1).not.toBeNull()
      expect(result1?.messageIds).toContain(msg1Id)
      const conversationId1 = result1?.id

      // Add more messages
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: localStreamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Second note"),
        })

        await MessageRepository.insert(client, {
          id: msg3Id,
          streamId: localStreamId,
          sequence: BigInt(3),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Third note"),
        })
      })

      // Process remaining messages - should add to same conversation
      const result2 = await service.processMessage(msg2Id, localStreamId, testWorkspaceId)
      const result3 = await service.processMessage(msg3Id, localStreamId, testWorkspaceId)

      // All results should reference the same conversation
      expect(result2?.id).toBe(conversationId1)
      expect(result3?.id).toBe(conversationId1)

      // Final conversation should contain all messages
      expect(result3?.messageIds).toContain(msg1Id)
      expect(result3?.messageIds).toContain(msg2Id)
      expect(result3?.messageIds).toContain(msg3Id)

      // Extractor should never have been called
      expect(stubExtractor.extractCallCount).toBe(0)
    })

    test("uses stream display name as conversation topic", async () => {
      const localStreamId = streamId()
      const msgId = messageId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          displayName: "Project Ideas",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await MessageRepository.insert(client, {
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Some ideas"),
        })
      })

      const result = await service.processMessage(msgId, localStreamId, testWorkspaceId)

      expect(result?.topicSummary).toBe("Project Ideas")
    })

    test("falls back to 'Scratchpad' when stream has no display name", async () => {
      const localStreamId = streamId()
      const msgId = messageId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          // No displayName set
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })

        await MessageRepository.insert(client, {
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Test message"),
        })
      })

      const result = await service.processMessage(msgId, localStreamId, testWorkspaceId)

      expect(result?.topicSummary).toBe("Scratchpad")
    })
  })
})
