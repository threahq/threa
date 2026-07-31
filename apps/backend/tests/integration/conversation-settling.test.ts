/**
 * Settling state: a low-confidence DERIVED conversation assignment is
 * provisional until a human engages with the message or the extraction window
 * moves past it. Runs against the real schema (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { EventService } from "../../src/features/messaging"
import { SavedMessagesService } from "../../src/features/saved-messages"
import {
  ConversationRepository,
  MessageConversationStateRepository,
  ConversationService,
  BoundaryExtractionService,
  createStalenessSweepWorker,
  SETTLING_CONFIDENCE_THRESHOLD,
} from "../../src/features/conversations"
import { sql } from "../../src/db"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"
import type { BoundaryExtractor, ExtractionContext, ExtractionResult } from "../../src/features/conversations"

class StubExtractor implements BoundaryExtractor {
  next: ExtractionResult = {
    assignments: [{ conversationId: null, isPrimary: true }],
    newConversationTopic: "Topic",
    confidence: 0.9,
  }
  lastContext: ExtractionContext | null = null
  /** Runs between Phase 1's snapshot and Phase 3 — the seam a concurrent pass writes through. */
  onExtract: (() => Promise<void>) | null = null
  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    this.lastContext = context
    if (this.onExtract) await this.onExtract()
    return this.next
  }
}

