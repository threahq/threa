import { describe, expect, test, mock } from "bun:test"
import { StreamPurposes } from "@threahq/types"
import { StreamRepository } from "./repository"
import type { Querier } from "../../db"

function makeDb(rows: Record<string, unknown>[]) {
  const query = mock(() => Promise.resolve({ rows, rowCount: rows.length }))
  return { query, _query: query } as unknown as Querier & { _query: ReturnType<typeof mock> }
}

/** The SQL text passed to the fake querier's Nth call (squid's `.text`). */
function queryText(db: Querier & { _query: ReturnType<typeof mock> }, call = 0): string {
  return (db._query.mock.calls[call]![0] as { text: string }).text
}

function streamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream_x",
    workspace_id: "ws_1",
    type: "scratchpad",
    display_name: "Ariadne draft test",
    slug: null,
    description: null,
    description_json: null,
    visibility: "private",
    parent_stream_id: null,
    parent_anchor_id: null,
    root_stream_id: null,
    companion_mode: "on",
    companion_persona_id: "persona_system_ariadne",
    memory_mode: "off",
    purpose: null,
    created_by: "usr_1",
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    ...overrides,
  }
}

describe("StreamRepository.insertThreadOrFind", () => {
  test("rejects a missing parent stream or anchor before writing", async () => {
    const db = makeDb([])
    const base = {
      id: "stream_thread",
      workspaceId: "ws_1",
      type: "thread" as const,
      createdBy: "usr_1",
    }

    await expect(StreamRepository.insertThreadOrFind(db, { ...base, parentAnchorId: "msg_root" })).rejects.toThrow(
      "parentStreamId and parentAnchorId are required"
    )
    await expect(StreamRepository.insertThreadOrFind(db, { ...base, parentStreamId: "stream_parent" })).rejects.toThrow(
      "parentStreamId and parentAnchorId are required"
    )
    expect(db._query).not.toHaveBeenCalled()
  })
})

describe("StreamRepository.isAncestor", () => {
  test("short-circuits without a query when the IDs are equal", async () => {
    const db = makeDb([])
    expect(await StreamRepository.isAncestor(db, "stream_a", "stream_a")).toBe(true)
    expect(db._query).not.toHaveBeenCalled()
  })

  test("returns true when the recursive CTE finds any matching row", async () => {
    const db = makeDb([{ matched: true }])
    expect(await StreamRepository.isAncestor(db, "stream_parent", "stream_thread")).toBe(true)
    expect(db._query).toHaveBeenCalledTimes(1)
  })

  test("returns false when the CTE returns no rows", async () => {
    const db = makeDb([])
    expect(await StreamRepository.isAncestor(db, "stream_other", "stream_thread")).toBe(false)
    expect(db._query).toHaveBeenCalledTimes(1)
  })
})

describe("purpose marker (sidebar exclusion)", () => {
  test("listWithPreviews excludes system-purpose streams in every branch", async () => {
    // Default (all streams) branch.
    const db1 = makeDb([])
    await StreamRepository.listWithPreviews(db1, "ws_1")
    expect(queryText(db1)).toContain("s.purpose IS NULL")

    // Membership-filtered branch (the workspace bootstrap's real caller shape).
    const db2 = makeDb([])
    await StreamRepository.listWithPreviews(db2, "ws_1", { userMembershipStreamIds: ["stream_a"] })
    expect(queryText(db2)).toContain("s.purpose IS NULL")

    // Type-filtered branch.
    const db3 = makeDb([])
    await StreamRepository.listWithPreviews(db3, "ws_1", { types: ["scratchpad"] })
    expect(queryText(db3)).toContain("s.purpose IS NULL")
  })

  test("list excludes system-purpose streams in every branch", async () => {
    // Default (all streams) branch.
    const db1 = makeDb([])
    await StreamRepository.list(db1, "ws_1")
    expect(queryText(db1)).toContain("purpose IS NULL")

    // Parent-scoped branch.
    const db2 = makeDb([])
    await StreamRepository.list(db2, "ws_1", { parentStreamId: "stream_p" })
    expect(queryText(db2)).toContain("purpose IS NULL")

    // Type-filtered branch.
    const db3 = makeDb([])
    await StreamRepository.list(db3, "ws_1", { types: ["scratchpad"] })
    expect(queryText(db3)).toContain("purpose IS NULL")

    // Membership branch (GET /streams — the Cmd-K archived-search caller).
    const db4 = makeDb([])
    await StreamRepository.list(db4, "ws_1", { userMembershipStreamIds: ["stream_a"] })
    expect(queryText(db4)).toContain("purpose IS NULL")

    // Membership + type branch.
    const db5 = makeDb([])
    await StreamRepository.list(db5, "ws_1", {
      userMembershipStreamIds: ["stream_a"],
      types: ["scratchpad"],
    })
    expect(queryText(db5)).toContain("purpose IS NULL")
  })

  test("listByIds excludes system-purpose streams (public API stream list)", async () => {
    const db = makeDb([])
    await StreamRepository.listByIds(db, "ws_1", ["stream_a"])
    // listByIds passes a plain SQL string (not a `sql` template), so read arg 0 directly.
    expect(db._query.mock.calls[0]![0] as string).toContain("purpose IS NULL")
  })

  test("listArchivedStreams excludes system-purpose streams", async () => {
    const db = makeDb([])
    await StreamRepository.listArchivedStreams(db, "ws_1", "usr_1")
    expect(queryText(db)).toContain("s.purpose IS NULL")
  })
})

// Archive filtering, chain inheritance, and access are executed against a real
// schema in tests/integration/thread-archival-chain.test.ts (INV-68).
describe("StreamRepository.listArchivedStreams", () => {
  test("query shape ships E2E fields so a cold-loaded archived E2E scratchpad keeps its sealed name", async () => {
    const db = makeDb([])
    await StreamRepository.listArchivedStreams(db, "ws_1", "usr_1")
    const text = queryText(db)
    expect(text).toContain("LEFT JOIN e2e_streams e")
    expect(text).toContain("e2e_name_ciphertext")
  })

  test("maps archived rows through the shared row mapper", async () => {
    const archivedAt = new Date()
    const db = makeDb([
      streamRow({ id: "stream_arch", type: "channel", visibility: "public", archived_at: archivedAt }),
    ])
    const result = await StreamRepository.listArchivedStreams(db, "ws_1", "usr_1")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("stream_arch")
    expect(result[0]!.archivedAt).toEqual(archivedAt)
  })
})

describe("StreamRepository purpose exclusion (cont.)", () => {
  test("insert persists the purpose marker and maps it back", async () => {
    const db = makeDb([streamRow({ purpose: StreamPurposes.PERSONA_TEST })])
    const stream = await StreamRepository.insert(db, {
      id: "stream_x",
      workspaceId: "ws_1",
      type: "scratchpad",
      purpose: StreamPurposes.PERSONA_TEST,
      createdBy: "usr_1",
    })
    expect(queryText(db)).toContain("purpose")
    expect(stream.purpose).toBe(StreamPurposes.PERSONA_TEST)
  })

  test("findById surfaces the purpose so a directly-mounted stream stays functional", async () => {
    const db = makeDb([streamRow({ purpose: StreamPurposes.PERSONA_TEST })])
    const stream = await StreamRepository.findById(db, "stream_x")
    // Direct fetch is unfiltered — the exclusion is a list-only concern.
    expect(queryText(db)).not.toContain("s.purpose IS NULL")
    expect(stream?.purpose).toBe(StreamPurposes.PERSONA_TEST)
  })
})
