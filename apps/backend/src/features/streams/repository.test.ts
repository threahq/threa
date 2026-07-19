import { describe, expect, test, mock } from "bun:test"
import { StreamPurposes } from "@threa/types"
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
    parent_message_id: null,
    root_stream_id: null,
    companion_mode: "on",
    companion_persona_id: "persona_system_ariadne",
    memory_mode: "off",
    purpose: null,
    created_by: "usr_1",
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    display_name_generated_at: null,
    ...overrides,
  }
}

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

  test("listByIds hides archived streams AND live threads under an archived root by default", async () => {
    const db = makeDb([])
    await StreamRepository.listByIds(db, "ws_1", ["stream_a"])
    const text = db._query.mock.calls[0]![0] as string
    expect(text).toContain("archived_at IS NULL")
    expect(text).toContain("root.archived_at IS NOT NULL")
  })

  test("listByIds with includeArchived drops both archived filters", async () => {
    const db = makeDb([])
    await StreamRepository.listByIds(db, "ws_1", ["stream_a"], { includeArchived: true })
    const text = db._query.mock.calls[0]![0] as string
    expect(text).not.toContain("archived_at IS NULL")
    expect(text).not.toContain("root.archived_at IS NOT NULL")
  })

  test("listArchivedRoots excludes system-purpose streams", async () => {
    const db = makeDb([])
    await StreamRepository.listArchivedRoots(db, "ws_1", "usr_1")
    expect(queryText(db)).toContain("s.purpose IS NULL")
  })
})

// No DB-backed harness exists in the backend feature tests — every sibling repo
// test (see `listWithPreviews` above) drives a stubbed Querier and asserts the
// SQL text + bound params, so the access-semantics cases from the brief
// (member-included / public-non-member-included / private-non-member-excluded /
// own-archived-scratchpad-included / other-workspace-excluded / threads-never)
// are enforced structurally through the predicates the query emits and the
// params it binds, not by executing rows.
describe("StreamRepository.listArchivedRoots", () => {
  test("filters to archived roots, excludes threads, and workspace/user scopes (INV-8)", async () => {
    const db = makeDb([])
    await StreamRepository.listArchivedRoots(db, "ws_1", "usr_1")

    const { text, values } = db._query.mock.calls[0]![0] as { text: string; values: unknown[] }
    // Only archived rows.
    expect(text).toContain("s.archived_at IS NOT NULL")
    // Threads never returned even if somehow carrying archived_at.
    expect(text).toContain("s.type != ")
    // Workspace scoping (INV-8) and viewer scoping bound as params, not inlined.
    expect(values).toContain("ws_1")
    expect(values).toContain("usr_1")
    expect(text).toContain("s.workspace_id = ")
  })

  test("access predicate: public streams OR streams the viewer is a member of", async () => {
    const db = makeDb([])
    await StreamRepository.listArchivedRoots(db, "ws_1", "usr_1")
    const text = queryText(db)
    // Public non-member channels are included (public grants read); private
    // non-member channels are excluded because they satisfy neither branch.
    expect(text).toContain("s.visibility = 'public'")
    expect(text).toContain("FROM stream_members m")
    expect(text).toContain("m.stream_id = s.id")
    expect(text).toContain("m.member_id = ")
  })

  test("ships E2E fields so a cold-loaded archived E2E scratchpad keeps its sealed name", async () => {
    const db = makeDb([])
    await StreamRepository.listArchivedRoots(db, "ws_1", "usr_1")
    const text = queryText(db)
    expect(text).toContain("LEFT JOIN e2e_streams e")
    expect(text).toContain("e2e_name_ciphertext")
  })

  test("maps archived rows through the shared row mapper", async () => {
    const archivedAt = new Date()
    const db = makeDb([
      streamRow({ id: "stream_arch", type: "channel", visibility: "public", archived_at: archivedAt }),
    ])
    const result = await StreamRepository.listArchivedRoots(db, "ws_1", "usr_1")
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
