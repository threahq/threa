import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import Dexie from "dexie"
import { db, type CachedEvent } from "@/db"
import { useMovedTombstone } from "./use-moved-tombstone"

const WORKSPACE_ID = "ws_1"

function makeTombstone(id: string, movedCount: number): CachedEvent {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    streamId: "stream_source",
    sequence: "10",
    _sequenceNum: 10,
    eventType: "messages:moved",
    payload: { movedCount },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date(2026, 0, 1).toISOString(),
    _cachedAt: Date.now(),
  }
}

describe("useMovedTombstone", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("should resolve the tombstone once it lands in IDB and follow its updates", async () => {
    const { result } = renderHook(() => useMovedTombstone(WORKSPACE_ID, "evt_tombstone"))
    expect(result.current).toBeUndefined()

    await db.events.put(makeTombstone("evt_tombstone", 2))
    await waitFor(() => expect(result.current?.payload).toEqual({ movedCount: 2 }))

    await db.events.put(makeTombstone("evt_tombstone", 3))
    await waitFor(() => expect(result.current?.payload).toEqual({ movedCount: 3 }))
  })

  it("should not listen to IDB writes for a message that was never moved", async () => {
    const liveQuery = vi.spyOn(Dexie, "liveQuery")
    const { result } = renderHook(() => useMovedTombstone(WORKSPACE_ID, undefined))

    await db.events.put(makeTombstone("evt_tombstone", 2))

    expect({ value: result.current, liveQueries: liveQuery.mock.calls.length }).toEqual({
      value: undefined,
      liveQueries: 0,
    })
  })
})
