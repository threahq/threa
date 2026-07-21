import { describe, expect, mock, test } from "bun:test"
import type { Querier } from "../../db"
import { CommandDispatchRepository } from "./repository"

function makeDb(rows: Record<string, unknown>[], rowCount = rows.length) {
  const query = mock(() => Promise.resolve({ rows, rowCount }))
  return { query, _query: query } as unknown as Querier & { _query: ReturnType<typeof mock> }
}

const params = {
  commandId: "cmd_1",
  workspaceId: "ws_1",
  userId: "usr_1",
  streamId: "stream_1",
  clientCommandId: "temp_cmd_1",
  eventId: "evt_1",
}

describe("CommandDispatchRepository", () => {
  test("claims a new client command id", async () => {
    const db = makeDb([{ command_id: "cmd_1" }], 1)

    expect(await CommandDispatchRepository.claim(db, params)).toBe(true)
  })

  test("reports an existing client command id", async () => {
    const db = makeDb([], 0)

    expect(await CommandDispatchRepository.claim(db, params)).toBe(false)
  })

  test("finds an existing dispatch within its workspace, user, and stream scope", async () => {
    const db = makeDb([{ command_id: "cmd_1", event_id: "evt_1" }])

    expect(
      await CommandDispatchRepository.findByClientId(db, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        streamId: params.streamId,
        clientCommandId: params.clientCommandId,
      })
    ).toEqual({ commandId: "cmd_1", eventId: "evt_1" })
  })
})
