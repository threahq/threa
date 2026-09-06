import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { EmbeddingServiceLike, RerankerLike } from "../memos"
import { SearchRepository, type SearchResult } from "./repository"
import { SearchService, fuseRankedLists, type MemoSearchLike } from "./service"
import { SEARCH_DEEP_CANDIDATE_POOL, SEARCH_RERANK_CANDIDATE_LIMIT } from "./config"
import type { QueryExpanderLike } from "./query-expansion"
import type { SearchSteererLike, SearchSteerInput } from "./steer"

const pool = {
  query: mock(() => Promise.resolve({ rows: [], rowCount: 0 })),
}

const inertExpander: QueryExpanderLike = { expand: async () => [] }
const identityReranker: RerankerLike = { rerank: async (_q, candidates) => candidates.map((_, i) => i) }

function makeService(
  overrides: {
    embeddingService?: EmbeddingServiceLike
    queryExpander?: QueryExpanderLike
    reranker?: RerankerLike
    memoSearch?: MemoSearchLike
    steerer?: SearchSteererLike
  } = {}
) {
  return new SearchService({
    pool: pool as never,
    embeddingService: overrides.embeddingService ?? { embed: async () => [], embedBatch: async () => [] },
    queryExpander: overrides.queryExpander ?? inertExpander,
    reranker: overrides.reranker ?? identityReranker,
    memoSearch: overrides.memoSearch ?? { search: async () => [] },
    steerer: overrides.steerer ?? { steer: async () => null },
  })
}

function fakeResult(id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    streamId: "stream_1",
    content: `content for ${id}`,
    authorId: "usr_1",
    authorType: "user",
    sequence: 1n,
    replyCount: 0,
    metadata: {},
    editedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    rank: 0,
    ...overrides,
  }
}

describe("SearchService exact phrase search", () => {
  afterEach(() => {
    pool.query.mockClear()
    mock.restore()
  })

  test("passes the query and every phrase to exact search", async () => {
    const exactSearch = spyOn(SearchRepository, "exactSearch").mockResolvedValue([])
    const service = makeService()

    await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "created pr",
      phrases: ["1429", "urgent"],
      exact: true,
    })

    expect(exactSearch).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ query: "created pr", phrases: ["1429", "urgent"] })
    )
  })

  test("passes phrase-only exact searches through", async () => {
    const exactSearch = spyOn(SearchRepository, "exactSearch").mockResolvedValue([])
    const service = makeService()

    await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "",
      phrases: ["1429"],
      exact: true,
    })

    expect(exactSearch).toHaveBeenCalledWith(pool, expect.objectContaining({ query: "", phrases: ["1429"] }))
  })
})

