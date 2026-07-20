import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { SearchRepository } from "./repository"
import { SearchService } from "./service"

const pool = {
  query: mock(() => Promise.resolve({ rows: [], rowCount: 0 })),
}

describe("SearchService exact phrase search", () => {
  afterEach(() => {
    pool.query.mockClear()
    mock.restore()
  })

  test("passes the query and every phrase to exact search", async () => {
    const exactSearch = spyOn(SearchRepository, "exactSearch").mockResolvedValue([])
    const service = new SearchService({
      pool: pool as never,
      embeddingService: { embed: async () => [], embedBatch: async () => [] },
    })

    await service.search({
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
    const service = new SearchService({
      pool: pool as never,
      embeddingService: { embed: async () => [], embedBatch: async () => [] },
    })

    await service.search({
      workspaceId: "ws_1",
      permissions: { accessibleStreamIds: ["stream_1"] },
      query: "",
      phrases: ["1429"],
      exact: true,
    })

    expect(exactSearch).toHaveBeenCalledWith(pool, expect.objectContaining({ query: "", phrases: ["1429"] }))
  })
})
