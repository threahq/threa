import { describe, expect, test, mock } from "bun:test"
import { SparseReadRepository } from "./sparse-read-repository"
import type { Querier } from "../../db"

function makeDb(rows: Record<string, unknown>[]) {
  const query = mock(() => Promise.resolve({ rows, rowCount: rows.length }))
  return { query, _query: query } as unknown as Querier & { _query: ReturnType<typeof mock> }
}

describe("SparseReadRepository row mapping", () => {
  test("listOverlayIds returns message ids in row order", async () => {
    const db = makeDb([{ message_id: "msg_a" }, { message_id: "msg_b" }])
    const ids = await SparseReadRepository.listOverlayIds(db, "stream_1", "usr_1")
    expect(ids).toEqual(["msg_a", "msg_b"])
    expect(db._query).toHaveBeenCalledTimes(1)
  })

  test("listOverlayIdsForMember groups ids by stream id, preserving order", async () => {
    const db = makeDb([
      { stream_id: "stream_1", message_id: "msg_a" },
      { stream_id: "stream_1", message_id: "msg_b" },
      { stream_id: "stream_2", message_id: "msg_c" },
    ])
    const map = await SparseReadRepository.listOverlayIdsForMember(db, "usr_1", ["stream_1", "stream_2"])
    expect(Object.fromEntries(map)).toEqual({ stream_1: ["msg_a", "msg_b"], stream_2: ["msg_c"] })
  })

  test("findCompactionTarget maps the row to an event id + bigint sequence", async () => {
    const db = makeDb([{ event_id: "evt_9", sequence: "42" }])
    const target = await SparseReadRepository.findCompactionTarget(db, "stream_1", "usr_1", 0n)
    expect(target).toEqual({ eventId: "evt_9", sequence: 42n })
  })

  test("findCompactionTarget returns null when nothing above the watermark is covered", async () => {
    const db = makeDb([])
    expect(await SparseReadRepository.findCompactionTarget(db, "stream_1", "usr_1", 5n)).toBeNull()
  })

  test("countOverlay parses the count", async () => {
    const db = makeDb([{ count: "3" }])
    expect(await SparseReadRepository.countOverlay(db, "stream_1", "usr_1")).toBe(3)
  })

  test("empty-input guards short-circuit without a query", async () => {
    const db = makeDb([])
    await SparseReadRepository.insertReads(db, { workspaceId: "ws", streamId: "s", memberId: "m", messageIds: [] })
    await SparseReadRepository.deleteReads(db, "s", "m", [])
    await SparseReadRepository.rehomeReads(db, { sourceStreamId: "s", destinationStreamId: "d", messageIds: [] })
    expect(await SparseReadRepository.listOverlayIdsForMember(db, "m", [])).toEqual(new Map())
    expect(db._query).not.toHaveBeenCalled()
  })
})
