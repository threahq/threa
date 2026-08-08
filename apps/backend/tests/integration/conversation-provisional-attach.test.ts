/**
 * Send-time provisional conversation attach: an UNDECLARED human message joins
 * the stream's most recent conversation in the send transaction, marked
 * settling, so the board sees it before the debounced extractor runs — and the
 * extractor can still overturn it. Real schema (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import {
  ConversationRepository,
  MessageConversationStateRepository,
  ConversationService,
  BoundaryExtractionService,
  conversationAssigner,
  PROVISIONAL_ATTACH_WINDOW_MINUTES,
} from "../../src/features/conversations"
import { sql } from "../../src/db"
import { userId, workspaceId, streamId, conversationId } from "../../src/lib/id"
import { ConversationIntents } from "@threa/types"
import type { BoundaryExtractor, ExtractionContext, ExtractionResult } from "../../src/features/conversations"

class StubExtractor implements BoundaryExtractor {
  next: ExtractionResult = {
    assignments: [{ conversationId: null, isPrimary: true }],
    newConversationTopic: "Topic",
    confidence: 0.9,
  }
  async extract(_context: ExtractionContext): Promise<ExtractionResult> {
    return this.next
  }
}

describe("provisional conversation attach", () => {
  let pool: Pool
  let cleanupDatabase: () => Promise<void>
  let eventService: EventService
  let extractor: StubExtractor
  let extraction: BoundaryExtractionService
  let conversationService: ConversationService
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let scratchpadId: string
  let otherUserId: string

  const send = async (
    text: string,
    overrides: {
      streamId?: string
      authorId?: string
      authorType?: "user" | "persona"
      conversation?: { intent: "existing"; conversationId: string }
    } = {}
  ) => {
    return eventService.createMessageReturningConversationInternal({
      workspaceId: testWorkspaceId,
      streamId: overrides.streamId ?? testStreamId,
      authorId: overrides.authorId ?? testUserId,
      authorType: overrides.authorType ?? "user",
      ...testMessageContent(text),
      ...(overrides.conversation ? { conversation: overrides.conversation } : {}),
    })
  }

  const seedConversation = async (params: {
    streamId?: string
    messageIds?: string[]
    lastActivityAt?: string
    authorId?: string
  }) => {
    const id = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id,
        streamId: params.streamId ?? testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Seeded",
      })
      if (params.messageIds?.length) {
        for (const messageId of params.messageIds) {
          await ConversationRepository.addPrimaryMessage(
            client,
            testWorkspaceId,
            id,
            messageId,
            params.authorId ?? testUserId
          )
        }
      }
      if (params.lastActivityAt) {
        await client.query(sql`
          UPDATE conversations SET last_activity_at = NOW() - ${params.lastActivityAt}::interval WHERE id = ${id}
        `)
      }
    })
    return id
  }

  const settlingRow = async (id: string) => {
    const result = await pool.query(sql`SELECT * FROM message_conversation_state WHERE message_id = ${id}`)
    return result.rows[0] ?? null
  }

  const conversationUpdatedPayloads = async () => {
    const result = await pool.query<{
      payload: { conversationId: string; settlingMessageIds: string[] }
    }>(sql`SELECT payload FROM outbox WHERE event_type = 'conversation:updated'`)
    return result.rows.map((r) => r.payload)
  }

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("provisional_attach")
    pool = isolated.pool
    cleanupDatabase = isolated.cleanup
    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()
    scratchpadId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Provisional Workspace",
        slug: `provisional-ws-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      otherUserId = (await addTestMember(client, testWorkspaceId, userId())).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await StreamMemberRepository.insert(client, testStreamId, testUserId)
      await StreamRepository.insert(client, {
        id: scratchpadId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await StreamMemberRepository.insert(client, scratchpadId, testUserId)
    })

    eventService = new EventService(pool, conversationAssigner)
    extractor = new StubExtractor()
    extraction = new BoundaryExtractionService(pool, extractor)
    conversationService = new ConversationService(pool)
  }, 120_000)

  afterAll(async () => {
    await cleanupDatabase()
  }, 120_000)

  afterEach(async () => {
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM message_conversation_state")
      await client.query("DELETE FROM outbox")
      await client.query("DELETE FROM conversation_feedback")
      await client.query("DELETE FROM conversations")
      await client.query("DELETE FROM stream_events")
      await client.query("DELETE FROM messages")
      await client.query(sql`DELETE FROM streams WHERE type = 'thread'`)
    })
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Topic",
      confidence: 0.9,
    }
  })

  test("an undeclared channel message joins the stream's recent conversation, settling, in the send transaction", async () => {
    const opener = await send("Opening message")
    const convId = await seedConversation({ messageIds: [opener.message.id] })
    await pool.query("DELETE FROM outbox")

    const sent = await send("Undeclared follow-up")

    const conversation = await ConversationRepository.findById(pool, convId)
    const row = await settlingRow(sent.message.id)
    expect({
      returnedConversationId: sent.conversationId,
      memberIds: conversation!.messageIds,
      state: row?.state,
      rowConversationId: row?.conversation_id,
      intent: (
        await pool.query<{ conversation_intent: string | null }>(
          sql`SELECT conversation_intent FROM messages WHERE id = ${sent.message.id}`
        )
      ).rows[0]!.conversation_intent,
    }).toEqual({
      returnedConversationId: convId,
      memberIds: [opener.message.id, sent.message.id],
      state: "settling",
      rowConversationId: convId,
      intent: null,
    })

    // Activity bumped and the aggregate broadcast carries the settling member.
    expect(conversation!.lastActivityAt.getTime()).toBeGreaterThan(0)
    expect(await conversationUpdatedPayloads()).toContainEqual(
      expect.objectContaining({ conversationId: convId, settlingMessageIds: [sent.message.id] })
    )
  })

  test("a candidate whose activity fell outside the window is not joined", async () => {
    const opener = await send("Old opener")
    const convId = await seedConversation({
      messageIds: [opener.message.id],
      lastActivityAt: `${PROVISIONAL_ATTACH_WINDOW_MINUTES + 5} minutes`,
    })

    const sent = await send("Much later message")

    const conversation = await ConversationRepository.findById(pool, convId)
    expect({
      returnedConversationId: sent.conversationId,
      memberIds: conversation!.messageIds,
      settling: await settlingRow(sent.message.id),
    }).toEqual({
      returnedConversationId: undefined,
      memberIds: [opener.message.id],
      settling: null,
    })
  })

  test("a stream with no conversation mints nothing", async () => {
    const sent = await send("First ever message")

    const conversations = await ConversationRepository.findByStream(pool, testStreamId)
    expect({
      returnedConversationId: sent.conversationId,
      conversationCount: conversations.length,
      settling: await settlingRow(sent.message.id),
    }).toEqual({ returnedConversationId: undefined, conversationCount: 0, settling: null })
  })

  test("a declared send takes the declared path and is never settling", async () => {
    const opener = await send("Opener")
    const convId = await seedConversation({ messageIds: [opener.message.id] })

    const sent = await send("Declared follow-up", {
      conversation: { intent: ConversationIntents.EXISTING, conversationId: convId },
    })

    const intent = await pool.query<{ conversation_intent: string | null }>(
      sql`SELECT conversation_intent FROM messages WHERE id = ${sent.message.id}`
    )
    expect({
      returnedConversationId: sent.conversationId,
      intent: intent.rows[0]!.conversation_intent,
      settling: await settlingRow(sent.message.id),
    }).toEqual({ returnedConversationId: convId, intent: ConversationIntents.EXISTING, settling: null })
  })

  test("a scratchpad message is never provisionally attached", async () => {
    const opener = await send("Scratch opener", { streamId: scratchpadId })
    const convId = await seedConversation({ streamId: scratchpadId, messageIds: [opener.message.id] })

    const sent = await send("Scratch follow-up", { streamId: scratchpadId })

    const conversation = await ConversationRepository.findById(pool, convId)
    expect({
      returnedConversationId: sent.conversationId,
      memberIds: conversation!.messageIds,
      settling: await settlingRow(sent.message.id),
    }).toEqual({ returnedConversationId: undefined, memberIds: [opener.message.id], settling: null })
  })

  test("an agent reply is never provisionally attached — its own assignment path is unchanged", async () => {
    const opener = await send("Human opener")
    const convId = await seedConversation({ messageIds: [opener.message.id] })

    const reply = await send("Agent reply", { authorType: "persona" })

    expect({
      returnedConversationId: reply.conversationId,
      settling: await settlingRow(reply.message.id),
    }).toEqual({ returnedConversationId: undefined, settling: null })

    // The deterministic agent-reply path still assigns it.
    const assigned = await extraction.processMessage(reply.message.id, testStreamId, testWorkspaceId)
    expect(assigned!.id).toBe(convId)
    expect(await settlingRow(reply.message.id)).toBeNull()
  })

  test("an undeclared thread reply joins the anchor message's conversation, settling", async () => {
    const anchor = await send("Anchor message")
    const convId = await seedConversation({ messageIds: [anchor.message.id] })
    const threadId = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: threadId,
        workspaceId: testWorkspaceId,
        type: "thread",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
        parentStreamId: testStreamId,
        parentAnchorId: anchor.message.id,
        rootStreamId: testStreamId,
      })
    })

    const reply = await send("Thread reply", { streamId: threadId })

    const conversation = await ConversationRepository.findById(pool, convId)
    const row = await settlingRow(reply.message.id)
    expect({
      returnedConversationId: reply.conversationId,
      memberIds: conversation!.messageIds,
      state: row?.state,
    }).toEqual({
      returnedConversationId: convId,
      memberIds: [anchor.message.id, reply.message.id],
      state: "settling",
    })
  })

  test("the extractor overturns a provisional attach — membership, participants, the settling row and the events all move", async () => {
    const opener = await send("Opener", { authorId: otherUserId })
    const guessedConvId = await seedConversation({ messageIds: [opener.message.id], authorId: otherUserId })
    const otherConvId = await seedConversation({})

    const sent = await send("Actually a different topic")
    expect(sent.conversationId).toBe(guessedConvId)
    await pool.query("DELETE FROM outbox")

    extractor.next = {
      assignments: [{ conversationId: otherConvId, isPrimary: true }],
      confidence: 0.4,
    }
    const decided = await extraction.processMessage(sent.message.id, testStreamId, testWorkspaceId)

    const guessed = await ConversationRepository.findById(pool, guessedConvId)
    const other = await ConversationRepository.findById(pool, otherConvId)
    const row = await settlingRow(sent.message.id)
    expect({
      decidedConversationId: decided?.id,
      guessedMembers: guessed!.messageIds,
      guessedParticipants: guessed!.participantIds,
      otherMembers: other!.messageIds,
      rowConversationId: row?.conversation_id,
      state: row?.state,
    }).toEqual({
      decidedConversationId: otherConvId,
      guessedMembers: [opener.message.id],
      // The evicted author is gone; the remaining message's author stays.
      guessedParticipants: [otherUserId],
      otherMembers: [sent.message.id],
      rowConversationId: otherConvId,
      state: "settling",
    })

    // INV-23: the move is announced, and both sides' aggregates are refreshed.
    const reassigned = await pool.query<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM outbox WHERE event_type = 'conversation:message_reassigned'`
    )
    expect(reassigned.rows.map((r) => r.payload)).toContainEqual(
      expect.objectContaining({
        messageId: sent.message.id,
        streamId: testStreamId,
        fromConversationId: guessedConvId,
        toConversationId: otherConvId,
      })
    )
    const updated = await conversationUpdatedPayloads()
    expect(updated).toContainEqual(expect.objectContaining({ conversationId: guessedConvId, settlingMessageIds: [] }))
    expect(updated).toContainEqual(
      expect.objectContaining({ conversationId: otherConvId, settlingMessageIds: [sent.message.id] })
    )
  })

  test("an engagement-settled placement is not re-filed by a later pass, an llm-window one still is", async () => {
    const opener = await send("Opener")
    const guessedConvId = await seedConversation({ messageIds: [opener.message.id] })
    const otherConvId = await seedConversation({})

    const engaged = await send("Someone reacted to this where it sits")
    await MessageConversationStateRepository.settle(pool, testWorkspaceId, [engaged.message.id], "engagement")

    extractor.next = { assignments: [{ conversationId: otherConvId, isPrimary: true }], confidence: 0.9 }
    const engagedDecision = await extraction.processMessage(engaged.message.id, testStreamId, testWorkspaceId)

    const machineSettled = await send("Machine-settled placement")
    await MessageConversationStateRepository.settle(pool, testWorkspaceId, [machineSettled.message.id], "llm-window")
    const machineDecision = await extraction.processMessage(machineSettled.message.id, testStreamId, testWorkspaceId)

    const guessed = await ConversationRepository.findById(pool, guessedConvId)
    const other = await ConversationRepository.findById(pool, otherConvId)
    expect({
      engagedDecision: engagedDecision?.id,
      machineDecision: machineDecision?.id,
      guessedMembers: guessed!.messageIds,
      otherMembers: other!.messageIds,
    }).toEqual({
      engagedDecision: guessedConvId,
      machineDecision: otherConvId,
      guessedMembers: [opener.message.id, engaged.message.id],
      otherMembers: [machineSettled.message.id],
    })
  })

  test("the pass still RUNS for an engagement-settled trigger — only that message's placement is frozen", async () => {
    const opener = await send("Opener")
    const guessedConvId = await seedConversation({ messageIds: [opener.message.id] })
    const otherConvId = await seedConversation({})

    const engaged = await send("Engaged where it sits")
    await MessageConversationStateRepository.settle(pool, testWorkspaceId, [engaged.message.id], "engagement")

    extractor.next = {
      assignments: [{ conversationId: otherConvId, isPrimary: true }],
      completenessUpdates: [{ conversationId: guessedConvId, score: 7, status: "active" }],
      confidence: 0.9,
    }
    const decided = await extraction.processMessage(engaged.message.id, testStreamId, testWorkspaceId)

    const guessed = await ConversationRepository.findById(pool, guessedConvId)
    const other = await ConversationRepository.findById(pool, otherConvId)
    expect({
      decided: decided?.id,
      guessedMembers: guessed!.messageIds,
      otherMembers: other!.messageIds,
      // The whole-pass short-circuit would have skipped this write entirely.
      guessedScore: guessed!.completenessScore,
    }).toEqual({
      decided: guessedConvId,
      guessedMembers: [opener.message.id, engaged.message.id],
      otherMembers: [],
      guessedScore: 7,
    })
  })

  test("a declared trigger short-circuits the whole pass — no reassignments, no completeness updates", async () => {
    const opener = await send("Opener")
    const declaredConvId = await seedConversation({ messageIds: [opener.message.id] })
    const otherConvId = await seedConversation({})

    const declared = await send("Declared", {
      conversation: { intent: ConversationIntents.EXISTING, conversationId: declaredConvId },
    })

    extractor.next = {
      assignments: [{ conversationId: otherConvId, isPrimary: true }],
      completenessUpdates: [{ conversationId: declaredConvId, score: 7, status: "active" }],
      confidence: 0.9,
    }
    const decided = await extraction.processMessage(declared.message.id, testStreamId, testWorkspaceId)

    const declaredConv = await ConversationRepository.findById(pool, declaredConvId)
    const other = await ConversationRepository.findById(pool, otherConvId)
    expect({
      decided: decided?.id,
      declaredMembers: declaredConv!.messageIds,
      otherMembers: other!.messageIds,
      // Untouched: the pass never ran.
      declaredScore: declaredConv!.completenessScore,
    }).toEqual({
      decided: declaredConvId,
      declaredMembers: [opener.message.id, declared.message.id],
      otherMembers: [],
      declaredScore: 1,
    })
  })

  test("an overturn recomputes participants from the CURRENT source row, keeping a concurrently-attached author", async () => {
    const opener = await send("Opener")
    const guessedConvId = await seedConversation({ messageIds: [opener.message.id] })
    const otherConvId = await seedConversation({})

    const sent = await send("Provisionally attached")
    // Simulates a concurrent send landing in the source conversation after the
    // pass read its snapshot: a new author joins message_ids/participant_ids.
    const concurrent = await send("Concurrent send", { authorId: otherUserId })
    await withTransaction(pool, async (client) => {
      await ConversationRepository.addPrimaryMessage(
        client,
        testWorkspaceId,
        guessedConvId,
        concurrent.message.id,
        otherUserId
      )
    })

    extractor.next = { assignments: [{ conversationId: otherConvId, isPrimary: true }], confidence: 0.9 }
    await extraction.processMessage(sent.message.id, testStreamId, testWorkspaceId)

    const guessed = await ConversationRepository.findById(pool, guessedConvId)
    expect({ members: guessed!.messageIds, participants: guessed!.participantIds.sort() }).toEqual({
      members: [opener.message.id, concurrent.message.id],
      participants: [testUserId, otherUserId].sort(),
    })
  })

  test("a human re-file of a message with NO state row leaves a durable 'user' row, and a later pass is immune", async () => {
    const opener = await send("Opener")
    const convId = await seedConversation({ messageIds: [opener.message.id] })
    const otherConvId = await seedConversation({})
    // No provisional attach: the stream's only conversation is out of window.
    await pool.query(sql`UPDATE conversations SET last_activity_at = NOW() - INTERVAL '2 hours'`)
    const sent = await send("Never provisional")
    expect(await settlingRow(sent.message.id)).toBeNull()

    await conversationService.reassignMessage({
      workspaceId: testWorkspaceId,
      messageId: sent.message.id,
      conversationId: convId,
      userId: testUserId,
    })

    const row = await settlingRow(sent.message.id)
    expect({ state: row?.state, settledBy: row?.settled_by, conversationId: row?.conversation_id }).toEqual({
      state: "settled",
      settledBy: "user",
      conversationId: convId,
    })

    extractor.next = { assignments: [{ conversationId: otherConvId, isPrimary: true }], confidence: 0.9 }
    const decided = await extraction.processMessage(sent.message.id, testStreamId, testWorkspaceId)
    expect(decided?.id).toBe(convId)
  })

  test("a human re-file flips an llm-window-settled row to 'user' with the new conversation", async () => {
    const opener = await send("Opener")
    const guessedConvId = await seedConversation({ messageIds: [opener.message.id] })
    const userChoiceId = await seedConversation({})

    const sent = await send("Provisional, settled by the window, then moved")
    await MessageConversationStateRepository.settle(pool, testWorkspaceId, [sent.message.id], "llm-window")

    await conversationService.reassignMessage({
      workspaceId: testWorkspaceId,
      messageId: sent.message.id,
      conversationId: userChoiceId,
      userId: testUserId,
    })

    const row = await settlingRow(sent.message.id)
    expect({ state: row?.state, settledBy: row?.settled_by, conversationId: row?.conversation_id }).toEqual({
      state: "settled",
      settledBy: "user",
      conversationId: userChoiceId,
    })
  })

  test("a failing provisional attach does not fail the send and leaves no partial writes", async () => {
    const opener = await send("Opener")
    const convId = await seedConversation({ messageIds: [opener.message.id] })

    const spy = spyOn(MessageConversationStateRepository, "insertSettling").mockImplementation(async () => {
      throw new Error("boom")
    })
    let sent: Awaited<ReturnType<typeof send>>
    try {
      sent = await send("Send must survive")
    } finally {
      spy.mockRestore()
    }

    const conversation = await ConversationRepository.findById(pool, convId)
    const persisted = await pool.query(sql`SELECT id FROM messages WHERE id = ${sent!.message.id}`)
    expect({
      messagePersisted: persisted.rows.length,
      returnedConversationId: sent!.conversationId,
      // The membership write inside the failed block rolled back with it.
      memberIds: conversation!.messageIds,
      settling: await settlingRow(sent!.message.id),
    }).toEqual({
      messagePersisted: 1,
      returnedConversationId: undefined,
      memberIds: [opener.message.id],
      settling: null,
    })
  })

  test("a DECLARED message is not re-filed by the same drive", async () => {
    const opener = await send("Opener")
    const declaredConvId = await seedConversation({ messageIds: [opener.message.id] })
    const otherConvId = await seedConversation({})

    const sent = await send("Declared, and it stays put", {
      conversation: { intent: ConversationIntents.EXISTING, conversationId: declaredConvId },
    })

    extractor.next = {
      assignments: [{ conversationId: otherConvId, isPrimary: true }],
      confidence: 0.9,
    }
    await extraction.processMessage(sent.message.id, testStreamId, testWorkspaceId)

    const declared = await ConversationRepository.findById(pool, declaredConvId)
    const other = await ConversationRepository.findById(pool, otherConvId)
    expect({ declaredMembers: declared!.messageIds, otherMembers: other!.messageIds }).toEqual({
      declaredMembers: [opener.message.id, sent.message.id],
      otherMembers: [],
    })
  })

  test("a message a human re-filed is not re-filed again by a later pass", async () => {
    const opener = await send("Opener")
    const guessedConvId = await seedConversation({ messageIds: [opener.message.id] })
    const userChoiceId = await seedConversation({})
    const otherConvId = await seedConversation({})

    const sent = await send("Provisional, then moved by a human")
    await conversationService.reassignMessage({
      workspaceId: testWorkspaceId,
      messageId: sent.message.id,
      conversationId: userChoiceId,
      userId: testUserId,
    })

    extractor.next = {
      assignments: [{ conversationId: otherConvId, isPrimary: true }],
      confidence: 0.9,
    }
    const decided = await extraction.processMessage(sent.message.id, testStreamId, testWorkspaceId)

    const userChoice = await ConversationRepository.findById(pool, userChoiceId)
    const other = await ConversationRepository.findById(pool, otherConvId)
    expect({
      decidedConversationId: decided?.id,
      userChoiceMembers: userChoice!.messageIds,
      otherMembers: other!.messageIds,
    }).toEqual({
      decidedConversationId: userChoiceId,
      userChoiceMembers: [sent.message.id],
      otherMembers: [],
    })
  })

  test("a provisional member still settles when the extraction window moves past it", async () => {
    const opener = await send("Opener")
    const convId = await seedConversation({ messageIds: [opener.message.id] })
    const provisional = await send("Provisional member")
    expect((await settlingRow(provisional.message.id))?.state).toBe("settling")

    // Push it well out of the surrounding-message window (MESSAGES_BEFORE = 5).
    for (let i = 0; i < 8; i++) await send(`Filler ${i}`)
    const far = await send("Far later message")
    extractor.next = {
      assignments: [{ conversationId: convId, isPrimary: true }],
      confidence: 0.95,
    }
    await extraction.processMessage(far.message.id, testStreamId, testWorkspaceId)

    const row = await settlingRow(provisional.message.id)
    expect({ state: row?.state, settledBy: row?.settled_by }).toEqual({ state: "settled", settledBy: "llm-window" })
  })
})
