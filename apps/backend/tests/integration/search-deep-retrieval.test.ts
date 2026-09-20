import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging/event-service"
import { SearchService, resolveUserAccessibleStreamIds, type SearchPermissions } from "../../src/features/search"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import type { RerankCandidate, RerankContext } from "../../src/features/memos"
import { userId, workspaceId, streamId } from "../../src/lib/id"
import { StubRelevanceScorer } from "../../src/features/memos"

const EMBEDDING_DIMS = 1536

/** Unit basis vector: 1.0 at index i, 0 elsewhere. */
function unit(index: number): number[] {
  const vector = new Array(EMBEDDING_DIMS).fill(0)
  vector[index] = 1
  return vector
}

/** Fake embedding service returning a fixed vector for every text, batched or single. */
function fakeEmbeddingService(vector: number[]): EmbeddingServiceLike {
  return {
    embed: async () => vector,
    embedBatch: async (texts: string[]) => texts.map(() => vector),
  }
}

/** Fake expander that always proposes one fixed variant, regardless of the query. */
function fakeExpander(variant: string) {
  return { expand: async () => [variant] }
}

/** Recording scorer that ranks the candidates in reverse (proves the scores drive the order). */
function makeReversingScorer() {
  const calls: { query: string; candidates: RerankCandidate[]; context: RerankContext }[] = []
  return {
    calls,
    score: async (query: string, candidates: RerankCandidate[], context: RerankContext) => {
      calls.push({ query, candidates, context })
      return candidates.map((_, i) => 1 - i / candidates.length)
    },
  }
}

describe("Message deep search retrieval", () => {
  let pool: Pool

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
        name: "Deep Search Test Workspace",
        slug: `deep-search-${testWorkspaceId}`,
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

  async function permissionsFor(wsId: string, uid: string): Promise<SearchPermissions> {
    const accessibleStreamIds = await resolveUserAccessibleStreamIds(pool, wsId, uid, {})
    return { accessibleStreamIds, userId: uid }
  }

  /** Seeds A (deploy), B (build pipeline, only reachable via the variant), and C (unrelated). */
  async function seedMessages(wsId: string, sid: string, uid: string) {
    const a = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "railway deploy failed with a timeout",
    })
    const b = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "the build pipeline exploded again this morning",
    })
    const c = await postMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId: uid,
      text: "lunch tomorrow?",
    })
    return { a, b, c }
  }

  test("deep: true fuses the variant's hits in, excludes the unrelated message, and applies the scorer's order", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { a, b, c } = await seedMessages(wsId, sid, uid)

    const scorer = makeReversingScorer()
    const service = new SearchService({
      pool,
      embeddingService: fakeEmbeddingService(unit(0)),
      queryExpander: fakeExpander("build pipeline exploded"),
      memoSearch: { search: async () => [] },
      refiner: { refine: async () => null },
      relevanceScorer: scorer,
    })

    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "deploy failed",
      deep: true,
    })

    expect(results.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(results.map((r) => r.id)).not.toContain(c.id)

    expect(scorer.calls).toHaveLength(1)
    const { query, candidates, context } = scorer.calls[0]!
    expect({ query, context }).toEqual({ query: "deploy failed", context: { workspaceId: wsId, userId: uid } })
    const abstractByMessageId: Record<string, string> = { [a.id]: a.contentMarkdown, [b.id]: b.contentMarkdown }
    expect(candidates.map((cand) => cand.abstract).sort()).toEqual(Object.values(abstractByMessageId).sort())

    // The scores descend with the candidate index, so the final order is the order scored.
    const contentToId = new Map(Object.entries(abstractByMessageId).map(([id, content]) => [content, id]))
    expect(results.map((r) => r.id)).toEqual(candidates.map((cand) => contentToId.get(cand.abstract)))
  })

  test("deep: false only searches the literal query and never calls the expander", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { a, b } = await seedMessages(wsId, sid, uid)

    const expand = async () => {
      throw new Error("expander must not be called when deep is false")
    }
    const service = new SearchService({
      pool,
      embeddingService: fakeEmbeddingService(unit(0)),
      queryExpander: { expand },
      memoSearch: { search: async () => [] },
      refiner: { refine: async () => null },
      relevanceScorer: new StubRelevanceScorer(),
    })

    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "deploy failed",
      deep: false,
    })

    expect(results.map((r) => r.id)).toEqual([a.id])
    expect(results.map((r) => r.id)).not.toContain(b.id)
  })

  test("deep: true with exact: true never calls the expander", async () => {
    const { workspaceId: wsId, userId: uid, streamId: sid } = await seedWorkspaceWithStream()
    const { a } = await seedMessages(wsId, sid, uid)

    const expand = async () => {
      throw new Error("expander must not be called for exact search")
    }
    const service = new SearchService({
      pool,
      embeddingService: fakeEmbeddingService(unit(0)),
      queryExpander: { expand },
      memoSearch: { search: async () => [] },
      refiner: { refine: async () => null },
      relevanceScorer: new StubRelevanceScorer(),
    })

    // "deploy failed" is a literal substring of A's text — exactSearch (ILIKE)
    // finds it directly; deep mode is ignored for exact search, so `expand`
    // (which throws) is never reached.
    const { results } = await service.search({
      searchFlag: "on",
      workspaceId: wsId,
      permissions: await permissionsFor(wsId, uid),
      query: "deploy failed",
      deep: true,
      exact: true,
    })

    expect(results.map((r) => r.id)).toEqual([a.id])
  })
})