describe("conversation settling", () => {
  let pool: Pool
  let extractor: StubExtractor
  let service: BoundaryExtractionService
  let conversationService: ConversationService
  let eventService: EventService
  let savedMessagesService: SavedMessagesService
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let seq = 1n

  const insertMessage = async (
    text: string,
    overrides: { authorType?: "user" | "persona"; conversationIntent?: string | null } = {}
  ) => {
    const id = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id,
        streamId: testStreamId,
        sequence: seq++,
        authorId: testUserId,
        authorType: overrides.authorType ?? "user",
        conversationIntent: overrides.conversationIntent ?? null,
        ...testMessageContent(text),
      })
    })
    return id
  }

  const settlingRow = async (id: string) => {
    const result = await pool.query(sql`SELECT * FROM message_conversation_state WHERE message_id = ${id}`)
    return result.rows[0] ?? null
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Settling Workspace",
        slug: `settling-ws-${testWorkspaceId}`,
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
      await StreamMemberRepository.insert(client, testStreamId, testUserId)
    })

    extractor = new StubExtractor()
    service = new BoundaryExtractionService(pool, extractor)
    conversationService = new ConversationService(pool)
    eventService = new EventService(pool)
    savedMessagesService = new SavedMessagesService({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(async () => {
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM message_conversation_state")
      await client.query("DELETE FROM outbox")
      await client.query("DELETE FROM saved_messages")
      await client.query("DELETE FROM conversation_feedback")
      await client.query("DELETE FROM conversations")
      await client.query("DELETE FROM stream_events")
      await client.query("DELETE FROM messages")
    })
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Topic",
      confidence: 0.9,
    }
    extractor.onExtract = null
  })

  test("a low-confidence derived assignment is recorded as settling", async () => {
    const msgId = await insertMessage("Low confidence message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Uncertain",
      confidence: SETTLING_CONFIDENCE_THRESHOLD - 0.1,
    }

    const conversation = await service.processMessage(msgId, testStreamId, testWorkspaceId)

    const row = await settlingRow(msgId)
    expect({
      workspaceId: row?.workspace_id,
      streamId: row?.stream_id,
      conversationId: row?.conversation_id,
      state: row?.state,
      settledBy: row?.settled_by,
    }).toEqual({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      conversationId: conversation!.id,
      state: "settling",
      settledBy: null,
    })
  })

  test("a confident derived assignment records nothing", async () => {
    const msgId = await insertMessage("Confident message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Sure",
      confidence: SETTLING_CONFIDENCE_THRESHOLD,
    }

    await service.processMessage(msgId, testStreamId, testWorkspaceId)

    expect(await settlingRow(msgId)).toBeNull()
  })

  test("a declared send is never settling", async () => {
    const declaredConvId = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id: declaredConvId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Declared",
      })
    })
    const msgId = await insertMessage("Declared message", { conversationIntent: declaredConvId })
    await withTransaction(pool, async (client) => {
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, declaredConvId, msgId, testUserId)
    })
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      confidence: 0.1,
    }

    await service.processMessage(msgId, testStreamId, testWorkspaceId)

    expect(await settlingRow(msgId)).toBeNull()
  })

  test("an agent reply is never settling", async () => {
    const msgId = await insertMessage("Agent reply", { authorType: "persona" })
    extractor.next = { assignments: [{ conversationId: null, isPrimary: true }], confidence: 0.1 }

    await service.processMessage(msgId, testStreamId, testWorkspaceId)

    expect(await settlingRow(msgId)).toBeNull()
  })

  test("a later pass settles out-of-window rows and leaves in-window ones settling", async () => {
    const oldMsgId = await insertMessage("Old uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Old",
      confidence: 0.4,
    }
    const oldConversation = await service.processMessage(oldMsgId, testStreamId, testWorkspaceId)

    // A message just after it is still inside the surrounding-message window.
    const nearMsgId = await insertMessage("Near uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Near",
      confidence: 0.4,
    }
    await service.processMessage(nearMsgId, testStreamId, testWorkspaceId)

    expect((await settlingRow(oldMsgId))?.state).toBe("settling")

    // Push the old message far out of the window (MESSAGES_BEFORE = 5).
    for (let i = 0; i < 8; i++) await insertMessage(`Filler ${i}`)
    await pool.query("DELETE FROM outbox")
    const farMsgId = await insertMessage("Far later message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Far",
      confidence: 0.95,
    }
    await service.processMessage(farMsgId, testStreamId, testWorkspaceId)

    const oldRow = await settlingRow(oldMsgId)
    expect({ state: oldRow?.state, settledBy: oldRow?.settled_by }).toEqual({
      state: "settled",
      settledBy: "llm-window",
    })

    // The settled-only conversation is re-broadcast, so the board drops the
    // message from its settling set without an unrelated refetch.
    const events = await pool.query<{ payload: { conversationId: string; settlingMessageIds: string[] } }>(sql`
      SELECT payload FROM outbox WHERE event_type = 'conversation:updated'
    `)
    expect(
      events.rows.map((r) => ({
        conversationId: r.payload.conversationId,
        settlingMessageIds: r.payload.settlingMessageIds,
      }))
    ).toContainEqual({ conversationId: oldConversation!.id, settlingMessageIds: [] })

    // ...without falsely reviving it: a settle is not activity.
    const bumped = await pool.query<{ last_activity_at: Date }>(sql`
      SELECT last_activity_at FROM conversations WHERE id = ${oldConversation!.id}
    `)
    expect(bumped.rows[0]!.last_activity_at).toEqual(oldConversation!.lastActivityAt)
  })

  test("a settling row written after the pass snapshot survives the pass's window settle", async () => {
    const concurrentConvId = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id: concurrentConvId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Concurrent",
      })
    })

    const msgId = await insertMessage("Pass A trigger")
    let concurrentMsgId = ""
    // Pass B lands between pass A's Phase 1 snapshot and its Phase 3 settle.
    extractor.onExtract = async () => {
      concurrentMsgId = await insertMessage("Pass B message")
      await withTransaction(pool, async (client) => {
        await MessageConversationStateRepository.insertSettling(client, {
          messageId: concurrentMsgId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          conversationId: concurrentConvId,
        })
      })
    }
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Pass A",
      confidence: 0.95,
    }

    await service.processMessage(msgId, testStreamId, testWorkspaceId)

    const row = await settlingRow(concurrentMsgId)
    expect({ state: row?.state, settledBy: row?.settled_by }).toEqual({ state: "settling", settledBy: null })
  })

  test("an LLM reassignment moves the settling row without settling it", async () => {
    const msgId = await insertMessage("Uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "First",
      confidence: 0.4,
    }
    const first = await service.processMessage(msgId, testStreamId, testWorkspaceId)

    const nextMsgId = await insertMessage("Follow-up that re-files the previous one")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Second",
      confidence: 0.95,
      reassignments: [{ messageId: msgId, toConversationId: null, reason: "belongs here" }],
    }
    const second = await service.processMessage(nextMsgId, testStreamId, testWorkspaceId)

    expect(second!.id).not.toBe(first!.id)
    const row = await settlingRow(msgId)
    expect({ state: row?.state, conversationId: row?.conversation_id }).toEqual({
      state: "settling",
      conversationId: second!.id,
    })
  })

  test("a reaction settles the message and re-broadcasts the conversation without it", async () => {
    const msgId = await insertMessage("Uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "React",
      confidence: 0.4,
    }
    const conversation = await service.processMessage(msgId, testStreamId, testWorkspaceId)
    await pool.query("DELETE FROM outbox")

    await eventService.addReaction({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      messageId: msgId,
      emoji: "👍",
      userId: testUserId,
    })

    const row = await settlingRow(msgId)
    expect({ state: row?.state, settledBy: row?.settled_by }).toEqual({
      state: "settled",
      settledBy: "engagement",
    })

    const events = await pool.query<{ payload: { conversationId: string; settlingMessageIds: string[] } }>(sql`
      SELECT payload FROM outbox WHERE event_type = 'conversation:updated'
    `)
    expect(
      events.rows.map((r) => ({
        conversationId: r.payload.conversationId,
        settlingMessageIds: r.payload.settlingMessageIds,
      }))
    ).toContainEqual({ conversationId: conversation!.id, settlingMessageIds: [] })
  })

  test("saving a message settles it", async () => {
    const msgId = await insertMessage("Uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Save",
      confidence: 0.4,
    }
    await service.processMessage(msgId, testStreamId, testWorkspaceId)

    await savedMessagesService.save({
      workspaceId: testWorkspaceId,
      userId: testUserId,
      messageId: msgId,
    })

    const row = await settlingRow(msgId)
    expect({ state: row?.state, settledBy: row?.settled_by }).toEqual({
      state: "settled",
      settledBy: "engagement",
    })
  })

  test("a user re-file moves the settling row to the target and settles it", async () => {
    const msgId = await insertMessage("Uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Source",
      confidence: 0.4,
    }
    const source = await service.processMessage(msgId, testStreamId, testWorkspaceId)

    const targetConvId = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id: targetConvId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Target",
      })
    })

    await conversationService.reassignMessage({
      workspaceId: testWorkspaceId,
      conversationId: targetConvId,
      messageId: msgId,
      userId: testUserId,
    })

    const row = await settlingRow(msgId)
    expect({ state: row?.state, settledBy: row?.settled_by, conversationId: row?.conversation_id }).toEqual({
      state: "settled",
      settledBy: "user",
      conversationId: targetConvId,
    })
    // The emptied source is left holding no settling row (it was moved first).
    const stranded = await pool.query(sql`
      SELECT message_id FROM message_conversation_state
      WHERE conversation_id = ${source!.id} AND state = 'settling'
    `)
    expect(stranded.rows).toEqual([])
  })

  test("board feed and single-post read report the settling members", async () => {
    const msgId = await insertMessage("Uncertain message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Board",
      confidence: 0.4,
    }
    const settling = await service.processMessage(msgId, testStreamId, testWorkspaceId)

    const settledMsgId = await insertMessage("Confident message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Board confident",
      confidence: 0.95,
    }
    const settled = await service.processMessage(settledMsgId, testStreamId, testWorkspaceId)

    const single = await conversationService.getBoardPostById(testWorkspaceId, settling!.id, testUserId)
    expect(single?.settlingMessageIds).toEqual([msgId])

    const { posts } = await conversationService.listByWorkspace(testWorkspaceId, testUserId)
    const byId = new Map(posts.map((p) => [p.conversation.id, p.settlingMessageIds]))
    expect(byId.get(settling!.id)).toEqual([msgId])
    expect(byId.get(settled!.id)).toEqual([])
  })

  test("the staleness sweep settles rows older than the max age", async () => {
    const msgId = await insertMessage("Quiet stream message")
    extractor.next = {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Quiet",
      confidence: 0.4,
    }
    const conversation = await service.processMessage(msgId, testStreamId, testWorkspaceId)

    await pool.query(sql`
      UPDATE message_conversation_state
      SET created_at = NOW() - INTERVAL '31 minutes'
      WHERE message_id = ${msgId}
    `)
    await pool.query("DELETE FROM outbox")

    const sweep = createStalenessSweepWorker({ pool })
    await sweep({ id: "sweep-1", data: {} } as never)

    const row = await settlingRow(msgId)
    expect({ state: row?.state, settledBy: row?.settled_by }).toEqual({
      state: "settled",
      settledBy: "llm-window",
    })

    const events = await pool.query<{ payload: { conversationId: string; settlingMessageIds: string[] } }>(sql`
      SELECT payload FROM outbox WHERE event_type = 'conversation:updated'
    `)
    expect(
      events.rows.map((r) => ({
        conversationId: r.payload.conversationId,
        settlingMessageIds: r.payload.settlingMessageIds,
      }))
    ).toContainEqual({ conversationId: conversation!.id, settlingMessageIds: [] })
  })
})
