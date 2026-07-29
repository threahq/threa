/**
 * `memos:captured` placement for an AGENT-authored memo (`save_memo`).
 *
 * The board card and the conversation panel place a capture row by
 * `payload.conversationId` — a payload without it can never be placed, so a memo
 * the agent saves mid-conversation is invisible on both surfaces. Verified
 * against the real schema (INV-68): seed rows, run the real service, assert on
 * the event that comes back out of the table.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, testMessageContent, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoService } from "../../src/features/memos"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"

/** Distinct per call: two identical vectors would trip the near-duplicate gate
 *  and the second save would return the FIRST memo instead of writing its own. */
let embedCalls = 0
function nextEmbedding(): number[] {
  const axis = embedCalls++
  return Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0))
}

describe("save_memo capture event", () => {
  let pool: Pool
  let service: MemoService
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let convId: string
  let sourceMessageId: string
  let orphanMessageId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new MemoService({
      pool,
      classifier: {} as never,
      memorizer: {} as never,
      embeddingService: { embedBatch: async () => [nextEmbedding()] } as never,
      messageFormatter: {} as never,
    })

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()
    convId = conversationId()
    sourceMessageId = messageId()
    orphanMessageId = messageId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Capture WS",
        slug: `memo-capture-${testWorkspaceId}`,
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
      for (const [index, id] of [sourceMessageId, orphanMessageId].entries()) {
        await MessageRepository.insert(client, {
          id,
          streamId: testStreamId,
          sequence: BigInt(index + 1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("we should start with the auth service"),
        })
      }
      await ConversationRepository.insert(client, {
        id: convId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, sourceMessageId, testUserId)
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function captureEventPayload(memoId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM stream_events
       WHERE stream_id = $1 AND event_type = 'memos:captured'
       ORDER BY sequence DESC`,
      [testStreamId]
    )
    return result.rows.find((row) =>
      ((row.payload.memos as { memoId: string }[]) ?? []).some((memo) => memo.memoId === memoId)
    )?.payload
  }

  test("carries the source message's conversation so the row can be placed", async () => {
    const saved = await service.saveMemo({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      sessionId: null,
      sourceStreamIds: [testStreamId],
      title: "Start with auth",
      abstract: "The migration starts with the auth service, then the billing edges.",
      keyPoints: ["auth first"],
      tags: ["migration"],
      knowledgeType: "decision",
      sourceMessageIds: [sourceMessageId],
      invokingUserId: testUserId,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const payload = await captureEventPayload(saved.memoId)
    expect(payload?.conversationId).toBe(convId)
  })

  test("omits conversationId when the source message belongs to no conversation", async () => {
    const saved = await service.saveMemo({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      sessionId: null,
      sourceStreamIds: [testStreamId],
      title: "Rollback plan",
      abstract: "Roll back by replaying the outbox from the last checkpoint marker.",
      keyPoints: ["replay outbox"],
      tags: ["rollback"],
      knowledgeType: "decision",
      sourceMessageIds: [orphanMessageId],
      invokingUserId: testUserId,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const payload = await captureEventPayload(saved.memoId)
    expect(payload && "conversationId" in payload).toBe(false)
  })
})