describe("fuseRankedLists", () => {
  test("an id present in two lists outranks one present in a single list at the same position", () => {
    const a = fakeResult("a")
    const b = fakeResult("b")
    const c = fakeResult("c")

    // "a" is rank 1 in both lists; "b" is rank 1 in only the second list.
    const fused = fuseRankedLists(
      [
        [a, c],
        [b, a],
      ],
      60
    )

    expect(fused.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  test("ties break by newer createdAt", () => {
    const older = fakeResult("older", { createdAt: new Date("2026-01-01T00:00:00Z") })
    const newer = fakeResult("newer", { createdAt: new Date("2026-02-01T00:00:00Z") })

    // Same rank position (index 0) in two disjoint lists -> identical fused score.
    const fused = fuseRankedLists([[older], [newer]], 60)

    expect(fused.map((r) => r.id)).toEqual(["newer", "older"])
  })

  test("keeps the first-seen object per id", () => {
    const first = fakeResult("dup", { content: "first" })
    const second = fakeResult("dup", { content: "second" })

    const fused = fuseRankedLists([[first], [second]], 60)

    expect(fused).toHaveLength(1)
    expect(fused[0]).toBe(first)
  })
})

describe("SearchService deep mode", () => {
  afterEach(() => {
    pool.query.mockClear()
    mock.restore()
  })

  test("calls hybridSearch once per query (original + each variant) with the deep candidate pool limit", async () => {
    const hybridSearch = spyOn(SearchRepository, "hybridSearch").mockResolvedValue([])
    const embedBatch = mock(async (texts: string[]) => texts.map(() => [0]))
    const expand = mock(async () => ["variant one", "variant two"])
    const service = makeService({
      embeddingService: { embed: async () => [0], embedBatch },
      queryExpander: { expand },
    })

    await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "original query",
      deep: true,
    })

    expect(expand).toHaveBeenCalledWith("original query", { workspaceId: "ws_1" })
    expect(embedBatch).toHaveBeenCalledWith(
      ["variant one", "variant two"],
      expect.objectContaining({ workspaceId: "ws_1", functionId: "search-query" })
    )
    expect(hybridSearch).toHaveBeenCalledTimes(3)
    for (const [, params] of hybridSearch.mock.calls) {
      expect((params as { limit: number }).limit).toBe(SEARCH_DEEP_CANDIDATE_POOL)
    }
    expect(hybridSearch.mock.calls.map(([, params]) => (params as { query: string }).query)).toEqual([
      "original query",
      "variant one",
      "variant two",
    ])
  })

  test("hands the reranker at most SEARCH_RERANK_CANDIDATE_LIMIT candidates whose abstract is the message content", async () => {
    const results = Array.from({ length: 40 }, (_, i) => fakeResult(`msg_${i}`, { content: `content ${i}` }))
    spyOn(SearchRepository, "hybridSearch").mockResolvedValue(results)
    const rerank = mock(async (_q: string, candidates: { abstract: string }[]) => candidates.map((_, i) => i))
    const service = makeService({
      embeddingService: { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) },
      reranker: { rerank },
    })

    await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "q",
      deep: true,
    })

    expect(rerank).toHaveBeenCalledTimes(1)
    const [, candidates] = rerank.mock.calls[0]!
    expect(candidates).toHaveLength(SEARCH_RERANK_CANDIDATE_LIMIT)
    expect((candidates as { abstract: string }[]).map((c) => c.abstract)).toEqual(
      results.slice(0, SEARCH_RERANK_CANDIDATE_LIMIT).map((r) => r.content)
    )
  })

  test("applies the reranker's returned order and keeps the un-reranked tail in fused order", async () => {
    const total = SEARCH_RERANK_CANDIDATE_LIMIT + 5
    const results = Array.from({ length: total }, (_, i) => fakeResult(`msg_${i}`))
    spyOn(SearchRepository, "hybridSearch").mockResolvedValue(results)
    // Reverse the head.
    const rerank = mock(async (_q: string, candidates: unknown[]) =>
      Array.from({ length: candidates.length }, (_, i) => candidates.length - 1 - i)
    )
    const service = makeService({
      embeddingService: { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) },
      reranker: { rerank },
    })

    const { results: searchResults } = await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "q",
      deep: true,
      limit: total,
    })

    const reversedHead = results
      .slice(0, SEARCH_RERANK_CANDIDATE_LIMIT)
      .reverse()
      .map((r) => r.id)
    const tail = results.slice(SEARCH_RERANK_CANDIDATE_LIMIT).map((r) => r.id)
    expect(searchResults.map((r) => r.id)).toEqual([...reversedHead, ...tail])
  })

  test("deep: true with exact: true goes straight to exactSearch and never calls the expander", async () => {
    const exactSearch = spyOn(SearchRepository, "exactSearch").mockResolvedValue([])
    const expand = mock(async () => [])
    const service = makeService({ queryExpander: { expand } })

    await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "q",
      deep: true,
      exact: true,
    })

    expect(exactSearch).toHaveBeenCalled()
    expect(expand).not.toHaveBeenCalled()
  })

  test("expander returning [] still runs a single hybrid search and rerank", async () => {
    const results = [fakeResult("a"), fakeResult("b")]
    const hybridSearch = spyOn(SearchRepository, "hybridSearch").mockResolvedValue(results)
    const expand = mock(async () => [])
    const rerank = mock(async (_q: string, candidates: unknown[]) => candidates.map((_, i) => i))
    const service = makeService({
      embeddingService: { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) },
      queryExpander: { expand },
      reranker: { rerank },
    })

    const { results: searchResults } = await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "q",
      deep: true,
    })

    expect(hybridSearch).toHaveBeenCalledTimes(1)
    expect(rerank).toHaveBeenCalledTimes(1)
    expect(searchResults.map((r) => r.id)).toEqual(["a", "b"])
  })
})

