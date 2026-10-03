import { beforeEach, describe, expect, it } from "vitest"
import { db, type CachedEvent } from "@/db"
import { nextOptimisticSequence } from "./optimistic-sequence"

describe("nextOptimisticSequence", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  it("advances beyond the durable stream sequence when clocks tie or move backward", async () => {
    await db.events.put({
      id: "temp_existing",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sequence: "1001",
      _sequenceNum: 1001,
      eventType: "message_created",
      payload: {},
      actorId: "usr_1",
      actorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      _status: "pending",
      _cachedAt: 1,
    })

    expect(await nextOptimisticSequence("ws_1", "stream_1", 1000)).toBe("1002")
  })

  it("should allocate each workspace's sequence from its own rows when both hold the same stream id", async () => {
    const copiedRow = (workspaceId: string, sequence: number): CachedEvent => ({
      id: "evt_copied",
      workspaceId,
      streamId: "stream_1",
      sequence: String(sequence),
      _sequenceNum: sequence,
      eventType: "message_created",
      payload: {},
      actorId: "usr_1",
      actorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      _cachedAt: 1,
    })
    await db.events.bulkPut([copiedRow("ws_1", 1001), copiedRow("ws_2", 5000)])

    expect({
      ws_1: await nextOptimisticSequence("ws_1", "stream_1", 1000),
      ws_2: await nextOptimisticSequence("ws_2", "stream_1", 1000),
    }).toEqual({ ws_1: "1002", ws_2: "5001" })
  })
})
