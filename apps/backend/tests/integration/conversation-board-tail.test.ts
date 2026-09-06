/**
 * The board feed's recent-reply window. The card's tail is measured in
 * author-runs, so the projection has to ship enough rows for the client to cut
 * — `BOARD_TAIL_MAX_ROWS`, not three. Verified against the real schema
 * (INV-68): seed rows, run the real projection, assert on what comes back.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { BOARD_TAIL_MAX_ROWS } from "@threahq/types"
import { setupTestDatabase, testMessageContent, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository, ConversationService } from "../../src/features/conversations"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"

describe("board feed recent window", () => {
  let pool: Pool
  let service: ConversationService
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let convId: string
  const orderedIds: string[] = []

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new ConversationService(pool)

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()
    convId = conversationId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Board Tail WS",
        slug: `board-tail-${testWorkspaceId}`,
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
      await ConversationRepository.insert(client, {
        id: convId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
      })
      // One opening message plus eight replies — comfortably past any cap.
      for (let i = 0; i < 9; i++) {
        const id = messageId()
        orderedIds.push(id)
        await MessageRepository.insert(client, {
          id,
          streamId: testStreamId,
          sequence: BigInt(i + 1),
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(`m${i}`),
        })
        await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, id, testUserId)
      }
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("ships the trailing BOARD_TAIL_MAX_ROWS replies, newest last", async () => {
    const { posts } = await service.listByWorkspace(testWorkspaceId, testUserId)
    const post = posts.find((p) => p.conversation.id === convId)!
    const replyIds = orderedIds.slice(1)
    expect({
      opening: post.openingMessage?.id,
      recent: post.recentMessages.map((m) => m.id),
      totalReplies: post.totalReplies,
    }).toEqual({
      opening: orderedIds[0],
      recent: replyIds.slice(-BOARD_TAIL_MAX_ROWS),
      totalReplies: replyIds.length,
    })
  })
})
