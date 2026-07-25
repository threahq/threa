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

const MEMBERSHIPS = [
  {
    streamId: "stream_present_null",
    lastReadEventId: "evt_membership",
    lastReadAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    streamId: "stream_present",
    lastReadEventId: "evt_membership_old",
    lastReadAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    streamId: "stream_absent",
    lastReadEventId: "evt_membership_fallback",
    lastReadAt: new Date("2026-01-02T00:00:00.000Z"),
  },
]

describe("getEffectiveReadState", () => {
  afterEach(() => mock.restore())

  test("a present row wins over membership — including a NULL watermark (explicit unread-to-zero)", async () => {
    spyOn(ReadStateRepository, "getBatch").mockResolvedValue([
      // Explicit unread-to-zero: the row exists with a NULL watermark and must
      // beat the non-null membership column — row presence, not field
      // nullability, selects the source.
      {
        workspaceId: "ws_1",
        streamId: "stream_present_null",
        userId: "usr_1",
        lastReadEventId: null,
        lastReadAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date(),
      },
      // Read-state above a regressed membership watermark: cutover converges
      // upward only.
      {
        workspaceId: "ws_1",
        streamId: "stream_present",
        userId: "usr_1",
        lastReadEventId: "evt_read_state",
        lastReadAt: new Date("2026-02-02T00:00:00.000Z"),
        updatedAt: new Date(),
      },
    ])

    const effective = await getEffectiveReadState({} as never, "usr_1", MEMBERSHIPS)

    expect(effective.get("stream_present_null")?.lastReadEventId).toBeNull()
    expect(effective.get("stream_present")?.lastReadEventId).toBe("evt_read_state")
    // No row → membership columns fill (rolling-deploy / pre-cutover fallback).
    expect(effective.get("stream_absent")).toEqual({
      streamId: "stream_absent",
      lastReadEventId: "evt_membership_fallback",
      lastReadAt: MEMBERSHIPS[2].lastReadAt,
    })
  })

  test("queries the standalone store for exactly the membership stream ids", async () => {
    const getBatch = spyOn(ReadStateRepository, "getBatch").mockResolvedValue([])
    await getEffectiveReadState({} as never, "usr_1", MEMBERSHIPS)
    expect(getBatch).toHaveBeenCalledWith({}, "usr_1", ["stream_present_null", "stream_present", "stream_absent"])
  })
})

describe("usersReadThroughEffective", () => {
  test("no-ops without querying on an empty user list", async () => {
    const { db, query } = makeDb()
    expect(await usersReadThroughEffective(db, "ws_1", "stream_1", [], 10n)).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  test("read-state branch is membership-agnostic — access, not membership, gates born-read", async () => {
    const { db, query } = makeDb()
    await usersReadThroughEffective(db, "ws_1", "stream_1", ["usr_a", "usr_b"], 42n)

    const text = flat(sqlText(query.mock.calls[0]))
    // Read-state branch: watermark sequence resolved via stream_events, with
    // NO stream_members join — a non-member viewer's own row qualifies
    // (INV-62 access without membership), closing the late-insert race.
    expect(text).toContain("FROM stream_read_state rs JOIN stream_events se ON se.id = rs.last_read_event_id")
    expect(text).not.toContain("JOIN stream_members sm ON sm.stream_id = rs.stream_id")
    expect(text).toContain("rs.workspace_id = $1")
    // Membership branch guarded by row absence — a present row (even with a
    // NULL watermark) never falls through to the membership column.
    expect(text).toContain("FROM stream_members sm")
    expect(text).toContain("NOT EXISTS")
    expect(text).toContain("rs.user_id = sm.member_id")
    expect(text).toContain("UNION")
    // INV-8 hardening on the membership fallback: it joins `streams` on the
    // membership's stream and requires the workspace match, and binds the
    // watermark event to that same stream (not just by event id) — a
    // stale/corrupt cross-workspace watermark can't qualify a member.
    expect(text).toContain("JOIN streams s ON s.id = sm.stream_id")
    expect(text).toContain("s.workspace_id =")
    expect(text).toContain("se.stream_id = sm.stream_id")
    // Row-presence stays authoritative, now workspace-scoped.
    expect(text).toContain("rs.user_id = sm.member_id AND rs.workspace_id =")
  })

  test("maps the returned user ids into the born-read set", async () => {
    const { db } = makeDb([{ user_id: "usr_a" }, { user_id: "usr_b" }])
    expect(await usersReadThroughEffective(db, "ws_1", "stream_1", ["usr_a", "usr_b", "usr_c"], 42n)).toEqual(
      new Set(["usr_a", "usr_b"])
    )
  })
})