describe("SearchService with the search flag off", () => {
  afterEach(() => {
    pool.query.mockClear()
    mock.restore()
  })

  test("runs the legacy ranking, ignores deep and skips the conversation leg", async () => {
    const hybridSearch = spyOn(SearchRepository, "hybridSearch").mockResolvedValue([])
    const conversationSearch = spyOn(SearchRepository, "conversationSearch").mockResolvedValue([])
    const expand = mock(async () => ["variant"])
    const rerank = mock(async (_q: string, candidates: unknown[]) => candidates.map((_, i) => i))
    const service = makeService({
      embeddingService: { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) },
      queryExpander: { expand },
      reranker: { rerank },
    })

    const { conversations } = await service.search({
      searchFlag: "off",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "original query",
      deep: true,
    })

    expect(hybridSearch).toHaveBeenCalledTimes(1)
    expect(hybridSearch).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ query: "original query", ranking: "legacy", limit: 20 })
    )
    expect(expand).not.toHaveBeenCalled()
    expect(rerank).not.toHaveBeenCalled()
    expect(conversationSearch).not.toHaveBeenCalled()
    expect(conversations).toEqual([])
  })

  test("passes the legacy ranking to full-text search", async () => {
    const fullTextSearch = spyOn(SearchRepository, "fullTextSearch").mockResolvedValue([])
    const service = makeService()

    await service.search({
      searchFlag: "off",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "railway deploy",
      skipEmbedding: true,
    })

    expect(fullTextSearch).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ query: "railway deploy", ranking: "legacy" })
    )
  })

  test("the flag on runs the conversation leg with the improved ranking", async () => {
    const hybridSearch = spyOn(SearchRepository, "hybridSearch").mockResolvedValue([])
    const conversationSearch = spyOn(SearchRepository, "conversationSearch").mockResolvedValue([])
    const service = makeService({
      embeddingService: { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) },
    })

    await service.search({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "original query",
    })

    expect(hybridSearch).toHaveBeenCalledWith(pool, expect.objectContaining({ ranking: "improved" }))
    expect(conversationSearch).toHaveBeenCalledTimes(1)
  })
})

describe("SearchService memo leg", () => {
  afterEach(() => {
    pool.query.mockClear()
    mock.restore()
  })

  const embedding = { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) }

  test("should search memos with the query, phrases, stream scope and date filters, and fold the hit into a row", async () => {
    spyOn(SearchRepository, "hybridSearch").mockResolvedValue([fakeResult("msg_1")])
    spyOn(SearchRepository, "conversationSearch").mockResolvedValue([])
    spyOn(SearchRepository, "conversationsForMessages").mockResolvedValue(new Map())
    const messagesByIds = spyOn(SearchRepository, "messagesByIds").mockResolvedValue([fakeResult("msg_2")])
    const memo = {
      memo: { id: "memo_1", sourceMessageIds: ["msg_1", "msg_2"] },
      distance: 0.1,
      sourceStream: null,
      rootStream: null,
    } as never
    const search = mock(async () => [memo])
    const before = new Date("2026-02-01T00:00:00Z")
    const service = makeService({ embeddingService: embedding, memoSearch: { search } })

    const { memos, clusters } = await service.searchClusters({
      searchFlag: "on",
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"], userId: "usr_1" },
      query: "launch date",
      phrases: ["mid June"],
      filters: { before },
    })

    expect(search).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"], userId: "usr_1" },
      query: "launch date mid June",
      filters: { before, after: undefined },
      limit: 3,
    })
    expect(messagesByIds).toHaveBeenCalledWith(pool, { ids: ["msg_2"], streamIds: ["stream_1"] })
    expect(memos).toEqual([memo])
    expect(clusters).toEqual([
      expect.objectContaining({ hits: [fakeResult("msg_1")], memoIds: ["memo_1"], matchedVia: ["message", "memory"] }),
    ])
  })

  test("should skip the memo leg for a from: filter, for the legacy ranking, and for plain search", async () => {
    spyOn(SearchRepository, "hybridSearch").mockResolvedValue([])
    spyOn(SearchRepository, "conversationSearch").mockResolvedValue([])
    const search = mock(async () => [])
    const service = makeService({ embeddingService: embedding, memoSearch: { search } })
    const base = { workspaceId: "ws_1", permissions: { accessibleStreamIds: ["stream_1"] }, query: "launch date" }

    await service.searchClusters({ ...base, searchFlag: "on", filters: { authorId: "usr_2" } })
    await service.searchClusters({ ...base, searchFlag: "off" })
    await service.search({ ...base, searchFlag: "on" })

    expect(search).not.toHaveBeenCalled()
  })
})

