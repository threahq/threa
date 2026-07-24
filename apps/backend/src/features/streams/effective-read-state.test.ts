import { describe, expect, test, mock, spyOn, afterEach } from "bun:test"
import { getEffectiveReadState, usersReadThroughEffective } from "./effective-read-state"
import { ReadStateRepository } from "./read-state-repository"
import type { Querier } from "../../db"

function makeDb(rows: Record<string, unknown>[] = []) {
  const query = mock(() => Promise.resolve({ rows, rowCount: rows.length }))
  return { db: { query } as unknown as Querier, query }
}

/** Collapse whitespace so multi-line SQL can be matched with plain substrings. */
function flat(text: unknown): string {
  return String(text).replace(/\s+/g, " ").trim()
}

function sqlText(call: unknown[]): string {
  const arg = call[0]
  return typeof arg === "string" ? arg : (arg as { text: string }).text
}

const STREAM_IDS = ["stream_present_null", "stream_present", "stream_absent"]

describe("getEffectiveReadState", () => {
  afterEach(() => mock.restore())

  test("stream_read_state is the sole source — a present NULL stays NULL, an absent row is never-read", async () => {
    spyOn(ReadStateRepository, "getBatch").mockResolvedValue([
      // Explicit unread-to-zero: the row exists with a NULL watermark and is
      // reported as-is (row presence is authoritative).
      {
        workspaceId: "ws_1",
        streamId: "stream_present_null",
        userId: "usr_1",
        lastReadEventId: null,
        lastReadAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date(),
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_present",
        userId: "usr_1",
        lastReadEventId: "evt_read_state",
        lastReadAt: new Date("2026-02-02T00:00:00.000Z"),
        updatedAt: new Date(),
      },
    ])

    const effective = await getEffectiveReadState({} as never, "usr_1", STREAM_IDS)

    expect(effective.get("stream_present_null")?.lastReadEventId).toBeNull()
    expect(effective.get("stream_present")?.lastReadEventId).toBe("evt_read_state")
    // No row → never-read (NULL watermark), not a membership fallback.
    expect(effective.get("stream_absent")).toEqual({
      streamId: "stream_absent",
      lastReadEventId: null,
      lastReadAt: null,
    })
  })

  test("queries the standalone store for exactly the requested stream ids", async () => {
    const getBatch = spyOn(ReadStateRepository, "getBatch").mockResolvedValue([])
    await getEffectiveReadState({} as never, "usr_1", STREAM_IDS)
    expect(getBatch).toHaveBeenCalledWith({}, "usr_1", STREAM_IDS)
  })
})

describe("usersReadThroughEffective", () => {
  test("no-ops without querying on an empty user list", async () => {
    const { db, query } = makeDb()
    expect(await usersReadThroughEffective(db, "ws_1", "stream_1", [], 10n)).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  test("reads solely from stream_read_state — membership-agnostic, no membership join", async () => {
    const { db, query } = makeDb()
    await usersReadThroughEffective(db, "ws_1", "stream_1", ["usr_a", "usr_b"], 42n)

    const text = flat(sqlText(query.mock.calls[0]))
    // Watermark sequence resolved via stream_events, bound to the same stream
    // (not just by event id) so a stale/corrupt cross-stream watermark can't
    // qualify. No stream_members anywhere — a non-member viewer's own row
    // qualifies (INV-62 access without membership), closing the late-insert race.
    expect(text).toContain(
      "FROM stream_read_state rs JOIN stream_events se ON se.id = rs.last_read_event_id AND se.stream_id = rs.stream_id"
    )
    expect(text).toContain("rs.workspace_id = $1")
    expect(text).not.toContain("stream_members")
    expect(text).not.toContain("UNION")
  })

  test("maps the returned user ids into the born-read set", async () => {
    const { db } = makeDb([{ user_id: "usr_a" }, { user_id: "usr_b" }])
    expect(await usersReadThroughEffective(db, "ws_1", "stream_1", ["usr_a", "usr_b", "usr_c"], 42n)).toEqual(
      new Set(["usr_a", "usr_b"])
    )
  })
})
