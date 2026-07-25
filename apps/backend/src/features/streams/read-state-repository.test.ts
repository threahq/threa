import { describe, expect, test, mock } from "bun:test"
import { ReadStateRepository } from "./read-state-repository"
import { StreamMemberRepository } from "./member-repository"
import type { Querier } from "../../db"

function makeDb(rows: Record<string, unknown>[] = []) {
  const query = mock(() => Promise.resolve({ rows, rowCount: rows.length }))
  return { db: { query } as unknown as Querier, query }
}

/** Collapse whitespace so multi-line SQL can be matched with plain substrings. */
function flat(text: unknown): string {
  return String(text).replace(/\s+/g, " ").trim()
}

/** First query's SQL text, whether called as (string, values) or (QueryConfig). */
function sqlText(call: unknown[]): string {
  const arg = call[0]
  return typeof arg === "string" ? arg : (arg as { text: string }).text
}

function sqlValues(call: unknown[]): unknown[] {
  const arg = call[0]
  return typeof arg === "string" ? ((call[1] as unknown[]) ?? []) : (arg as { values: unknown[] }).values
}

describe("ReadStateRepository.advance", () => {
  test("is a single monotonic upsert keyed on (stream_id, user_id) returning the post-write row", async () => {
    // A returned row means the monotonic guard accepted (or inserted), so the
    // advance is one statement — no read-back.
    const { db, query } = makeDb([
      {
        workspace_id: "ws_1",
        stream_id: "stream_1",
        user_id: "usr_1",
        last_read_event_id: "evt_9",
        last_read_at: null,
        updated_at: new Date(),
      },
    ])
    await ReadStateRepository.advance(db, "stream_1", "usr_1", "evt_9")

    expect(query).toHaveBeenCalledTimes(1)
    const text = flat(sqlText(query.mock.calls[0]))
    expect(text).toContain("INSERT INTO stream_read_state")
    expect(text).toContain("ON CONFLICT (stream_id, user_id) DO UPDATE")
    // Monotonic rule: new event sequence strictly greater than current watermark
    // sequence, both resolved via stream_events, NULL watermark counting as 0.
    expect(text).toContain("> COALESCE")
    expect(text).toMatch(/new_ev\.id = EXCLUDED\.last_read_event_id/)
    expect(text).toMatch(/cur_ev\.id = stream_read_state\.last_read_event_id/)
    expect(text).toContain("FROM stream_events new_ev")
    expect(text).toContain("FROM stream_events cur_ev")
    // workspace_id derived from streams on insert (INV-8).
    expect(text).toContain("SELECT s.workspace_id")
    expect(text).toContain("FROM streams s")
    // Post-write row returned so same-tx callers can source stream:read
    // payloads from the standalone frontier.
    expect(text).toContain("RETURNING")
  })

  test("binds streamId, userId, eventId in order", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.advance(db, "stream_1", "usr_1", "evt_9")
    expect(sqlValues(query.mock.calls[0])).toEqual(["stream_1", "usr_1", "evt_9"])
  })

  test("returns the post-write row when the advance lands", async () => {
    const row = {
      workspace_id: "ws_1",
      stream_id: "stream_1",
      user_id: "usr_1",
      last_read_event_id: "evt_9",
      last_read_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    }
    const { db, query } = makeDb([row])
    const result = await ReadStateRepository.advance(db, "stream_1", "usr_1", "evt_9")
    expect(query).toHaveBeenCalledTimes(1)
    expect(result?.lastReadEventId).toBe("evt_9")
  })

  test("reads back the standing row when the monotonic guard rejects a stale advance", async () => {
    // RETURNING is empty when the DO UPDATE WHERE clause rejects (stale event);
    // the row as it stands — above the attempted advance — must come back so
    // the caller's payload sources from the true post-write frontier.
    const standing = {
      workspace_id: "ws_1",
      stream_id: "stream_1",
      user_id: "usr_1",
      last_read_event_id: "evt_higher",
      last_read_at: new Date("2026-01-02T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    }
    const query = mock()
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    query.mockResolvedValueOnce({ rows: [standing], rowCount: 1 })
    const db = { query } as unknown as Querier

    const result = await ReadStateRepository.advance(db, "stream_1", "usr_1", "evt_stale")

    expect(query).toHaveBeenCalledTimes(2)
    expect(result?.lastReadEventId).toBe("evt_higher")
  })
})

describe("ReadStateRepository.set", () => {
  test("is an unconditional upsert with no sequence comparison", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.set(db, "stream_1", "usr_1", "evt_3")

    const text = flat(sqlText(query.mock.calls[0]))
    expect(text).toContain("ON CONFLICT (stream_id, user_id) DO UPDATE")
    // Regress path: no monotonic guard anywhere in the statement.
    expect(text).not.toContain("stream_events")
    expect(text).not.toMatch(/DO UPDATE SET .* WHERE/)
  })

  test("allows a null eventId (park before the first message)", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.set(db, "stream_1", "usr_1", null)
    expect(sqlValues(query.mock.calls[0])).toEqual(["stream_1", "usr_1", null])
  })
})

