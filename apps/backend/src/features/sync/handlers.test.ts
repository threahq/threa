import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createSyncHandlers } from "./handlers"
import { HttpError } from "../../lib/errors"
import type { SyncService } from "./service"

function makeReqRes(query: Record<string, string>) {
  const req = {
    user: { id: "usr_alice" },
    workspaceId: "ws_1",
    query,
  } as unknown as Request
  const json = mock((_body: unknown) => {})
  const res = { json } as unknown as Response
  return { req, res, json }
}

describe("createSyncHandlers.catchUp", () => {
  it("returns entries and head as wire strings", async () => {
    const catchUp = mock(async (_params: Parameters<SyncService["catchUp"]>[0]) => ({
      entries: [
        {
          syncId: 7n,
          eventType: "message:created",
          payload: { workspaceId: "ws_1" },
          createdAt: new Date("2026-06-11T08:00:00Z"),
        },
      ],
      head: 9n,
    }))
    const handlers = createSyncHandlers({ syncService: { catchUp } as unknown as SyncService })

    const { req, res, json } = makeReqRes({ after: "5", limit: "50" })
    await handlers.catchUp(req, res)

    expect(catchUp.mock.calls[0][0]).toEqual({ workspaceId: "ws_1", userId: "usr_alice", after: 5n, limit: 50 })
    expect(json.mock.calls[0][0]).toEqual({
      entries: [
        {
          syncId: "7",
          eventType: "message:created",
          payload: { workspaceId: "ws_1" },
          createdAt: "2026-06-11T08:00:00.000Z",
        },
      ],
      head: "9",
    })
  })

  it("defaults after to 0 and limit to 200", async () => {
    const catchUp = mock(async (_params: Parameters<SyncService["catchUp"]>[0]) => ({ entries: [], head: 0n }))
    const handlers = createSyncHandlers({ syncService: { catchUp } as unknown as SyncService })

    const { req, res } = makeReqRes({})
    await handlers.catchUp(req, res)

    expect(catchUp.mock.calls[0][0]).toEqual({ workspaceId: "ws_1", userId: "usr_alice", after: 0n, limit: 200 })
  })

  it("rejects a non-numeric cursor with a 400", async () => {
    const catchUp = mock(async (_params: Parameters<SyncService["catchUp"]>[0]) => ({ entries: [], head: 0n }))
    const handlers = createSyncHandlers({ syncService: { catchUp } as unknown as SyncService })

    const { req, res } = makeReqRes({ after: "abc" })
    await expect(handlers.catchUp(req, res)).rejects.toThrow(HttpError)
    expect(catchUp.mock.calls).toHaveLength(0)
  })
})
