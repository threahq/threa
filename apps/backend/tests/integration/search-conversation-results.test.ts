/**
 * The conversation leg of search against the real schema: the `conversations`
 * HNSW lookup, the lateral opener/closer join over `messages`, the cosine gate,
 * the accessible-stream scope, and the participant filter (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import {
  SearchService,
  resolveUserAccessibleStreamIds,
  serializeConversationSearchResult,
  type SearchPermissions,
} from "../../src/features/search"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { conversationId, streamId, userId, workspaceId } from "../../src/lib/id"
import { TitleSources } from "@threa/types"

const EMBEDDING_DIMS = 1536

function unit(index: number): number[] {
  const vector = new Array(EMBEDDING_DIMS).fill(0)
  vector[index] = 1
  return vector
}

function fakeEmbeddingService(vector: number[]): EmbeddingServiceLike {
  return {
    embed: async () => vector,
    embedBatch: async (texts: string[]) => texts.map(() => vector),
  }
}

function makeService(pool: Pool, vector: number[] = unit(0)) {
  return new SearchService({
    pool,
    embeddingService: fakeEmbeddingService(vector),
    queryExpander: { expand: async () => [] },
    reranker: { rerank: async (_q, candidates) => candidates.map((_, i) => i) },
  })
}

describe("Conversation search results", () => {
  let pool: Pool
  const wsId = workspaceId()
  let memberId: string
  let outsiderId: string
  let padId: string
  let privatePadId: string
  let matchId: string
  let openerId: string
  let secondId: string
  let closerId: string
  let farId: string
  let hiddenId: string
  let noMessagesId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Conversation Search WS",
        slug: `conv-search-${wsId}`,
        createdBy: userId(),
      })
      memberId = (await addTestMember(client, wsId, userId())).id
      outsiderId = (await addTestMember(client, wsId, userId())).id
      padId = streamId()
      privatePadId = streamId()
      await StreamRepository.insert(client, {
        id: padId,
        workspaceId: wsId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: memberId,
      })
      await StreamMemberRepository.insert(client, padId, memberId)
      await StreamRepository.insert(client, {
        id: privatePadId,
        workspaceId: wsId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: outsiderId,
      })
      await StreamMemberRepository.insert(client, privatePadId, outsiderId)
    })

    const events = new EventService(pool)
    const post = async (sid: string, authorId: string, text: string) =>
      events.createMessage({
        workspaceId: wsId,
        streamId: sid,
        authorId,
        authorType: "user",
        ...testMessageContent(text),
      })

    const opener = await post(padId, memberId, "should we launch in May or wait for the mobile build?")
    const second = await post(padId, outsiderId, "May is tight, the mobile build slips a week")
    const deleted = await post(padId, memberId, "scratch that")
    const closer = await post(padId, memberId, "decided: wait for mobile, launch mid June")
    await events.deleteMessageInternal({ workspaceId: wsId, messageId: deleted.id, streamId: padId, actorId: memberId })
    openerId = opener.id
    secondId = second.id
    closerId = closer.id

    const match = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: padId,
      workspaceId: wsId,
      topicSummary: "Choosing the launch date",
      topicSummarySource: TitleSources.GENERATED,
      summary: "Weighed a May launch against waiting for mobile.",
    })
    matchId = match.id
    await ConversationRepository.addPrimaryMessages(
      pool,
      wsId,
      matchId,
      [opener.id, second.id, deleted.id, closer.id],
      [memberId, outsiderId]
    )

    const farMessage = await post(padId, memberId, "lunch tomorrow?")
    const far = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: padId,
      workspaceId: wsId,
      topicSummary: "Lunch plans",
      topicSummarySource: TitleSources.GENERATED,
      summary: null,
    })
    farId = far.id
    await ConversationRepository.addPrimaryMessages(pool, wsId, farId, [farMessage.id], [memberId])

    const hiddenMessage = await post(privatePadId, outsiderId, "launch date thoughts nobody else can read")
    const hidden = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: privatePadId,
      workspaceId: wsId,
      topicSummary: "Choosing the launch date (private)",
      topicSummarySource: TitleSources.GENERATED,
      summary: null,
    })
    hiddenId = hidden.id
    await ConversationRepository.addPrimaryMessages(pool, wsId, hiddenId, [hiddenMessage.id], [outsiderId])

    const noMessages = await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: padId,
      workspaceId: wsId,
      topicSummary: "Emptied conversation",
      topicSummarySource: TitleSources.GENERATED,
      summary: null,
    })
    noMessagesId = noMessages.id

    // Same direction as the query (distance 0) for the match, the hidden one and
    // the emptied one; orthogonal (distance 1) for the lunch conversation.
    await ConversationRepository.updateEmbeddings(pool, wsId, [
      { id: matchId, embedding: unit(0), sourceHash: "h-match" },
      { id: hiddenId, embedding: unit(0), sourceHash: "h-hidden" },
      { id: noMessagesId, embedding: unit(0), sourceHash: "h-empty" },
      { id: farId, embedding: unit(1), sourceHash: "h-far" },
    ])
  })

  afterAll(async () => {
    await pool.end()
  })

  async function permissionsFor(uid: string): Promise<SearchPermissions> {
    return { accessibleStreamIds: await resolveUserAccessibleStreamIds(pool, wsId, uid, {}) }
  }

  test("returns the matching conversation with its non-deleted span, count and first-message deep link", async () => {
    const { conversations } = await makeService(pool).search({
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "when do we launch",
    })

    expect(conversations.map((c) => c.id)).toEqual([matchId])
    const hit = conversations[0]!
    expect(hit).toMatchObject({
      streamId: padId,
      topicSummary: "Choosing the launch date",
      summary: "Weighed a May launch against waiting for mobile.",
      messageCount: 3,
      firstMessageId: openerId,
      distance: 0,
    })
    expect(hit.participantIds.sort()).toEqual([memberId, outsiderId].sort())
    expect(hit.firstMessageAt).toBeInstanceOf(Date)
    expect(hit.lastMessageAt!.getTime()).toBeGreaterThan(hit.firstMessageAt!.getTime())

    const serialized = serializeConversationSearchResult(hit)
    expect(serialized).toMatchObject({
      id: matchId,
      firstMessageId: openerId,
      firstMessageAt: hit.firstMessageAt!.toISOString(),
      lastMessageAt: hit.lastMessageAt!.toISOString(),
    })
  })

  test("points the deep link at the next surviving message when the opener is deleted", async () => {
    const events = new EventService(pool)
    await events.deleteMessageInternal({ workspaceId: wsId, messageId: openerId, streamId: padId, actorId: memberId })
    try {
      const { conversations } = await makeService(pool).search({
        workspaceId: wsId,
        permissions: await permissionsFor(memberId),
        query: "when do we launch",
      })
      expect(conversations[0]).toMatchObject({ id: matchId, firstMessageId: secondId, messageCount: 2 })
      expect(conversations[0]!.lastMessageAt).toEqual(
        (await pool.query<{ created_at: Date }>("SELECT created_at FROM messages WHERE id = $1", [closerId])).rows[0]!
          .created_at
      )
    } finally {
      await pool.query("UPDATE messages SET deleted_at = NULL WHERE id = $1", [openerId])
    }
  })

  test("honours the participant filter", async () => {
    const service = makeService(pool)
    const permissions = await permissionsFor(memberId)

    const byOutsider = await service.search({
      workspaceId: wsId,
      permissions,
      query: "launch",
      filters: { authorId: outsiderId },
    })
    expect(byOutsider.conversations.map((c) => c.id)).toEqual([matchId])

    const byStranger = await service.search({
      workspaceId: wsId,
      permissions,
      query: "launch",
      filters: { authorId: userId() },
    })
    expect(byStranger.conversations).toEqual([])
  })

  test("returns no conversations for exact searches", async () => {
    const { conversations } = await makeService(pool).search({
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "launch",
      exact: true,
    })
    expect(conversations).toEqual([])
  })

  test("excludes conversations beyond the distance gate", async () => {
    // Query vector aligned with the lunch conversation only: the launch
    // conversation is now orthogonal and must not appear.
    const { conversations } = await makeService(pool, unit(1)).search({
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "lunch",
    })
    expect(conversations.map((c) => c.id)).toEqual([farId])
  })

  test("never surfaces a conversation from a stream the caller cannot access", async () => {
    const { conversations } = await makeService(pool).search({
      workspaceId: wsId,
      permissions: await permissionsFor(outsiderId),
      query: "launch",
    })
    expect(conversations.map((c) => c.id)).toEqual([hiddenId])
  })
})