describe("ReadStateRepository.batchAdvance", () => {
  test("no-ops without querying on an empty map", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.batchAdvance(db, "usr_1", new Map())
    expect(query).not.toHaveBeenCalled()
  })

  test("unnests stream/event pairs with the same monotonic rule as advance", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.batchAdvance(
      db,
      "usr_1",
      new Map([
        ["stream_1", "evt_a"],
        ["stream_2", "evt_b"],
      ])
    )

    expect(query).toHaveBeenCalledTimes(1)
    const text = flat(sqlText(query.mock.calls[0]))
    expect(text).toContain("unnest($1::text[])")
    expect(text).toContain("ON CONFLICT (stream_id, user_id) DO UPDATE")
    expect(text).toContain("> COALESCE")
    expect(sqlValues(query.mock.calls[0])).toEqual([["stream_1", "stream_2"], ["evt_a", "evt_b"], "usr_1"])
  })
})

describe("ReadStateRepository.setForUsers", () => {
  test("no-ops without querying on an empty user list", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.setForUsers(db, "stream_1", [], "evt_1")
    expect(query).not.toHaveBeenCalled()
  })

  test("unconditionally sets one event across many users", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.setForUsers(db, "stream_1", ["usr_a", "usr_b"], "evt_1")
    const text = flat(sqlText(query.mock.calls[0]))
    expect(text).toContain("unnest($3::text[])")
    expect(text).toContain("ON CONFLICT (stream_id, user_id) DO UPDATE")
    expect(text).not.toContain("stream_events")
    expect(sqlValues(query.mock.calls[0])).toEqual(["stream_1", "evt_1", ["usr_a", "usr_b"]])
  })
})

describe("ReadStateRepository.repointForMovedEvents", () => {
  test("no-ops without querying on an empty move set", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.repointForMovedEvents(db, "stream_src", [])
    expect(query).not.toHaveBeenCalled()
  })

  test("mirrors the member-repository repoint shape, re-homed to stream_read_state/user_id", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.repointForMovedEvents(db, "stream_src", [
      { eventId: "evt_m1", sequence: 20n },
      { eventId: "evt_m2", sequence: 40n },
    ])

    const text = flat(sqlText(query.mock.calls[0]))
    // Same CTE skeleton as StreamMemberRepository.repointWatermarksForMovedEvents:
    // a moved(event_id, src_seq) unnest, a repoint subquery picking the greatest
    // surviving prior source sequence, then UPDATE ... FROM repoint.
    expect(text).toContain("WITH moved AS")
    expect(text).toContain("unnest($2::text[]) AS event_id")
    expect(text).toContain("unnest($3::bigint[]) AS src_seq")
    expect(text).toContain("e.sequence < moved.src_seq")
    expect(text).toContain("ORDER BY e.sequence DESC LIMIT 1")
    expect(text).toContain("FROM stream_read_state rs")
    expect(text).toContain("JOIN moved ON moved.event_id = rs.last_read_event_id")
    expect(text).toContain("UPDATE stream_read_state rs")
    expect(text).toContain("rs.user_id = repoint.user_id")
    // last_read_at deliberately untouched (automated correction, not a read).
    expect(text).not.toContain("last_read_at")
    expect(sqlValues(query.mock.calls[0])).toEqual(["stream_src", ["evt_m1", "evt_m2"], ["20", "40"]])
  })

  test("keeps the member-repository repoint SQL identical in everything but the table/key", async () => {
    // Guard against drift: the two repoints must stay structurally identical so
    // the shadow tracks membership exactly. Compare the normalized CTE + repoint
    // subquery, ignoring the table name and the member_id/user_id key column.
    const memberDb = makeDb()
    await StreamMemberRepository.repointWatermarksForMovedEvents(memberDb.db, "stream_src", [
      { eventId: "evt_m1", sequence: 20n },
    ])
    const memberText = flat(sqlText(memberDb.query.mock.calls[0]))
      .replace(/stream_members/g, "stream_read_state")
      .replace(/member_id/g, "user_id")
      .replace(/sm\b/g, "rs")
      // The read-state repoint additionally bumps updated_at (bookkeeping only).
      .replace(
        /SET last_read_event_id = repoint.new_event_id/,
        "SET last_read_event_id = repoint.new_event_id, updated_at = NOW()"
      )

    const { db, query } = makeDb()
    await ReadStateRepository.repointForMovedEvents(db, "stream_src", [{ eventId: "evt_m1", sequence: 20n }])
    const readStateText = flat(sqlText(query.mock.calls[0]))

    expect(readStateText).toBe(memberText)
  })
})

