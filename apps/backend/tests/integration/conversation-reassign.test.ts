/**
 * ConversationService.reassignMessage Integration Tests
 *
 * User corrections from the timeline conversation overlay: moving a message's
 * primary membership to another conversation must update both membership
 * arrays, record a conversation_feedback row (ground truth for the boundary
 * extractor), and emit outbox events for real-time delivery (INV-4, INV-7).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository, ConversationService } from "../../src/features/conversations"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"

describe("ConversationService.reassignMessage", () => {
  let pool: Pool
  let service: ConversationService
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

    service = new ConversationService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(async () => {
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM outbox")
      await client.query("DELETE FROM conversation_feedback")
      await client.query("DELETE FROM conversations")
      await client.query("DELETE FROM messages")
      await client.query(`DELETE FROM streams WHERE id != '${testStreamId}'`)
    })
  })

  /** Insert two conversations (A owning msg1+msg2, B owning msg0) in the shared test stream. */
  async function seedTwoConversations() {
    const convAId = conversationId()
    const convBId = conversationId()
    const msg0Id = messageId()
    const msg1Id = messageId()
    const msg2Id = messageId()

    await withTransaction(pool, async (client) => {
      for (const [id, seq, content] of [
        [msg0Id, 1, "Topic B opener"],
        [msg1Id, 2, "Topic A start"],
        [msg2Id, 3, "Ambiguous follow-up"],
      ] as const) {
        await MessageRepository.insert(client, {
          id,
          streamId: testStreamId,
          sequence: BigInt(seq),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(content),
        })
      }

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
    })

    return { convAId, convBId, msg0Id, msg1Id, msg2Id }
  }

  test("moves primary membership and returns both updated conversations", async () => {
    const { convAId, convBId, msg2Id, msg0Id, msg1Id } = await seedTwoConversations()

    const result = await service.reassignMessage({
      workspaceId: testWorkspaceId,
      conversationId: convBId,
      messageId: msg2Id,
      userId: testUserId,
    })

    expect(result.conversation).toMatchObject({ id: convBId, messageIds: [msg0Id, msg2Id] })
    expect(result.previousConversation).toMatchObject({ id: convAId, messageIds: [msg1Id] })

    const convA = await withTransaction(pool, (client) => ConversationRepository.findById(client, convAId))
    const convB = await withTransaction(pool, (client) => ConversationRepository.findById(client, convBId))
    expect(convA?.messageIds).toEqual([msg1Id])
    expect(convB?.messageIds).toEqual([msg0Id, msg2Id])
  })

  test("records a conversation_feedback row for the correction", async () => {
    const { convAId, convBId, msg2Id } = await seedTwoConversations()

    await service.reassignMessage({
      workspaceId: testWorkspaceId,
      conversationId: convBId,
      messageId: msg2Id,
      userId: testUserId,
    })

    const feedback = await withTransaction(pool, async (client) => {
      const res = await client.query(`SELECT * FROM conversation_feedback`)
      return res.rows
    })
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toMatchObject({
      workspace_id: testWorkspaceId,
      stream_id: testStreamId,
      message_id: msg2Id,
      from_conversation_id: convAId,
      to_conversation_id: convBId,
      user_id: testUserId,
    })
  })

  test("emits conversation:updated for both conversations and a user_correction reassigned event", async () => {
    const { convAId, convBId, msg2Id } = await seedTwoConversations()

    await service.reassignMessage({
      workspaceId: testWorkspaceId,
      conversationId: convBId,
      messageId: msg2Id,
      userId: testUserId,
    })

    const events = await withTransaction(pool, async (client) => {
      const res = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox`
      )
      return res.rows
    })

    const updated = events.filter((e) => e.event_type === "conversation:updated")
    expect(updated.map((e) => e.payload.conversationId)).toEqual(expect.arrayContaining([convAId, convBId]))

    const reassigned = events.find((e) => e.event_type === "conversation:message_reassigned")
    expect(reassigned?.payload).toMatchObject({
      streamId: testStreamId,
      messageId: msg2Id,
      fromConversationId: convAId,
      toConversationId: convBId,
      reason: "user_correction",
    })
  })

  test("assigns a message that has no primary conversation yet", async () => {
    const { convBId } = await seedTwoConversations()
    const orphanMsgId = messageId()

    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: orphanMsgId,
        streamId: testStreamId,
        sequence: BigInt(10),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Not yet extracted"),
      })
    })

    const result = await service.reassignMessage({
      workspaceId: testWorkspaceId,
      conversationId: convBId,
      messageId: orphanMsgId,
      userId: testUserId,
    })

    expect(result.conversation.messageIds).toContain(orphanMsgId)
    expect(result.previousConversation).toBeNull()

    const events = await withTransaction(pool, async (client) => {
      const res = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM outbox WHERE event_type = 'conversation:message_assigned'`
      )
      return res.rows
    })
    expect(events[0]?.payload).toMatchObject({
      messageId: orphanMsgId,
      conversationId: convBId,
      isPrimary: true,
      reason: "user_correction",
    })
  })

  test("no-ops when the message is already primary in the target conversation", async () => {
    const { convAId, msg2Id } = await seedTwoConversations()

    const result = await service.reassignMessage({
      workspaceId: testWorkspaceId,
      conversationId: convAId,
      messageId: msg2Id,
      userId: testUserId,
    })

    expect(result.conversation.id).toBe(convAId)
    expect(result.previousConversation).toBeNull()

    const counts = await withTransaction(pool, async (client) => {
      const feedback = await client.query(`SELECT COUNT(*)::int AS n FROM conversation_feedback`)
      const outbox = await client.query(`SELECT COUNT(*)::int AS n FROM outbox`)
      return { feedback: feedback.rows[0].n, outbox: outbox.rows[0].n }
    })
    expect(counts).toEqual({ feedback: 0, outbox: 0 })
  })

  test("rejects a message from a different stream than the conversation", async () => {
    const { convBId } = await seedTwoConversations()
    const otherStreamId = streamId()
    const foreignMsgId = messageId()

    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: otherStreamId,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await MessageRepository.insert(client, {
        id: foreignMsgId,
        streamId: otherStreamId,
        sequence: BigInt(1),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Lives elsewhere"),
      })
    })

    await expect(
      service.reassignMessage({
        workspaceId: testWorkspaceId,
        conversationId: convBId,
        messageId: foreignMsgId,
        userId: testUserId,
      })
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_IN_CONVERSATION_STREAM" })
  })

  test("rejects a conversation from a different workspace", async () => {
    const { convBId, msg2Id } = await seedTwoConversations()

    await expect(
      service.reassignMessage({
        workspaceId: workspaceId(), // some other workspace
        conversationId: convBId,
        messageId: msg2Id,
        userId: testUserId,
      })
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" })
  })
})
