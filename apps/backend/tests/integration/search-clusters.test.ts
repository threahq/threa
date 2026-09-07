/**
 * Search result clusters against the real schema (INV-68): the join from
 * message hits to their conversation through `conversations.message_ids`,
 * the access-scoped fetch of memo source messages, and the rows the service
 * folds them into.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupIsolatedTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import {
  SearchRepository,
  SearchService,
  SEARCH_RRF_K,
  resolveUserAccessibleStreamIds,
  type SearchPermissions,
} from "../../src/features/search"
import type { Memo, MemoExplorerResult } from "../../src/features/memos"
import { conversationId, memoId, streamId, userId, workspaceId } from "../../src/lib/id"
import { TitleSources } from "@threahq/types"

const rrf = (...positions: number[]) => positions.reduce((sum, p) => sum + 1 / (SEARCH_RRF_K + p), 0)

function memoHit(wsId: string, sourceMessageIds: string[], sourceStreamId: string): MemoExplorerResult {
  const memo: Memo = {
    id: memoId(),
    workspaceId: wsId,
    memoType: "message",
    sourceMessageId: sourceMessageIds[0] ?? null,
    sourceConversationId: null,
    title: "Friday deploy rollback",
    abstract: "",
    keyPoints: [],
    sourceMessageIds,
    participantIds: [],
    knowledgeType: "learning",
    tags: [],
    parentMemoId: null,
    status: "active",
    version: 1,
    revisionReason: null,
    authoredByKind: "pipeline",
    sourceSessionId: null,
    scope: "workspace",
    scopeUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  }
  return { memo, distance: 0.1, sourceStream: { id: sourceStreamId, type: "scratchpad", name: null }, rootStream: null }
}

describe("Search result clusters", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  const wsId = workspaceId()
  let memberId: string
  let outsiderId: string
  let padId: string
  let privatePadId: string
  let convId: string
  let failedId: string
  let rollbackId: string
  let deletedId: string
  let postmortemId: string
  let strayId: string
  let hiddenId: string
  let threadId: string
  let threadConvId: string
  let threadNoteId: string

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("search_clusters"))

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Search Clusters WS",
        slug: `search-clusters-${wsId}`,
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
    const post = (sid: string, authorId: string, text: string) =>
      events.createMessage({
        workspaceId: wsId,
        streamId: sid,
        authorId,
        authorType: "user",
        ...testMessageContent(text),
      })

    failedId = (await post(padId, memberId, "the deploy failed on friday evening")).id
    rollbackId = (await post(padId, memberId, "rollback took an hour")).id
    deletedId = (await post(padId, memberId, "never mind")).id
    postmortemId = (await post(padId, memberId, "postmortem next week")).id
    await events.deleteMessageInternal({ workspaceId: wsId, messageId: deletedId, streamId: padId, actorId: memberId })
    strayId = (await post(padId, memberId, "deploy the new logo whenever")).id
    hiddenId = (await post(privatePadId, outsiderId, "deploy failed here too, privately")).id

    convId = (
      await ConversationRepository.insert(pool, {
        id: conversationId(),
        streamId: padId,
        workspaceId: wsId,
        topicSummary: "Friday deploy failure",
        topicSummarySource: TitleSources.GENERATED,
        summary: null,
      })
    ).id
    await ConversationRepository.addPrimaryMessages(
      pool,
      wsId,
      convId,
      [failedId, rollbackId, deletedId, postmortemId],
      [memberId]
    )

    // A thread under the pad with no stream_members row of its own: access is
    // inherited from the pad (INV-62), so its content must still cluster.
    threadId = streamId()
    await StreamRepository.insert(pool, {
      id: threadId,
      workspaceId: wsId,
      type: "thread",
      visibility: "private",
      companionMode: "off",
      createdBy: memberId,
      parentStreamId: padId,
      parentAnchorId: failedId,
      rootStreamId: padId,
    })
    threadNoteId = (await post(threadId, memberId, "the rollback notes live in this thread")).id
    threadConvId = (
      await ConversationRepository.insert(pool, {
        id: conversationId(),
        streamId: threadId,
        workspaceId: wsId,
        topicSummary: "Rollback notes",
        topicSummarySource: TitleSources.GENERATED,
        summary: null,
      })
    ).id
    await ConversationRepository.addPrimaryMessages(pool, wsId, threadConvId, [threadNoteId], [memberId])
  }, 30_000)

  afterAll(async () => {
    await cleanup()
  }, 30_000)

  function makeService(memos: MemoExplorerResult[]) {
    return new SearchService({
      pool,
      embeddingService: { embed: async () => [], embedBatch: async (texts: string[]) => texts.map(() => []) },
      queryExpander: { expand: async () => [] },
      reranker: { rerank: async (_q, candidates) => candidates.map((_, i) => i) },
      memoSearch: { search: async () => memos },
      refiner: { refine: async () => null },
    })
  }

  async function permissionsFor(uid: string): Promise<SearchPermissions> {
    return { accessibleStreamIds: await resolveUserAccessibleStreamIds(pool, wsId, uid, {}), userId: uid }
  }

  test("conversationsForMessages should map each hit to its conversation with the non-deleted span, and skip unmatched ids", async () => {
    const byMessage = await SearchRepository.conversationsForMessages(pool, {
      workspaceId: wsId,
      messageIds: [failedId, postmortemId, strayId, hiddenId],
      streamIds: [padId, privatePadId],
    })

    const expected = {
      id: convId,
      streamId: padId,
      topicSummary: "Friday deploy failure",
      summary: null,
      status: "active",
      messageCount: 3,
      participantIds: [memberId],
      firstMessageId: failedId,
      firstMessageAt: expect.any(Date),
      lastMessageAt: expect.any(Date),
    }
    expect(Object.fromEntries(byMessage)).toEqual({ [failedId]: expected, [postmortemId]: expected })
  })

  test("conversationsForMessages should return nothing for another workspace or outside the given streams", async () => {
    const otherWorkspace = await SearchRepository.conversationsForMessages(pool, {
      workspaceId: workspaceId(),
      messageIds: [failedId],
      streamIds: [padId],
    })
    const otherStreams = await SearchRepository.conversationsForMessages(pool, {
      workspaceId: wsId,
      messageIds: [failedId],
      streamIds: [privatePadId],
    })

    expect([otherWorkspace.size, otherStreams.size]).toEqual([0, 0])
  })

  test("messagesByIds should return only readable, non-deleted messages in posting order with rank 0", async () => {
    const messages = await SearchRepository.messagesByIds(pool, {
      ids: [hiddenId, postmortemId, deletedId, rollbackId],
      streamIds: [padId],
    })

    expect(messages.map((m) => ({ id: m.id, streamId: m.streamId, rank: m.rank }))).toEqual([
      { id: rollbackId, streamId: padId, rank: 0 },
      { id: postmortemId, streamId: padId, rank: 0 },
    ])
  })

  test("should fold message hits and a memo into the conversation row, and keep the stray hit as its own row", async () => {
    const memo = memoHit(wsId, [rollbackId, hiddenId], padId)
    const { clusters, memos } = await makeService([memo]).searchClusters({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "deploy",
      skipEmbedding: true,
    })

    expect(memos).toEqual([memo])
    const [conversationRow, strayRow] = clusters
    expect(clusters).toEqual([
      {
        conversation: expect.objectContaining({ id: convId, messageCount: 3, firstMessageId: failedId }),
        streamId: padId,
        matchedVia: ["message", "memory"],
        hits: [expect.objectContaining({ id: failedId })],
        memoIds: [memo.memo.id],
        score: expect.any(Number),
      },
      {
        conversation: null,
        streamId: padId,
        matchedVia: ["message"],
        hits: [expect.objectContaining({ id: strayId })],
        memoIds: [],
        score: expect.any(Number),
      },
    ])
    // Keyword rank between the two hits is not asserted; the memo's reciprocal rank is what lifts the conversation row.
    const [lower, higher] = [conversationRow!.score - rrf(1), strayRow!.score].sort((a, b) => a - b)
    expect(lower).toBeCloseTo(rrf(2), 12)
    expect(higher).toBeCloseTo(rrf(1), 12)
  })

  test("should carry a memo's readable source messages when nothing else matched its conversation", async () => {
    const memo = memoHit(wsId, [postmortemId, rollbackId, hiddenId], padId)
    const { clusters } = await makeService([memo]).searchClusters({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "hexagonal",
      skipEmbedding: true,
    })

    expect(clusters).toEqual([
      {
        conversation: expect.objectContaining({ id: convId }),
        streamId: padId,
        matchedVia: ["memory"],
        hits: [expect.objectContaining({ id: rollbackId }), expect.objectContaining({ id: postmortemId })],
        memoIds: [memo.memo.id],
        score: rrf(1),
      },
    ])
  })

  test("should run the memo leg with the frontend's default status filter", async () => {
    const memo = memoHit(wsId, [rollbackId], padId)
    const { clusters, memos } = await makeService([memo]).searchClusters({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "deploy",
      filters: { archiveStatus: ["active", "archived"] },
      skipEmbedding: true,
    })

    expect(memos).toEqual([memo])
    expect(clusters[0]).toEqual(
      expect.objectContaining({ streamId: padId, matchedVia: ["message", "memory"], memoIds: [memo.memo.id] })
    )
  })

  test("should cluster a memo's sources inside a thread the requester reads through the parent pad (INV-62)", async () => {
    const memo = memoHit(wsId, [threadNoteId], threadId)
    const { clusters } = await makeService([memo]).searchClusters({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "hexagonal",
      skipEmbedding: true,
    })

    expect(clusters).toEqual([
      {
        conversation: expect.objectContaining({ id: threadConvId, streamId: threadId }),
        streamId: threadId,
        matchedVia: ["memory"],
        hits: [expect.objectContaining({ id: threadNoteId, streamId: threadId })],
        memoIds: [memo.memo.id],
        score: rrf(1),
      },
    ])
  })

  test("should not fetch source messages outside the requester's streams", async () => {
    const memo = memoHit(wsId, [hiddenId], privatePadId)
    const { clusters } = await makeService([memo]).searchClusters({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(memberId),
      query: "hexagonal",
      skipEmbedding: true,
    })

    expect(clusters).toEqual([
      {
        conversation: null,
        streamId: privatePadId,
        matchedVia: ["memory"],
        hits: [],
        memoIds: [memo.memo.id],
        score: rrf(1),
      },
    ])
  })
})
