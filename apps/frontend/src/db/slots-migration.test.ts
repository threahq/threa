import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { ThreaDatabase } from "./database"

describe("v42 slots migration", () => {
  it("adds an empty writable slots table without disturbing v41 stream/event rows", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`

    // Seed a v41 database — the last version before the slot store — carrying a
    // stream row and an event row. v41 persisted no hydration carrier, so there
    // is nothing for the upgrade to transform.
    const legacy = new Dexie(name)
    legacy.version(41).stores({
      streams: "id, workspaceId, type, [workspaceId+type], _cachedAt",
      events:
        "id, workspaceId, streamId, sequence, [streamId+sequence], [streamId+_sequenceNum], eventType, [streamId+eventType], _clientId, _cachedAt, _status",
    })
    await legacy.open()
    await legacy.table("streams").put({ id: "stream_1", workspaceId: "ws_1", type: "channel", _cachedAt: 1000 })
    await legacy.table("events").put({
      id: "event_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sequence: "1",
      _sequenceNum: 1,
      eventType: "message_created",
      _cachedAt: 1000,
    })
    legacy.close()

    const db = new ThreaDatabase(name)
    await db.open()

    // Existing rows survive the no-op upgrade.
    expect(await db.streams.get("stream_1")).toMatchObject({ id: "stream_1", workspaceId: "ws_1" })
    expect(await db.events.get("event_1")).toMatchObject({ id: "event_1", streamId: "stream_1" })

    // The new table starts empty and is writable under its compound key.
    expect(await db.slots.toArray()).toEqual([])
    await db.slots.put({
      workspaceId: "ws_1",
      streamId: "stream_1",
      slotKey: "shared:msg_1",
      value: { type: "sharedMessage", state: "missing", messageId: "msg_1" },
      _cachedAt: 2000,
    })
    const rows = await db.slots.where("streamId").equals("stream_1").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].slotKey).toBe("shared:msg_1")

    db.close()
    await Dexie.delete(name)
  })
})
