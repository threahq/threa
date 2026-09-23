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
    const markResult = {
      membership,
      readState: { lastReadEventId: "evt_1", lastReadSequence: "42", lastReadAt: null },
      lastReadOrdinal: 7,
      readMessageIds: [],
      inboxHeld: false,
    }
    const markAsReadInTransaction = mock(() => Promise.resolve(markResult))
    const markStreamActivityAsReadInTransaction = mock(() => Promise.resolve())
    const service = new StreamReadService({
      pool: {} as never,
      streamService: { markAsReadInTransaction } as never,
      activityService: { markStreamActivityAsReadInTransaction, markStreamsAsReadInTransaction: mock() },
    })

    const result = await service.markAsRead("ws_1", "stream_1", "usr_1", { eventId: "evt_1" })

    expect(result).toBe(markResult)
    expect(markAsReadInTransaction).toHaveBeenCalledWith(client, "ws_1", "stream_1", "usr_1", "evt_1")
    expect(markStreamActivityAsReadInTransaction).toHaveBeenCalledWith(client, "usr_1", "ws_1", "stream_1")
  })

  it("fails the transaction when the activity clear fails", async () => {
    const service = new StreamReadService({
      pool: {} as never,
      streamService: {
        markAsReadInTransaction: mock(() =>
          Promise.resolve({ membership: null, readState: null, lastReadOrdinal: null, readMessageIds: null })
        ),
      } as never,
      activityService: {
        markStreamActivityAsReadInTransaction: mock(() => Promise.reject(new Error("activity write failed"))),
        markStreamsAsReadInTransaction: mock(),
      },
    })

    await expect(service.markAsRead("ws_1", "stream_1", "usr_1", { eventId: "evt_1" })).rejects.toThrow(
      "activity write failed"
    )
  })
})

describe("StreamReadService.clearInbox", () => {
  it("marks activity read for every accessible stream on the clear's transaction client", async () => {
    const frontiers = [
      {
        streamId: "stream_1",
        lastReadEventId: "evt_1",
        lastReadSequence: "4",
        lastReadOrdinal: 2,
        lastReadAt: null,
      },
    ]
    const clearInboxInTransaction = mock(() =>
      Promise.resolve({ accessibleStreamIds: ["stream_1", "stream_2"], clearedStreamIds: ["stream_2"], frontiers })
    )
    const markStreamsAsReadInTransaction = mock(() => Promise.resolve())
    const service = new StreamReadService({
      pool: {} as never,
      streamService: { clearInboxInTransaction } as never,
      activityService: { markStreamActivityAsReadInTransaction: mock(), markStreamsAsReadInTransaction },
    })

    const result = await service.clearInbox("ws_1", "usr_1", ["stream_1", "stream_2", "stream_private"])

    expect(result).toEqual({ clearedStreamIds: ["stream_2"], frontiers })
    expect(clearInboxInTransaction).toHaveBeenCalledWith(client, "ws_1", "usr_1", [
      "stream_1",
      "stream_2",
      "stream_private",
    ])
    expect(markStreamsAsReadInTransaction).toHaveBeenCalledWith(client, "usr_1", "ws_1", ["stream_1", "stream_2"])
  })

  it("fails the transaction when the activity clear fails", async () => {
    const service = new StreamReadService({
      pool: {} as never,
      streamService: {
        clearInboxInTransaction: mock(() =>
          Promise.resolve({ accessibleStreamIds: ["stream_1"], clearedStreamIds: ["stream_1"], frontiers: [] })
        ),
      } as never,
      activityService: {
        markStreamActivityAsReadInTransaction: mock(),
        markStreamsAsReadInTransaction: mock(() => Promise.reject(new Error("activity write failed"))),
      },
    })

    await expect(service.clearInbox("ws_1", "usr_1", ["stream_1"])).rejects.toThrow("activity write failed")
  })
})