describe("ReadStateRepository readers", () => {
  test("get maps the row to camelCase and returns null when absent", async () => {
    const row = {
      workspace_id: "ws_1",
      stream_id: "stream_1",
      user_id: "usr_1",
      last_read_event_id: "evt_9",
      last_read_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    }
    const withRow = makeDb([row])
    expect(await ReadStateRepository.get(withRow.db, "stream_1", "usr_1")).toEqual({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_9",
      lastReadAt: row.last_read_at,
      updatedAt: row.updated_at,
    })

    const empty = makeDb([])
    expect(await ReadStateRepository.get(empty.db, "stream_1", "usr_1")).toBeNull()
  })

  test("getBatch returns [] without querying for an empty stream list", async () => {
    const { db, query } = makeDb()
    expect(await ReadStateRepository.getBatch(db, "usr_1", [])).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  test("listForUser scopes on workspace_id and user_id (bootstrap index)", async () => {
    const { db, query } = makeDb([])
    await ReadStateRepository.listForUser(db, "ws_1", "usr_1")
    const text = flat(sqlText(query.mock.calls[0]))
    expect(text).toContain("workspace_id = $1")
    expect(text).toContain("user_id = $2")
    expect(sqlValues(query.mock.calls[0])).toEqual(["ws_1", "usr_1"])
  })
})

describe("ReadStateRepository.ensureForUpdate", () => {
  test("seeds a never-read row then locks it — the non-member leg's serialization point", async () => {
    const row = {
      workspace_id: "ws_1",
      stream_id: "stream_1",
      user_id: "usr_1",
      last_read_event_id: null,
      last_read_at: null,
      updated_at: new Date(),
    }
    const query = mock()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    const db = { query } as unknown as Querier

    const result = await ReadStateRepository.ensureForUpdate(db, "stream_1", "usr_1")

    expect(query).toHaveBeenCalledTimes(2)
    const seed = flat(sqlText(query.mock.calls[0]))
    expect(seed).toContain("INSERT INTO stream_read_state")
    // DO NOTHING (not DO UPDATE): an existing row's watermark is never touched
    // by the seed — the lock is the point. Workspace derived from streams (INV-8).
    expect(seed).toContain("ON CONFLICT (stream_id, user_id) DO NOTHING")
    expect(seed).toContain("SELECT s.workspace_id")
    const lock = flat(sqlText(query.mock.calls[1]))
    expect(lock).toContain("FOR UPDATE")
    expect(result?.lastReadEventId).toBeNull()
  })

  test("returns null for a dangling stream id (no row to seed or lock)", async () => {
    const query = mock()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const db = { query } as unknown as Querier

    expect(await ReadStateRepository.ensureForUpdate(db, "stream_gone", "usr_1")).toBeNull()
  })
})

describe("ReadStateRepository lifecycle deletes", () => {
  test("deleteForWorkspace filters on workspace_id", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.deleteForWorkspace(db, "ws_1")
    expect(flat(sqlText(query.mock.calls[0]))).toContain("DELETE FROM stream_read_state WHERE workspace_id = $1")
    expect(sqlValues(query.mock.calls[0])).toEqual(["ws_1"])
  })

  test("deleteForUser filters on workspace_id and user_id (INV-8)", async () => {
    const { db, query } = makeDb()
    await ReadStateRepository.deleteForUser(db, "ws_1", "usr_1")
    const text = flat(sqlText(query.mock.calls[0]))
    expect(text).toContain("workspace_id = $1")
    expect(text).toContain("user_id = $2")
    expect(sqlValues(query.mock.calls[0])).toEqual(["ws_1", "usr_1"])
  })
})
