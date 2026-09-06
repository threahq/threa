import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { EventService } from "../../src/features/messaging/event-service"
import { SearchService, resolveUserAccessibleStreamIds, type SearchPermissions } from "../../src/features/search"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { userId, workspaceId, streamId } from "../../src/lib/id"
import { Visibilities, StreamTypes } from "@threahq/types"

const EMBEDDING_DIMS = 1536

/** Unit basis vector: 1.0 at index i, 0 elsewhere. */
function unit(i: number): number[] {
  const v = new Array(EMBEDDING_DIMS).fill(0)
  v[i] = 1
  return v
}

/** Normalized blend of two basis vectors: w on i, (1 - w) on j. */
function blend(i: number, j: number, w: number): number[] {
  const a = w
  const b = 1 - w
  const norm = Math.sqrt(a * a + b * b)
  const v = new Array(EMBEDDING_DIMS).fill(0)
  v[i] = a / norm
  v[j] = b / norm
  return v
}

/** Fake embedding service returning a fixed vector for every query. */
function fakeEmbeddingService(vector: number[]): EmbeddingServiceLike {
  return {
    embed: async () => vector,
    embedBatch: async () => [],
  }
}

/** SearchService with inert deep-mode deps: these tests never pass `deep: true`. */
function makeService(pool: Pool, vector: number[] = unit(0)) {
  return new SearchService({
    pool,
    embeddingService: fakeEmbeddingService(vector),
    queryExpander: { expand: async () => [] },
    reranker: { rerank: async (_q, candidates) => candidates.map((_, i) => i) },
    memoSearch: { search: async () => [] },
    refiner: { refine: async () => null },
  })
}

