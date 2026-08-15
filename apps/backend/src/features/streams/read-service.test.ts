import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import * as dbModule from "../../db"
import { StreamReadService } from "./read-service"

const client = {} as PoolClient

beforeEach(() => {
  spyOn(dbModule, "withTransaction").mockImplementation((async (
    _pool: Pool,
    operation: (transactionClient: PoolClient) => Promise<unknown>
  ) => operation(client)) as never)
})

afterEach(() => {
  mock.restore()
})

describe("StreamReadService.markAsRead", () => {
  it("advances the frontier and clears activity on the same transaction client", async () => {
    const membership = {
      streamId: "stream_1",
      memberId: "usr_1",
      notificationLevel: null,
      joinedAt: new Date(),
    }
    const markAsReadInTransaction = mock(() => Promise.resolve(membership))
    const markStreamActivityAsReadInTransaction = mock(() => Promise.resolve())
    const service = new StreamReadService({
      pool: {} as never,
      streamService: { markAsReadInTransaction } as never,
      activityService: { markStreamActivityAsReadInTransaction },
    })

    const result = await service.markAsRead("ws_1", "stream_1", "usr_1", "evt_1")

    expect(result).toBe(membership)
    expect(markAsReadInTransaction).toHaveBeenCalledWith(client, "ws_1", "stream_1", "usr_1", "evt_1")
    expect(markStreamActivityAsReadInTransaction).toHaveBeenCalledWith(client, "usr_1", "ws_1", "stream_1")
  })

  it("fails the transaction when the activity clear fails", async () => {
    const service = new StreamReadService({
      pool: {} as never,
      streamService: { markAsReadInTransaction: mock(() => Promise.resolve(null)) } as never,
      activityService: {
        markStreamActivityAsReadInTransaction: mock(() => Promise.reject(new Error("activity write failed"))),
      },
    })

    await expect(service.markAsRead("ws_1", "stream_1", "usr_1", "evt_1")).rejects.toThrow("activity write failed")
  })
})