describe("SearchService steer", () => {
  afterEach(() => {
    pool.query.mockClear()
    mock.restore()
  })

  const embedding = { embed: async () => [0], embedBatch: async (texts: string[]) => texts.map(() => [0]) }
  const base = {
    searchFlag: "on" as const,
    workspaceId: "ws_1",
    permissions: { accessibleStreamIds: ["stream_1"], userId: "usr_1" },
    query: "launch date",
  }

  function stubLegs() {
    spyOn(SearchRepository, "hybridSearch").mockResolvedValue([
      fakeResult("msg_1", { streamId: "stream_1" }),
      fakeResult("msg_2", { streamId: "stream_2" }),
      fakeResult("msg_3", { streamId: "stream_3" }),
    ])
    spyOn(SearchRepository, "conversationSearch").mockResolvedValue([])
    spyOn(SearchRepository, "conversationsForMessages").mockResolvedValue(new Map())
    spyOn(SearchRepository, "messagesByIds").mockResolvedValue([])
  }

  test("should keep only the rows the steerer returns, in its order, and narrow results and memos to them", async () => {
    stubLegs()
    const memo = {
      memo: { id: "memo_1", sourceMessageIds: ["msg_2"] },
      distance: 0.1,
      sourceStream: null,
      rootStream: null,
    } as never
    const steer = mock(async (_input: SearchSteerInput) => ({ keep: [2, 0], note: "Dropped the billing thread" }))
    const service = makeService({
      embeddingService: embedding,
      memoSearch: { search: async () => [memo] },
      steerer: { steer },
    })

    const response = await service.searchClusters({ ...base, steer: ["not billing", " "] })

    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "launch date",
        steers: ["not billing"],
        context: { workspaceId: "ws_1", userId: "usr_1" },
      })
    )
    // The memo lifts stream_2's row to the top; the steerer sees rows in that order.
    expect(steer.mock.calls[0]![0].clusters.map((cluster) => cluster.streamId)).toEqual([
      "stream_2",
      "stream_1",
      "stream_3",
    ])
    expect(response).toEqual({
      ...response,
      results: [fakeResult("msg_2", { streamId: "stream_2" }), fakeResult("msg_3", { streamId: "stream_3" })],
      memos: [memo],
      clusters: [
        expect.objectContaining({ streamId: "stream_3" }),
        expect.objectContaining({ streamId: "stream_2", memoIds: ["memo_1"] }),
      ],
      steer: { applied: true, note: "Dropped the billing thread" },
    })
  })

  test("should keep the full list and report the steer as not applied when the steerer fails open", async () => {
    stubLegs()
    const service = makeService({ embeddingService: embedding, steerer: { steer: async () => null } })

    const response = await service.searchClusters({ ...base, steer: ["only decisions"] })

    expect(response.clusters.map((cluster) => cluster.streamId)).toEqual(["stream_1", "stream_2", "stream_3"])
    expect(response.steer).toEqual({ applied: false, note: null })
  })

  test("should not call the steerer without a steer, and report null", async () => {
    stubLegs()
    const steer = mock(async () => ({ keep: [], note: "" }))
    const service = makeService({ embeddingService: embedding, steerer: { steer } })

    const response = await service.searchClusters(base)

    expect(steer).not.toHaveBeenCalled()
    expect(response.steer).toBeNull()
  })
})