describe("Message hybrid search retrieval", () => {
  let pool: Pool

  function seedEmbedding(messageId: string, embedding: number[]) {
    return MessageRepository.updateEmbeddings(pool, [
      { id: messageId, embedding, sourceHash: "seed", expectedSourceHash: null },
    ])
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  /**
   * Seeds a workspace with one member and one private scratchpad the member
   * belongs to. Returns everything needed to build production-shaped
   * permissions and post messages.
   */
  async function seedWorkspaceWithStream(): Promise<{
    workspaceId: string
    userId: string
    streamId: string
  }> {
    const testWorkspaceId = workspaceId()
    let testUserId = userId()
    const testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Hybrid Search Test Workspace",
        slug: `hybrid-search-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await StreamMemberRepository.insert(client, testStreamId, testUserId)
    })

    return { workspaceId: testWorkspaceId, userId: testUserId, streamId: testStreamId }
  }

  async function postMessage(params: { workspaceId: string; streamId: string; authorId: string; text: string }) {
    const service = new EventService(pool)
    return service.createMessage({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      authorId: params.authorId,
      authorType: "user",
      ...testMessageContent(params.text),
    })
  }

  async function permissionsFor(workspaceId: string, userId: string): Promise<SearchPermissions> {
    const accessibleStreamIds = await resolveUserAccessibleStreamIds(pool, workspaceId, userId, {})
    return { accessibleStreamIds }
  }

  /**
   * Seeds a two-term match, a one-term match, and an unrelated message, all
   * embedding-free, for the query "why did the railway deploy break".
   */
  async function seedRailwayMessages(wsId: string, sid: string, uid: string) {
    const twoTermMatch = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "railway deploy failed with a timeout",
    })
    const oneTermMatch = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "the logs on railway show nothing",
    })
    await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "lunch tomorrow?",
    })
    return { twoTermMatch, oneTermMatch }
  }

  /**
   * Seeds a keyword-only message with the given text and a semantic-only
   * message ("banana weather forecast", embedding unit(0)) sharing no terms.
   */
  async function seedKeywordVsSemanticOnly(wsId: string, sid: string, uid: string, keywordText: string) {
    const keywordOnly = await postMessage({ workspaceId: wsId, streamId: sid, authorId: uid, text: keywordText })
    const semanticOnly = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "banana weather forecast",
    })
    await seedEmbedding(semanticOnly.id, unit(0))
    return { keywordOnly, semanticOnly }
  }

  test("should return keyword hits ranked by term overlap when no message matches every query term", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { twoTermMatch, oneTermMatch } = await seedRailwayMessages(wsId, sid, uid)

    // None of the seeded messages carry an embedding, so the semantic leg
    // contributes nothing here — the ranking below is decided purely by the
    // OR-joined keyword leg's term overlap.
    const service = makeService(pool)
    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "why did the railway deploy break",
    })

    expect(results.map((r) => r.id)).toEqual([twoTermMatch.id, oneTermMatch.id])
  })

  test("should return a semantic-only match beyond the old 0.8 cosine cutoff", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()

    const semanticMatch = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "purple bicycles wander quietly at dusk",
    })
    await seedEmbedding(semanticMatch.id, unit(1))

    const service = makeService(pool)
    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "widget pricing tiers explained thoroughly",
    })

    // Cosine distance between unit(0) and unit(1) is 1.0 — the old
    // SEMANTIC_DISTANCE_THRESHOLD (0.8) would have excluded this result.
    expect(results.map((r) => r.id)).toEqual([semanticMatch.id])
  })

  test("should rank a message present in both legs above messages present in only one leg", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()

    // Present in both legs: matches all query terms, and its embedding sits
    // between the query and an unrelated direction.
    const both = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "acme project rollout status update",
    })
    await seedEmbedding(both.id, blend(0, 1, 0.6))

    // Semantic leg only: perfect embedding match, no shared words.
    const semanticOnly = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "banana weather forecast",
    })
    await seedEmbedding(semanticOnly.id, unit(0))

    // Keyword leg only: partial term match, embedding orthogonal to the query.
    const keywordOnly = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "acme project kickoff",
    })
    await seedEmbedding(keywordOnly.id, unit(5))

    // 4 tokens, no digits -> "general" intent (keywordWeight 0.4, semanticWeight 0.6).
    const service = makeService(pool)
    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "acme project rollout status",
    })

    expect(results.map((r) => r.id)).toEqual([both.id, keywordOnly.id, semanticOnly.id])
  })

  test("should let query-intent weights change which single-leg message wins", async () => {
    // Case 1: a 1-token query classifies as "entity" (keywordWeight 0.6, semanticWeight 0.4)
    // -> the keyword-only message should outrank the semantic-only message.
    {
      const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
      const { keywordOnly, semanticOnly } = await seedKeywordVsSemanticOnly(wsId, sid, uid, "acme quarterly report")

      const service = makeService(pool)
      const { results } = await service.search({
        searchFlag: "on",
        workspaceId: wsId,
        permissions: await permissionsFor(wsId, uid),
        query: "acme",
      })

      expect(results.map((r) => r.id)).toEqual([keywordOnly.id, semanticOnly.id])
    }

    // Case 2: a 3-token query classifies as "general" (keywordWeight 0.4, semanticWeight 0.6)
    // -> the semantic-only message should outrank a keyword-only message that
    // matches only one of the three query terms.
    {
      const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
      const { keywordOnly, semanticOnly } = await seedKeywordVsSemanticOnly(wsId, sid, uid, "acme quarterly report")

      const service = makeService(pool)
      const { results } = await service.search({
        searchFlag: "on",
        workspaceId: wsId,
        permissions: await permissionsFor(wsId, uid),
        query: "acme project launch",
      })

      expect(results.map((r) => r.id)).toEqual([semanticOnly.id, keywordOnly.id])
    }
  })

  test("should find a message in a thread inside a private channel the user belongs to without a thread membership row, and hide the same shape in a channel the user does not belong to", async () => {
    const testWorkspaceId = workspaceId()
    let ownerId = userId()
    let memberId = userId()

    const memberChannelId = streamId()
    const memberThreadId = streamId()
    const outsiderChannelId = streamId()
    const outsiderThreadId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "INV-62 Search Workspace",
        slug: `inv62-search-${testWorkspaceId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(client, testWorkspaceId, ownerId)).id
      memberId = (await addTestMember(client, testWorkspaceId, memberId)).id

      // Private channel the searching user IS a member of.
      await StreamRepository.insert(client, {
        id: memberChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        companionMode: "off",
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, memberChannelId, ownerId)
      await StreamMemberRepository.insert(client, memberChannelId, memberId)

      // Private channel the searching user is NOT a member of.
      await StreamRepository.insert(client, {
        id: outsiderChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        companionMode: "off",
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, outsiderChannelId, ownerId)
    })

    const anchorInMemberChannel = await postMessage({
      workspaceId: testWorkspaceId,
      streamId: memberChannelId,
      authorId: ownerId,
      text: "kicking off the thread",
    })
    const anchorInOutsiderChannel = await postMessage({
      workspaceId: testWorkspaceId,
      streamId: outsiderChannelId,
      authorId: ownerId,
      text: "kicking off another thread",
    })

    await withTransaction(pool, async (client) => {
      // Threads carry no access of their own (INV-62): no stream_members row
      // for `memberId` on either thread.
      await StreamRepository.insert(client, {
        id: memberThreadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: memberChannelId,
        rootStreamId: memberChannelId,
        parentAnchorId: anchorInMemberChannel.id,
        companionMode: "off",
        createdBy: ownerId,
      })
      await StreamRepository.insert(client, {
        id: outsiderThreadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: outsiderChannelId,
        rootStreamId: outsiderChannelId,
        parentAnchorId: anchorInOutsiderChannel.id,
        companionMode: "off",
        createdBy: ownerId,
      })
    })

    const reachableReply = await postMessage({
      workspaceId: testWorkspaceId,
      streamId: memberThreadId,
      authorId: ownerId,
      text: "gizmoflarp reply visible to the member",
    })
    const unreachableReply = await postMessage({
      workspaceId: testWorkspaceId,
      streamId: outsiderThreadId,
      authorId: ownerId,
      text: "gizmoflarp reply hidden from the member",
    })

    const service = makeService(pool)
    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: testWorkspaceId,
      permissions: await permissionsFor(testWorkspaceId, memberId),
      query: "gizmoflarp",
      skipEmbedding: true,
    })

    expect(results.map((r) => r.id)).toEqual([reachableReply.id])
    expect(unreachableReply.streamId).toBe(outsiderThreadId)
  })

  test("should keep AND keyword semantics when the search flag is off", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { twoTermMatch, oneTermMatch } = await seedRailwayMessages(wsId, sid, uid)

    const service = makeService(pool)
    const permissions = await permissionsFor(wsId, uid)

    const legacy = await service.search({
      searchFlag: "off",
      workspaceId: wsId,
      permissions,
      query: "railway deploy",
      skipEmbedding: true,
    })
    expect(legacy.results.map((r) => r.id)).toEqual([twoTermMatch.id])

    const improved = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions,
      query: "railway deploy",
      skipEmbedding: true,
    })
    expect(improved.results.map((r) => r.id)).toEqual([twoTermMatch.id, oneTermMatch.id])
  })

  test("should apply OR keyword semantics and phrase restriction in fullTextSearch", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { twoTermMatch, oneTermMatch } = await seedRailwayMessages(wsId, sid, uid)

    const service = makeService(pool)

    const orResult = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "why did the railway deploy break",
      skipEmbedding: true,
    })
    expect(orResult.results.map((r) => r.id)).toEqual([twoTermMatch.id, oneTermMatch.id])

    const phraseResult = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "why did the railway deploy break",
      phrases: ["deploy failed"],
      skipEmbedding: true,
    })
    expect(phraseResult.results.map((r) => r.id)).toEqual([twoTermMatch.id])
  })

  test("should treat a quoted span inside the query text as an exact phrase, matching the frontend parser", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { twoTermMatch } = await seedRailwayMessages(wsId, sid, uid)

    const service = makeService(pool)
    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: 'railway "deploy failed"',
    })

    expect(results.map((r) => r.id)).toEqual([twoTermMatch.id])
  })
})
