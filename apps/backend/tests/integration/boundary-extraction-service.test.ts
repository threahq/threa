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

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, seedCompletedLinkPreview } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamEventRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository, MessageConversationStateRepository } from "../../src/features/conversations"
import { BoundaryExtractionService, ConversationService } from "../../src/features/conversations"
import { setupTestDatabase, testMessageContent } from "./setup"
import { sql } from "../../src/db"
import { userId, workspaceId, streamId, messageId, conversationId, eventId } from "../../src/lib/id"
import { ConversationStatuses } from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import type {
  BoundaryExtractor,
  ExtractionContext,
  ExtractionResult,
  SplitContext,
  SplitProposal,
} from "../../src/features/conversations"

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
  lastContext: ExtractionContext | null = null

  setNextResult(result: ExtractionResult): void {
    this.nextResult = result
  }

  resetCallCount(): void {
    this.extractCallCount = 0
  }

  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    this.extractCallCount++
    this.lastContext = context
    return this.nextResult
  }

  lastSplitContext: SplitContext | null = null

  async splitConversation(context: SplitContext): Promise<SplitProposal> {
    this.lastSplitContext = context
    return {
      groups: [{ title: "Whole", messageIds: context.messages.map((m) => m.id) }],
      confidence: 1,
      reasoning: null,
    }
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

  async function countConversations(localStreamId: string): Promise<number> {
    const { rows } = await pool.query(
      sql`SELECT COUNT(*)::int AS n FROM conversations WHERE stream_id = ${localStreamId} AND workspace_id = ${testWorkspaceId}`
    )
    return rows[0].n
  }

  async function insertPersonaReply(localStreamId: string): Promise<string> {
    const replyId = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        workspaceId: testWorkspaceId,
        id: replyId,
        streamId: localStreamId,
        sequence: BigInt(2),
        authorId: "persona_test",
        authorType: "persona",
        ...testMessageContent("Agent reply"),
      })
    })
    return replyId
  }

  describe("processMessage", () => {
    test("creates new conversation when extractor returns null conversationId", async () => {
      const msgId = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(20),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Question about X"),
        })

        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
        return ConversationRepository.findById(client, testWorkspaceId, conv1Id)
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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

    test("joins the stream's active conversation when an agent replies in a channel", async () => {
      const humanId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: humanId,
          streamId: testStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("A question"),
        })
      })
      const asked = await service.processMessage(humanId, testStreamId, testWorkspaceId)
      const replyId = await insertPersonaReply(testStreamId)

      const answered = await service.processMessage(replyId, testStreamId, testWorkspaceId)

      expect({ joined: answered?.id, conversations: await countConversations(testStreamId) }).toEqual({
        joined: asked!.id,
        conversations: 1,
      })
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
        return ConversationRepository.findById(client, testWorkspaceId, existingConvId)
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

    /** A channel message `anchorId` with a thread under it holding one user reply. */
    async function seedMessageThread(params: { anchorText: string; replyText: string; sequence: bigint }) {
      const anchorId = messageId()
      const threadId = streamId()
      const replyId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: anchorId,
          streamId: testStreamId,
          sequence: params.sequence,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(params.anchorText),
        })
        await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: testWorkspaceId,
          type: "thread",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
          parentStreamId: testStreamId,
          parentAnchorId: anchorId,
          rootStreamId: testStreamId,
        })
        await StreamRepository.bumpThreadReplyCount(client, testWorkspaceId, threadId, 1)
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: replyId,
          streamId: threadId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(params.replyText),
        })
      })
      return { anchorId, threadId, replyId }
    }

    test("should place a user's reply in a message-anchored thread in the anchor's conversation without the extractor", async () => {
      const { anchorId, threadId, replyId } = await seedMessageThread({
        anchorText: "Should we move the deploy to Thursday?",
        replyText: "Thursday works for me",
        sequence: BigInt(700),
      })
      const anchorConvId = conversationId()
      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: anchorConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Deploy day",
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, anchorConvId, anchorId, testUserId)
      })

      const result = await service.processMessage(replyId, threadId, testWorkspaceId)

      const settling = await pool.query(sql`SELECT 1 FROM message_conversation_state WHERE message_id = ${replyId}`)
      const assigned = await pool.query<{ payload: { messageId: string; parentStreamId?: string; reason: string } }>(
        sql`SELECT payload FROM outbox WHERE event_type = 'conversation:message_assigned'`
      )
      expect({
        conversationId: result?.id,
        memberIds: result?.messageIds,
        extractCalls: stubExtractor.extractCallCount,
        settlingRows: settling.rowCount,
        assigned: assigned.rows.map((r) => r.payload),
      }).toEqual({
        conversationId: anchorConvId,
        memberIds: [anchorId, replyId],
        extractCalls: 0,
        settlingRows: 0,
        assigned: [
          expect.objectContaining({ messageId: replyId, parentStreamId: testStreamId, reason: "thread_reply" }),
        ],
      })
    })

    test("should start the thread's own conversation when the anchor has none, and keep later replies in it", async () => {
      const { threadId, replyId } = await seedMessageThread({
        anchorText: "Anyone tried the new linter?",
        replyText: "Yes, it is strict about imports",
        sequence: BigInt(710),
      })
      const laterReplyId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: laterReplyId,
          streamId: threadId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("And slow on large files"),
        })
      })

      const first = await service.processMessage(replyId, threadId, testWorkspaceId)
      const second = await service.processMessage(laterReplyId, threadId, testWorkspaceId)

      expect({
        streamId: first?.streamId,
        secondConversationId: second?.id,
        memberIds: second?.messageIds,
        extractCalls: stubExtractor.extractCallCount,
      }).toEqual({
        streamId: threadId,
        secondConversationId: first?.id,
        memberIds: [replyId, laterReplyId],
        extractCalls: 0,
      })
    })

    test("should extract a channel message with the thread's conversation as a candidate, and never move the thread's reply", async () => {
      // A in the channel, B replies in A's thread, C answers A straight in the channel.
      const { replyId: bId, threadId } = await seedMessageThread({
        anchorText: "A: which region should the replica live in?",
        replyText: "B: eu-north, latency is best there",
        sequence: BigInt(720),
      })
      const cId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: cId,
          streamId: testStreamId,
          sequence: BigInt(721),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("C: agreed on eu-north for the replica"),
        })
      })
      const threadConv = await service.processMessage(bId, threadId, testWorkspaceId)

      // The model's split is refused for B: its thread placed it.
      stubExtractor.setNextResult({
        assignments: [{ conversationId: null, isPrimary: true }],
        reassignments: [{ messageId: bId, toConversationId: null, reason: "split it off", confidence: 0.9 }],
        newConversationTopic: "Elsewhere",
        confidence: 0.9,
      })
      const result = await service.processMessage(cId, testStreamId, testWorkspaceId)

      const b = await ConversationRepository.findPrimaryByMessageId(pool, testWorkspaceId, bId)
      expect({
        extractCalls: stubExtractor.extractCallCount,
        candidates: stubExtractor.lastContext?.activeConversations.map((c) => c.id),
        contextIncludesB: stubExtractor.lastContext?.recentMessages.some((m) => m.id === bId),
        cInNewConversation: result !== null && result.id !== threadConv!.id,
        bConversationId: b?.id,
      }).toEqual({
        extractCalls: 1,
        candidates: [threadConv!.id],
        contextIncludesB: true,
        cInNewConversation: true,
        bConversationId: threadConv!.id,
      })
    })

    test("should fold the thread's own conversation into the anchor's once the anchor is placed", async () => {
      const { anchorId, threadId, replyId } = await seedMessageThread({
        anchorText: "Who owns the backup rotation?",
        replyText: "I can take it this quarter",
        sequence: BigInt(730),
      })
      const threadConv = await service.processMessage(replyId, threadId, testWorkspaceId)

      const anchorConv = await service.processMessage(anchorId, testStreamId, testWorkspaceId)

      const reply = await ConversationRepository.findPrimaryByMessageId(pool, testWorkspaceId, replyId)
      const folded = await ConversationRepository.findById(pool, testWorkspaceId, threadConv!.id)
      const reassigned = await pool.query<{ payload: Record<string, unknown> }>(
        sql`SELECT payload FROM outbox WHERE event_type = 'conversation:message_reassigned'`
      )
      expect({
        replyConversationId: reply?.id,
        folded: { status: folded?.status, memberIds: folded?.messageIds },
        reassigned: reassigned.rows.map((r) => r.payload),
      }).toEqual({
        replyConversationId: anchorConv!.id,
        folded: { status: ConversationStatuses.RESOLVED, memberIds: [] },
        reassigned: [
          expect.objectContaining({
            messageId: replyId,
            streamId: threadId,
            fromConversationId: threadConv!.id,
            toConversationId: anchorConv!.id,
            reason: "thread_follows_anchor",
          }),
        ],
      })
    })

    test("should move a thread's replies with its reassigned anchor, except a reply a human filed", async () => {
      const { anchorId, threadId, replyId } = await seedMessageThread({
        anchorText: "Postgres upgrade window?",
        replyText: "Sunday night is quietest",
        sequence: BigInt(741),
      })
      const filedReplyId = messageId()
      const openerId = messageId()
      const triggerId = messageId()
      const anchorConvId = conversationId()
      const targetConvId = conversationId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: filedReplyId,
          streamId: threadId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Unrelated, but the CI cache is broken"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: openerId,
          streamId: testStreamId,
          sequence: BigInt(740),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Planning the database maintenance"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: triggerId,
          streamId: testStreamId,
          sequence: BigInt(742),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("So the upgrade is part of the maintenance plan"),
        })
        await ConversationRepository.insert(client, {
          id: anchorConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, anchorConvId, anchorId, testUserId)
        await ConversationRepository.insert(client, {
          id: targetConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, targetConvId, openerId, testUserId)
      })
      await service.processMessage(replyId, threadId, testWorkspaceId)
      await service.processMessage(filedReplyId, threadId, testWorkspaceId)
      await withTransaction(pool, async (client) => {
        await MessageConversationStateRepository.insertSettling(client, {
          messageId: filedReplyId,
          workspaceId: testWorkspaceId,
          streamId: threadId,
          conversationId: anchorConvId,
        })
        await MessageConversationStateRepository.settle(client, testWorkspaceId, [filedReplyId], "user")
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: targetConvId, isPrimary: true }],
        reassignments: [
          { messageId: anchorId, toConversationId: targetConvId, reason: "Part of the maintenance plan" },
        ],
        confidence: 0.9,
      })
      await service.processMessage(triggerId, testStreamId, testWorkspaceId)

      const primaries = await ConversationRepository.findPrimariesByMessageIds(pool, testWorkspaceId, [
        anchorId,
        replyId,
        filedReplyId,
      ])
      expect({
        anchor: primaries.get(anchorId)?.id,
        reply: primaries.get(replyId)?.id,
        filedReply: primaries.get(filedReplyId)?.id,
      }).toEqual({ anchor: targetConvId, reply: targetConvId, filedReply: anchorConvId })
    })

    test("should place an agent's reply in a message-anchored thread in the anchor's conversation", async () => {
      const { anchorId, threadId } = await seedMessageThread({
        anchorText: "@ariadne what changed in the release?",
        replyText: "Following along",
        sequence: BigInt(750),
      })
      const anchorConvId = conversationId()
      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: anchorConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, anchorConvId, anchorId, testUserId)
      })
      const agentReplyId = await insertPersonaReply(threadId)

      const result = await service.processMessage(agentReplyId, threadId, testWorkspaceId)

      expect({ conversationId: result?.id, extractCalls: stubExtractor.extractCallCount }).toEqual({
        conversationId: anchorConvId,
        extractCalls: 0,
      })
    })

    test("should bring a thread along when an agent's channel message is placed after its replies", async () => {
      const agentAnchorId = messageId()
      const threadId = streamId()
      const replyId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: agentAnchorId,
          streamId: testStreamId,
          sequence: BigInt(760),
          authorId: "persona_test",
          authorType: "persona",
          ...testMessageContent("The release notes are drafted"),
        })
        await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: testWorkspaceId,
          type: "thread",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
          parentStreamId: testStreamId,
          parentAnchorId: agentAnchorId,
          rootStreamId: testStreamId,
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: replyId,
          streamId: threadId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Add the migration note"),
        })
      })
      const threadConv = await service.processMessage(replyId, threadId, testWorkspaceId)

      const anchorConv = await service.processMessage(agentAnchorId, testStreamId, testWorkspaceId)

      const reply = await ConversationRepository.findPrimaryByMessageId(pool, testWorkspaceId, replyId)
      const folded = await ConversationRepository.findById(pool, testWorkspaceId, threadConv!.id)
      const events = await pool.query<{ event_type: string; payload: { conversationId?: string; messageId?: string } }>(
        sql`SELECT event_type, payload FROM outbox
            WHERE event_type IN ('conversation:updated', 'conversation:message_reassigned')
              AND (payload->>'conversationId' = ${threadConv!.id} OR payload->>'messageId' = ${replyId})
            ORDER BY id`
      )
      expect({
        replyConversationId: reply?.id,
        folded: { status: folded?.status, memberIds: folded?.messageIds },
        events: events.rows.map((r) => ({ type: r.event_type, payload: r.payload })),
      }).toEqual({
        replyConversationId: anchorConv!.id,
        folded: { status: ConversationStatuses.RESOLVED, memberIds: [] },
        events: [
          {
            type: "conversation:updated",
            payload: expect.objectContaining({
              conversationId: threadConv!.id,
              conversation: expect.objectContaining({ messageIds: [] }),
            }),
          },
          {
            type: "conversation:message_reassigned",
            payload: expect.objectContaining({
              messageId: replyId,
              streamId: threadId,
              fromConversationId: threadConv!.id,
              toConversationId: anchorConv!.id,
              reason: "thread_follows_anchor",
            }),
          },
        ],
      })
    })

    test("should bring a reply's own thread along when the anchor is placed", async () => {
      const { anchorId, threadId, replyId } = await seedMessageThread({
        anchorText: "Rotating the API keys this week",
        replyText: "Which services read them?",
        sequence: BigInt(770),
      })
      const nestedThreadId = streamId()
      const nestedReplyId = messageId()
      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: nestedThreadId,
          workspaceId: testWorkspaceId,
          type: "thread",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
          parentStreamId: threadId,
          parentAnchorId: replyId,
          rootStreamId: testStreamId,
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: nestedReplyId,
          streamId: nestedThreadId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("The billing worker and the importer"),
        })
      })
      const threadConv = await service.processMessage(replyId, threadId, testWorkspaceId)
      await service.processMessage(nestedReplyId, nestedThreadId, testWorkspaceId)

      const anchorConv = await service.processMessage(anchorId, testStreamId, testWorkspaceId)

      const primaries = await ConversationRepository.findPrimariesByMessageIds(pool, testWorkspaceId, [
        replyId,
        nestedReplyId,
      ])
      const folded = await ConversationRepository.findById(pool, testWorkspaceId, threadConv!.id)
      expect({
        reply: primaries.get(replyId)?.id,
        nestedReply: primaries.get(nestedReplyId)?.id,
        foldedStatus: folded?.status,
      }).toEqual({
        reply: anchorConv!.id,
        nestedReply: anchorConv!.id,
        foldedStatus: ConversationStatuses.RESOLVED,
      })
    })

    test("should bring a deleted reply along so the thread's conversation empties", async () => {
      const { anchorId, threadId, replyId } = await seedMessageThread({
        anchorText: "Dropping the staging cluster on Friday",
        replyText: "Wait, the demo runs there",
        sequence: BigInt(780),
      })
      const threadConv = await service.processMessage(replyId, threadId, testWorkspaceId)
      await pool.query(sql`UPDATE messages SET deleted_at = NOW() WHERE id = ${replyId}`)

      const anchorConv = await service.processMessage(anchorId, testStreamId, testWorkspaceId)

      const folded = await ConversationRepository.findById(pool, testWorkspaceId, threadConv!.id)
      const anchorMembers = await ConversationRepository.findById(pool, testWorkspaceId, anchorConv!.id)
      expect({ foldedStatus: folded?.status, anchorMemberIds: anchorMembers?.messageIds }).toEqual({
        foldedStatus: ConversationStatuses.RESOLVED,
        anchorMemberIds: [anchorId, replyId],
      })
    })

    test("should leave a thread a human split off where it is when its anchor moves", async () => {
      const { anchorId, threadId, replyId } = await seedMessageThread({
        anchorText: "Load balancer config review",
        replyText: "The health check path is wrong",
        sequence: BigInt(791),
      })
      const openerId = messageId()
      const triggerId = messageId()
      const anchorConvId = conversationId()
      const targetConvId = conversationId()
      await withTransaction(pool, async (client) => {
        await StreamMemberRepository.insert(client, testWorkspaceId, testStreamId, testUserId)
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: openerId,
          streamId: testStreamId,
          sequence: BigInt(790),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Starting the infra audit"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: triggerId,
          streamId: testStreamId,
          sequence: BigInt(792),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Folding the LB review into the infra audit"),
        })
        await ConversationRepository.insert(client, {
          id: anchorConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, anchorConvId, anchorId, testUserId)
        await ConversationRepository.insert(client, {
          id: targetConvId,
          streamId: testStreamId,
          workspaceId: testWorkspaceId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, targetConvId, openerId, testUserId)
      })
      await service.processMessage(replyId, threadId, testWorkspaceId)
      const { conversation: splitConv } = await new ConversationService(pool).splitThreadIntoConversation({
        workspaceId: testWorkspaceId,
        conversationId: anchorConvId,
        threadStreamId: threadId,
        actorUserId: testUserId,
      })

      stubExtractor.setNextResult({
        assignments: [{ conversationId: targetConvId, isPrimary: true }],
        reassignments: [{ messageId: anchorId, toConversationId: targetConvId, reason: "Part of the audit" }],
        confidence: 0.9,
      })
      await service.processMessage(triggerId, testStreamId, testWorkspaceId)

      const primaries = await ConversationRepository.findPrimariesByMessageIds(pool, testWorkspaceId, [
        anchorId,
        replyId,
      ])
      expect({ anchor: primaries.get(anchorId)?.id, reply: primaries.get(replyId)?.id }).toEqual({
        anchor: targetConvId,
        reply: splitConv.id,
      })
    })

    test("replies under an event-anchored (card) thread reach the parent-stream extraction context", async () => {
      // A delegation card lives in the parent channel; its discussion thread
      // anchors on the card's EVENT id (not a message). A reply in that thread
      // must join the parent stream's extraction candidate set — the candidate
      // anchors include threadable card event ids, not only message ids.
      const cardThreadStreamId = streamId()
      const cardThreadReplyId = messageId()

      // Insert the card first to read back its allocated sequence, then bracket
      // the surrounding messages around it (messages share the event sequence
      // space) so it deterministically falls inside the extraction window.
      const cardEvent = await withTransaction(pool, async (client) => {
        return StreamEventRepository.insert(client, {
          id: eventId(),
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          eventType: "delegation:created",
          payload: { delegationId: "dlg_x", title: "Do a thing", brief: "b", contextRefs: [] },
          actorId: testUserId,
          actorType: "user",
        })
      })
      const cardSeq = cardEvent.sequence
      const priorMsgId = messageId()
      const triggerMsgId = messageId()

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: priorMsgId,
          streamId: testStreamId,
          sequence: cardSeq - 1n,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Before the card"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: triggerMsgId,
          streamId: testStreamId,
          sequence: cardSeq + 1n,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("New message near the card"),
        })
        // Thread anchored on the card event, with one live reply.
        await StreamRepository.insert(client, {
          id: cardThreadStreamId,
          workspaceId: testWorkspaceId,
          type: "thread",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
          parentStreamId: testStreamId,
          parentAnchorId: cardEvent.id,
        })
        await StreamRepository.bumpThreadReplyCount(client, testWorkspaceId, cardThreadStreamId, 1)
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: cardThreadReplyId,
          streamId: cardThreadStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("A reply under the delegation card"),
        })
      })

      await service.processMessage(triggerMsgId, testStreamId, testWorkspaceId)

      // The card thread's reply is present in the extraction context (it would be
      // absent if the candidate anchors were message-only).
      const contextMessageIds = stubExtractor.lastContext?.recentMessages.map((m) => m.id) ?? []
      expect(contextMessageIds).toContain(cardThreadReplyId)
    })

    async function seedLongThread(replyTexts: string[]) {
      const anchorMsgId = messageId()
      const triggerMsgId = messageId()
      const threadId = streamId()
      const replyIds = replyTexts.map(() => messageId())
      const start = Date.now() - 60 * 60 * 1000

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: anchorMsgId,
          streamId: testStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("A post that grew a long thread"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: triggerMsgId,
          streamId: testStreamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Next post in the channel"),
        })
        await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: testWorkspaceId,
          type: "thread",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
          parentStreamId: testStreamId,
          parentAnchorId: anchorMsgId,
        })
        await StreamRepository.bumpThreadReplyCount(client, testWorkspaceId, threadId, replyIds.length)
        for (const [i, id] of replyIds.entries()) {
          await MessageRepository.insert(client, {
            workspaceId: testWorkspaceId,
            id,
            streamId: threadId,
            sequence: BigInt(i + 1),
            authorId: testUserId,
            authorType: "user",
            createdAt: new Date(start + i * 60_000),
            ...testMessageContent(replyTexts[i]),
          })
        }
      })

      await service.processMessage(triggerMsgId, testStreamId, testWorkspaceId)

      const shownReplyIds = (stubExtractor.lastContext?.recentMessages ?? [])
        .filter((m) => m.streamId === threadId)
        .map((m) => m.id)
      return { replyIds, shownReplyIds }
    }

    test("should show at most a nearby thread's thirty latest replies when they are short", async () => {
      const { replyIds, shownReplyIds } = await seedLongThread(Array.from({ length: 35 }, (_, i) => `Reply ${i + 1}`))

      expect(shownReplyIds).toEqual(replyIds.slice(5))
    })

    test("should show at least a nearby thread's five latest replies when they are long", async () => {
      const { replyIds, shownReplyIds } = await seedLongThread(
        Array.from({ length: 8 }, (_, i) => `Reply ${i + 1} `.repeat(150))
      )

      expect(shownReplyIds).toEqual(replyIds.slice(3))
    })

    test("should fill a nearby thread's character budget with its latest replies", async () => {
      const { replyIds, shownReplyIds } = await seedLongThread(
        Array.from({ length: 12 }, (_, i) => `Reply ${String(i + 1).padStart(2, "0")} `.repeat(50))
      )

      expect(shownReplyIds).toEqual(replyIds.slice(4))
    })

    /** A shared channel: a linked message, a thread under it, and a card-anchored thread outside the tree. */
    async function seedSharedChannel() {
      const sharedStreamId = streamId()
      const replyThreadStreamId = streamId()
      const cardThreadStreamId = streamId()
      const priorMsgId = messageId()
      const triggerMsgId = messageId()
      const threadReplyId = messageId()
      const cardThreadReplyId = messageId()
      const prUrl = "https://github.com/acme/private/pull/7"

      const cardEvent = await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: sharedStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })
        await client.query(
          sql`INSERT INTO stream_connections (workspace_id, id, role, state, stream_id, remote_workspace_id, remote_workspace_name, expires_at, revision)
              VALUES (${testWorkspaceId}, ${streamConnectionId()}, 'host', 'active', ${sharedStreamId}, ${workspaceId()}, 'Partner', NOW() + INTERVAL '1 day', 1)`
        )
        return StreamEventRepository.insert(client, {
          id: eventId(),
          workspaceId: testWorkspaceId,
          streamId: sharedStreamId,
          eventType: "delegation:created",
          payload: { delegationId: "dlg_x", title: "Do a thing", brief: "b", contextRefs: [] },
          actorId: testUserId,
          actorType: "user",
        })
      })

      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: priorMsgId,
          streamId: sharedStreamId,
          sequence: cardEvent.sequence - 1n,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Before the card"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: triggerMsgId,
          streamId: sharedStreamId,
          sequence: cardEvent.sequence + 1n,
          authorId: testUserId,
          authorType: "user",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see " },
                  { type: "channelLink", attrs: { id: testStreamId, slug: "outside" } },
                  { type: "text", text: ` per ${prUrl}` },
                ],
              },
            ],
          },
          contentMarkdown: `see [#outside](channel:${testStreamId}) per ${prUrl}`,
        })
        await seedCompletedLinkPreview(client, {
          workspaceId: testWorkspaceId,
          messageId: triggerMsgId,
          url: prUrl,
          title: "Rotate the prod password",
        })
        for (const [threadId, anchorId, replyId] of [
          [replyThreadStreamId, priorMsgId, threadReplyId],
          [cardThreadStreamId, cardEvent.id, cardThreadReplyId],
        ]) {
          await StreamRepository.insert(client, {
            id: threadId,
            workspaceId: testWorkspaceId,
            type: "thread",
            visibility: "private",
            companionMode: "off",
            createdBy: testUserId,
            parentStreamId: sharedStreamId,
            rootStreamId: sharedStreamId,
            parentAnchorId: anchorId,
          })
          await StreamRepository.bumpThreadReplyCount(client, testWorkspaceId, threadId, 1)
          await MessageRepository.insert(client, {
            workspaceId: testWorkspaceId,
            id: replyId,
            streamId: threadId,
            sequence: BigInt(1),
            authorId: testUserId,
            authorType: "user",
            ...testMessageContent("A reply"),
          })
        }
      })

      return { sharedStreamId, replyThreadStreamId, priorMsgId, triggerMsgId, threadReplyId, cardThreadReplyId }
    }

    test("should read the channel as its partner does when the channel is shared", async () => {
      const { sharedStreamId, priorMsgId, triggerMsgId, threadReplyId } = await seedSharedChannel()

      await service.processMessage(triggerMsgId, sharedStreamId, testWorkspaceId)

      expect({
        newMessage: stubExtractor.lastContext?.newMessage.contentMarkdown,
        recentMessageIds: stubExtractor.lastContext?.recentMessages.map((m) => m.id).toSorted(),
        linkPreviews: [...(stubExtractor.lastContext?.linkPreviewsByMessageId?.values() ?? [])].flat(),
      }).toEqual({
        newMessage: "see #outside per https://github.com/acme/private/pull/7",
        recentMessageIds: [priorMsgId, triggerMsgId, threadReplyId].toSorted(),
        linkPreviews: [],
      })
    })

    test("should skip a message moved out of the channel when the channel is shared", async () => {
      const { sharedStreamId } = await seedSharedChannel()
      const movedMsgId = messageId()
      await MessageRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        id: movedMsgId,
        streamId: testStreamId,
        sequence: BigInt(900),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Moved elsewhere"),
      })
      stubExtractor.resetCallCount()

      const conversation = await service.processMessage(movedMsgId, sharedStreamId, testWorkspaceId)

      expect({ conversation, extractCalls: stubExtractor.extractCallCount }).toEqual({
        conversation: null,
        extractCalls: 0,
      })
    })

    test("should propose a split from what the partner reads when the channel is shared", async () => {
      const { sharedStreamId, priorMsgId, triggerMsgId, threadReplyId, cardThreadReplyId } = await seedSharedChannel()
      const convId = conversationId()
      const deletedMsgId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: deletedMsgId,
          streamId: sharedStreamId,
          sequence: BigInt(9000),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Acquire Initech quietly"),
        })
        await MessageRepository.softDelete(client, testWorkspaceId, deletedMsgId)
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: sharedStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Outside work",
          summary: "Planning the Initech deal",
        })
        for (const id of [priorMsgId, triggerMsgId, threadReplyId, cardThreadReplyId, deletedMsgId]) {
          await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, id, testUserId)
        }
      })

      await service.proposeSplit(convId, testWorkspaceId)

      expect({
        topicSummary: stubExtractor.lastSplitContext?.topicSummary,
        summary: stubExtractor.lastSplitContext?.summary,
        messages: stubExtractor.lastSplitContext?.messages.map((m) => [m.id, m.contentMarkdown]).toSorted(),
      }).toEqual({
        topicSummary: null,
        summary: null,
        messages: [
          [priorMsgId, "Before the card"],
          [triggerMsgId, "see #outside per https://github.com/acme/private/pull/7"],
          [threadReplyId, "A reply"],
        ].toSorted(),
      })
    })

    test("should quote what the partner reads when the channel is shared", async () => {
      const { sharedStreamId, triggerMsgId } = await seedSharedChannel()
      const convId = conversationId()
      const deletedMsgId = messageId()
      const quotingMsgId = messageId()
      const quote = (quotedId: string, snippet: string) => ({
        type: "quoteReply",
        attrs: {
          messageId: quotedId,
          streamId: sharedStreamId,
          authorName: "Host",
          authorId: testUserId,
          actorType: "user",
          snippet,
          version: 1,
          range: null,
        },
      })
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: deletedMsgId,
          streamId: sharedStreamId,
          sequence: BigInt(9000),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Acquire Initech quietly"),
        })
        await MessageRepository.softDelete(client, testWorkspaceId, deletedMsgId)
        await ConversationRepository.insert(client, {
          id: convId,
          streamId: sharedStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Rollout",
          sharedRootStreamId: sharedStreamId,
        })
        for (const id of [triggerMsgId, deletedMsgId]) {
          await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, id, testUserId)
        }
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: quotingMsgId,
          streamId: sharedStreamId,
          sequence: BigInt(9001),
          authorId: testUserId,
          authorType: "user",
          contentJson: {
            type: "doc",
            content: [
              quote(triggerMsgId, "see"),
              quote(deletedMsgId, "Acquire"),
              { type: "paragraph", content: [{ type: "text", text: "agreed" }] },
            ],
          },
          contentMarkdown: "agreed",
        })
      })

      await service.processMessage(quotingMsgId, sharedStreamId, testWorkspaceId)

      expect(stubExtractor.lastContext?.replyTargets).toEqual([
        {
          quotedMessageId: triggerMsgId,
          conversationId: convId,
          topicSummary: "Rollout",
          snippet: "see #outside per https://github.com/acme/private/pull/7",
        },
      ])
    })
    test("should show a title and summary only when written while shared, and stamp new ones with the channel, when the channel is shared", async () => {
      const { sharedStreamId, replyThreadStreamId, priorMsgId, triggerMsgId, threadReplyId } = await seedSharedChannel()
      const preShareId = conversationId()
      const sharedId = conversationId()
      const laterReplyId = messageId()
      await withTransaction(pool, async (client) => {
        await ConversationRepository.insert(client, {
          id: preShareId,
          streamId: sharedStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Initech plan",
          summary: "Acquire Initech quietly",
          status: ConversationStatuses.ACTIVE,
        })
        await ConversationRepository.insert(client, {
          id: sharedId,
          streamId: replyThreadStreamId,
          workspaceId: testWorkspaceId,
          topicSummary: "Rollout",
          summary: "Rolling out on Friday",
          status: ConversationStatuses.ACTIVE,
          sharedRootStreamId: sharedStreamId,
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, preShareId, priorMsgId, testUserId)
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, sharedId, threadReplyId, testUserId)
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: laterReplyId,
          streamId: replyThreadStreamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Another reply"),
        })
      })
      stubExtractor.setNextResult({
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: "Card links",
        newConversationSummary: "Where the links point",
        confidence: 0.8,
      })

      const inChannel = await service.processMessage(triggerMsgId, sharedStreamId, testWorkspaceId)
      const active = stubExtractor.lastContext?.activeConversations.map((c) => [c.id, c.topicSummary, c.summary])
      const inThread = await service.processMessage(laterReplyId, replyThreadStreamId, testWorkspaceId)
      const { rows: stamps } = await pool.query(
        `SELECT topic_summary_shared_root_stream_id, summary_shared_root_stream_id FROM conversations
         WHERE workspace_id = $1 AND id = ANY($2)`,
        [testWorkspaceId, [inChannel!.id]]
      )

      expect({ active: active?.toSorted(), inThread: inThread?.id, stamps }).toEqual({
        active: [
          [preShareId, null, null],
          [sharedId, "Rollout", "Rolling out on Friday"],
        ].toSorted(),
        inThread: preShareId,
        stamps: [
          {
            topic_summary_shared_root_stream_id: sharedStreamId,
            summary_shared_root_stream_id: sharedStreamId,
          },
        ],
      })
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
          workspaceId: testWorkspaceId,
          id: msg0Id,
          streamId: testStreamId,
          sequence: BigInt(299),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Topic B opener"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(300),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Topic A start"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
        return ConversationRepository.findById(client, testWorkspaceId, convAId)
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
          workspaceId: testWorkspaceId,
          id: msg1Id,
          streamId: testStreamId,
          sequence: BigInt(400),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Initial"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
        return ConversationRepository.findById(client, testWorkspaceId, convAId)
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
          workspaceId: testWorkspaceId,
          id: msg0Id,
          streamId: testStreamId,
          sequence: BigInt(499),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Topic B opener"),
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
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
          workspaceId: testWorkspaceId,
          id: msg2Id,
          streamId: localStreamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Second note"),
        })

        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
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

    test("reuses and reactivates a sweep-faded scratchpad conversation instead of minting a second", async () => {
      const localStreamId = streamId()
      const msg1Id = messageId()
      const msg2Id = messageId()

      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          displayName: "Long-lived notes",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: msg1Id,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("First note"),
        })
      })

      const result1 = await service.processMessage(msg1Id, localStreamId, testWorkspaceId)
      const conversationId1 = result1!.id

      // The staleness sweep faded the scratchpad's conversation.
      await withTransaction(pool, async (client) => {
        await client.query(sql`UPDATE conversations SET status = 'stalled' WHERE id = ${conversationId1}`)
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: msg2Id,
          streamId: localStreamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Back after a week"),
        })
      })

      const result2 = await service.processMessage(msg2Id, localStreamId, testWorkspaceId)

      // Same conversation, live again — never a second same-named card.
      expect(result2?.id).toBe(conversationId1)
      expect(result2?.status).toBe("active")
      expect(result2?.messageIds).toContain(msg2Id)
    })

    async function seedScratchpadWithConversation(): Promise<{ streamId: string; conversationId: string }> {
      const localStreamId = streamId()
      const msgId = messageId()
      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          displayName: "Notes",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("First note"),
        })
      })
      const first = await service.processMessage(msgId, localStreamId, testWorkspaceId)
      return { streamId: localStreamId, conversationId: first!.id }
    }

    test("joins the active scratchpad conversation when an agent replies", async () => {
      const seeded = await seedScratchpadWithConversation()
      const replyId = await insertPersonaReply(seeded.streamId)

      const result = await service.processMessage(replyId, seeded.streamId, testWorkspaceId)

      expect({ id: result?.id, created: await countConversations(seeded.streamId) }).toEqual({
        id: seeded.conversationId,
        created: 1,
      })
    })

    test("reuses a faded scratchpad conversation when an agent replies", async () => {
      const seeded = await seedScratchpadWithConversation()
      await pool.query(sql`UPDATE conversations SET status = 'stalled' WHERE id = ${seeded.conversationId}`)
      const replyId = await insertPersonaReply(seeded.streamId)

      const result = await service.processMessage(replyId, seeded.streamId, testWorkspaceId)

      expect({ id: result?.id, created: await countConversations(seeded.streamId) }).toEqual({
        id: seeded.conversationId,
        created: 1,
      })
    })

    test("joins the conversation a concurrent pass created after this pass looked", async () => {
      const seeded = await seedScratchpadWithConversation()
      const msgId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          workspaceId: testWorkspaceId,
          id: msgId,
          streamId: seeded.streamId,
          sequence: BigInt(2),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Second note"),
        })
      })
      try {
        const realFindByStream = ConversationRepository.findByStream.bind(ConversationRepository)
        let lookups = 0
        spyOn(ConversationRepository, "findByStream").mockImplementation(async (...args) =>
          lookups++ === 0 ? [] : realFindByStream(...args)
        )

        const result = await service.processMessage(msgId, seeded.streamId, testWorkspaceId)

        expect({ id: result?.id, created: await countConversations(seeded.streamId) }).toEqual({
          id: seeded.conversationId,
          created: 1,
        })
      } finally {
        mock.restore()
      }
    })

    test("leaves the conversation topic null when the scratchpad stream has a title", async () => {
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
          workspaceId: testWorkspaceId,
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Some ideas"),
        })
      })

      const result = await service.processMessage(msgId, localStreamId, testWorkspaceId)

      // The scratchpad stream is the sole title owner. Copying its title here
      // creates a second, independently mutable source of truth.
      expect(result?.topicSummary).toBeNull()
    })

    test("leaves the conversation topic null when the scratchpad stream is unnamed", async () => {
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
          workspaceId: testWorkspaceId,
          id: msgId,
          streamId: localStreamId,
          sequence: BigInt(1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Test message"),
        })
      })

      const result = await service.processMessage(msgId, localStreamId, testWorkspaceId)

      // Generic UI fallback text is derived at read time, never persisted as
      // an independently owned conversation title.
      expect(result?.topicSummary).toBeNull()
    })
  })
})
