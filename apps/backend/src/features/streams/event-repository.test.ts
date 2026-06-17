import { describe, expect, test, mock } from "bun:test"
import { StreamEventRepository } from "./event-repository"
import type { Querier } from "../../db"

function makeDb(rows: Record<string, unknown>[]) {
  const query = mock(() => Promise.resolve({ rows, rowCount: rows.length }))
  return { query, _query: query } as unknown as Querier & { _query: ReturnType<typeof mock> }
}

describe("StreamEventRepository.findFirstMessageOnOrAfter", () => {
  test("maps the first row to an event", async () => {
    const db = makeDb([
      {
        id: "evt_1",
        stream_id: "stream_1",
        sequence: "42",
        broadcast_sequence: "10",
        event_type: "message_created",
        payload: { messageId: "msg_1" },
        actor_id: "usr_1",
        actor_type: "user",
        created_at: new Date("2026-06-16T09:00:00.000Z"),
      },
    ])

    const event = await StreamEventRepository.findFirstMessageOnOrAfter(
      db,
      "stream_1",
      new Date("2026-06-16T00:00:00.000Z")
    )

    expect(event?.id).toBe("evt_1")
    expect(event?.sequence).toBe(42n)
    expect(db._query).toHaveBeenCalledTimes(1)
  })

  test("returns null when no message lands on or after the date", async () => {
    const db = makeDb([])
    const event = await StreamEventRepository.findFirstMessageOnOrAfter(db, "stream_1", new Date())
    expect(event).toBeNull()
    expect(db._query).toHaveBeenCalledTimes(1)
  })
})
