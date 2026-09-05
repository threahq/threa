import { describe, expect, mock, test } from "bun:test"
import type { Querier } from "../../db"
import { SearchRepository } from "./repository"

function makeDb() {
  const query = mock(() => Promise.resolve({ rows: [], rowCount: 0 }))
  return { query, _query: query } as unknown as Querier & { _query: ReturnType<typeof mock> }
}

const filters = {}

function queryConfig(db: Querier & { _query: ReturnType<typeof mock> }) {
  return db._query.mock.calls[0]![0] as { text: string; values: unknown[] }
}

describe("SearchRepository phrase predicates", () => {
  test("requires every phrase in full-text results", async () => {
    const db = makeDb()
    await SearchRepository.fullTextSearch(db, {
      ranking: "improved",
      query: "created pr",
      phrases: ["1429", "urgent"],
      streamIds: ["stream_member_channel"],
      filters,
      limit: 20,
    })

    const { text, values } = queryConfig(db)
    expect(text.match(/m\.content_markdown ILIKE/g)).toHaveLength(2)
    expect(values).toEqual(expect.arrayContaining(["1429", "urgent"]))
  })

  test("uses literal case-insensitive phrase matching", async () => {
    const db = makeDb()
    await SearchRepository.fullTextSearch(db, {
      ranking: "improved",
      query: "error",
      phrases: ["A%_\\B"],
      streamIds: ["stream_member_channel"],
      filters,
      limit: 20,
    })

    const { text, values } = queryConfig(db)
    expect(text).toContain("ILIKE")
    expect(values).toContain("A\\%\\_\\\\B")
  })

  test("uses recency search with phrase predicates when semantic text is empty", async () => {
    const db = makeDb()
    await SearchRepository.fullTextSearch(db, {
      ranking: "improved",
      query: "",
      phrases: ["1429"],
      streamIds: ["stream_member_channel"],
      filters,
      limit: 20,
    })

    const { text, values } = queryConfig(db)
    expect(text).toContain("m.content_markdown ILIKE")
    expect(text).toContain("ORDER BY m.created_at DESC")
    expect(values).toContain("1429")
  })

  test("applies every phrase to keyword and semantic hybrid CTEs", async () => {
    const db = makeDb()
    await SearchRepository.hybridSearch(db, {
      ranking: "improved",
      query: "created pr",
      phrases: ["1429"],
      embedding: [0.1, 0.2],
      streamIds: ["stream_member_channel"],
      filters,
      limit: 20,
    })

    const { text, values } = queryConfig(db)
    expect(text.match(/m\.content_markdown ILIKE/g)).toHaveLength(2)
    expect(values.filter((value) => value === "1429")).toHaveLength(2)
    expect(text).toContain("keyword_ranked")
    expect(text).toContain("semantic_ranked")
  })

  test("requires the exact query and every phrase", async () => {
    const db = makeDb()
    await SearchRepository.exactSearch(db, {
      query: "created pr",
      phrases: ["1429", "urgent"],
      streamIds: ["stream_member_channel"],
      filters,
      limit: 20,
    })

    const { text, values } = queryConfig(db)
    expect(text.match(/m\.content_markdown ILIKE/g)).toHaveLength(3)
    expect(values).toEqual(expect.arrayContaining(["created pr", "1429", "urgent"]))
  })

  test("searches phrase-only exact requests", async () => {
    const db = makeDb()
    await SearchRepository.exactSearch(db, {
      query: "",
      phrases: ["A%_\\B"],
      streamIds: ["stream_member_channel"],
      filters,
      limit: 20,
    })

    const { text, values } = queryConfig(db)
    expect(text.match(/m\.content_markdown ILIKE/g)).toHaveLength(1)
    expect(values).toContain("A\\%\\_\\\\B")
  })
})

describe("SearchRepository search access", () => {
  test("uses the canonical root access predicate for non-member threads (INV-62)", async () => {
    const db = makeDb()
    await SearchRepository.getAccessibleStreamsWithMembers(db, {
      workspaceId: "ws_1",
      userId: "usr_member_of_root",
    })

    const { text, values } = queryConfig(db)
    expect(text).toContain("COALESCE(eff_s.root_stream_id, eff_s.id)")
    expect(text).toContain("eff_root.visibility =")
    expect(text).toContain("stream_id = eff_root.id AND member_id =")
    expect(values).toEqual(expect.arrayContaining(["ws_1", "usr_member_of_root", "public"]))
  })
})
