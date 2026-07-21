import { beforeEach, describe, expect, it } from "vitest"
import { db } from "@/db"
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

    expect(await nextOptimisticSequence("stream_1", 1000)).toBe("1002")
  })
})
