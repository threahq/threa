/**
 * "Keep here": the user confirms a provisionally-placed message belongs where
 * the extractor put it. Real schema (INV-68) — the settle flip, the from==to
 * feedback row, the `conversation:updated` event, and the endpoint's access
 * posture (which mirrors reassign, INV-62).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository, StreamService } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import {
  ConversationRepository,
  ConversationService,
  MessageConversationStateRepository,
  createConversationHandlers,
} from "../../src/features/conversations"
import { sql } from "../../src/db"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"

function mockReq(overrides: Record<string, unknown>) {
  return { query: {}, body: {}, params: {}, ...overrides } as never
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.body = data
      return res
    },
  }
  return res
}

describe("settle message endpoint", () => {
  let pool: Pool
  let service: ConversationService
  let handlers: ReturnType<typeof createConversationHandlers>
  let testUserId: string
  let outsiderId: string
  let testWorkspaceId: string
  let otherWorkspaceId: string
  let testStreamId: string
  let threadStreamId: string
  let seq = 1n

  const insertMessage = async (streamIdForRow: string, text: string) => {
    const id = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id,
        streamId: streamIdForRow,
        sequence: seq++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent(text),
      })
    })
    return id
  }

  /** A conversation holding one message, whose placement is still settling. */
  const seedSettling = async (convStreamId: string, msgStreamId = convStreamId) => {
    const convId = conversationId()
    const msgId = await insertMessage(msgStreamId, "Provisionally placed")
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id: convId,
        streamId: convStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Uncertain",
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, msgId, testUserId)
      await MessageConversationStateRepository.insertSettling(client, {
        messageId: msgId,
        workspaceId: testWorkspaceId,
        streamId: msgStreamId,
        conversationId: convId,
      })
    })
    return { convId, msgId }
  }

  const stateRow = async (id: string) => {
    const result = await pool.query(sql`SELECT * FROM message_conversation_state WHERE message_id = ${id}`)
    return result.rows[0] ?? null
  }
  const feedbackRows = async () => (await pool.query("SELECT * FROM conversation_feedback")).rows
  const updatedEvents = async () =>
    (await pool.query("SELECT payload FROM outbox WHERE event_type = 'conversation:updated'")).rows

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    outsiderId = userId()
    testWorkspaceId = workspaceId()
    otherWorkspaceId = workspaceId()
    testStreamId = streamId()
    threadStreamId = streamId()

    await withTransaction(pool, async (client) => {
      for (const [id, name] of [
        [testWorkspaceId, "Settle Workspace"],
        [otherWorkspaceId, "Other Workspace"],
      ] as const) {
        await WorkspaceRepository.insert(client, {
          id,
          name,
          slug: `settle-ws-${id}`,
          createdBy: testUserId,
        })
      }
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      outsiderId = (await addTestMember(client, testWorkspaceId, outsiderId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await StreamMemberRepository.insert(client, testStreamId, testUserId)
      // A thread under the private channel: access is inherited from the root
      // (INV-62), so a channel member reaches it without a membership row of
      // its own and an outsider reaches neither.
      await StreamRepository.insert(client, {
        id: threadStreamId,
        workspaceId: testWorkspaceId,
        type: "thread",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
        parentStreamId: testStreamId,
        rootStreamId: testStreamId,
      })
    })

    service = new ConversationService(pool)
    handlers = createConversationHandlers({
      conversationService: service,
      boundaryExtractionService: {} as never,
      boardExclusionService: {} as never,
      streamService: new StreamService(pool),
    } as never)
  })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(async () => {
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM message_conversation_state")
      await client.query("DELETE FROM outbox")
      await client.query("DELETE FROM conversation_feedback")
      await client.query("DELETE FROM conversations")
      await client.query("DELETE FROM messages")
    })
  })

  test("a keep-here settles the row, records from==to feedback, and drops it from the settling set", async () => {
    const { convId, msgId } = await seedSettling(testStreamId)

    const result = await service.settleMessage({
      workspaceId: testWorkspaceId,
      conversationId: convId,
      messageId: msgId,
      userId: testUserId,
    })

    const row = await stateRow(msgId)
    expect({ state: row?.state, settledBy: row?.settled_by, conversationId: row?.conversation_id }).toEqual({
      state: "settled",
      settledBy: "user",
      conversationId: convId,
    })

    const feedback = await feedbackRows()
    expect(feedback.length).toBe(1)
    expect({
      from: feedback[0].from_conversation_id,
      to: feedback[0].to_conversation_id,
      messageId: feedback[0].message_id,
      userId: feedback[0].user_id,
      streamId: feedback[0].stream_id,
    }).toEqual({
      from: convId,
      to: convId,
      messageId: msgId,
      userId: testUserId,
      streamId: testStreamId,
    })

    // INV-23: assert on the event's content, not a count.
    const events = await updatedEvents()
    const forConversation = events.map((r) => r.payload).filter((p) => p.conversationId === convId)
    expect(forConversation.length).toBe(1)
    expect(forConversation[0].settlingMessageIds).toEqual([])

    expect(result.settlingMessageIds).toEqual([])
    expect(result.previousConversation).toBeNull()
    expect(result.conversation.id).toBe(convId)
  })

  test("an already-settled row writes no feedback and emits no event", async () => {
    const { convId, msgId } = await seedSettling(testStreamId)
    await withTransaction(pool, async (client) => {
      await MessageConversationStateRepository.settle(client, testWorkspaceId, [msgId], "llm-window")
    })
    await pool.query("DELETE FROM outbox")

    const result = await service.settleMessage({
      workspaceId: testWorkspaceId,
      conversationId: convId,
      messageId: msgId,
      userId: testUserId,
    })

    expect(await feedbackRows()).toEqual([])
    expect(await updatedEvents()).toEqual([])
    expect((await stateRow(msgId))?.settled_by).toBe("llm-window")
    expect(result.conversation.id).toBe(convId)
    expect(result.settlingMessageIds).toEqual([])
  })

  test("a conversation in another workspace is not found", async () => {
    const { convId, msgId } = await seedSettling(testStreamId)

    const res = mockRes()
    await handlers.settleMessage(
      mockReq({
        user: { id: testUserId },
        workspaceId: otherWorkspaceId,
        params: { conversationId: convId, messageId: msgId },
      }),
      res as never
    )

    expect({ status: res.statusCode, body: res.body }).toEqual({
      status: 404,
      body: { error: "Conversation not found" },
    })
    expect((await stateRow(msgId))?.state).toBe("settling")
  })

  test("a non-member of the private channel is refused", async () => {
    const { convId, msgId } = await seedSettling(testStreamId)

    const res = mockRes()
    await expect(
      handlers.settleMessage(
        mockReq({
          user: { id: outsiderId },
          workspaceId: testWorkspaceId,
          params: { conversationId: convId, messageId: msgId },
        }),
        res as never
      )
    ).rejects.toThrow()

    expect((await stateRow(msgId))?.state).toBe("settling")
  })

  test("a channel member reaches a conversation anchored in the channel's thread (INV-62)", async () => {
    const { convId, msgId } = await seedSettling(threadStreamId)

    const res = mockRes()
    await handlers.settleMessage(
      mockReq({
        user: { id: testUserId },
        workspaceId: testWorkspaceId,
        params: { conversationId: convId, messageId: msgId },
      }),
      res as never
    )

    expect(res.statusCode).toBe(200)
    expect((await stateRow(msgId))?.settled_by).toBe("user")
  })

  test("a message that isn't in the conversation is not found", async () => {
    const { convId } = await seedSettling(testStreamId)
    const strayId = await insertMessage(testStreamId, "Elsewhere")

    await expect(
      service.settleMessage({
        workspaceId: testWorkspaceId,
        conversationId: convId,
        messageId: strayId,
        userId: testUserId,
      })
    ).rejects.toThrow("Message not found")
    expect(await feedbackRows()).toEqual([])
  })
})
