import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { ThreaDatabase } from "./database"

describe("v47 payload.messageId index", () => {
  it("opening at v47 indexes payload.messageId over pre-existing rows", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`

    // Seed at the v46 events shape — the last version before the dotted-key-path
    // index — so the row exists before the index does.
    const legacy = new Dexie(name)
    legacy.version(46).stores({
      events:
        "id, workspaceId, streamId, sequence, [streamId+sequence], [streamId+_sequenceNum], eventType, [streamId+eventType], _clientId, _cachedAt, _status",
    })
    await legacy.open()
    await legacy.table("events").bulkPut([
      {
        id: "event_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        sequence: "1",
        _sequenceNum: 1,
        eventType: "message_created",
        payload: { messageId: "msg_1", contentMarkdown: "hello" },
        _cachedAt: 1000,
      },
      {
        id: "event_2",
        workspaceId: "ws_1",
        streamId: "stream_1",
        sequence: "2",
        _sequenceNum: 2,
        eventType: "call_started",
        payload: { callId: "call_1" },
        _cachedAt: 1000,
      },
    ])
    legacy.close()

    const db = new ThreaDatabase(name)
    await db.open()

    // The engine built the index over the pre-existing row: the query finds it
    // without any row having been rewritten, and the payload is intact.
    const matched = await db.events.where("payload.messageId").equals("msg_1").toArray()
    expect(matched.map((row) => ({ id: row.id, payload: row.payload }))).toEqual([
      { id: "event_1", payload: { messageId: "msg_1", contentMarkdown: "hello" } },
    ])

    // Sparse: the row carrying no payload.messageId is not in the index.
    const all = await db.events.where("payload.messageId").notEqual("").count()
    expect(all).toBe(1)

    // The upgrade ADDS an index; it must not drop the ones the v46 store
    // declared. Querying them on the upgraded handle is what makes a silently
    // dropped index red instead of invisible.
    const byStreamAndType = await db.events
      .where("[streamId+eventType]")
      .equals(["stream_1", "message_created"])
      .count()
    const byStatus = await db.events.where("_status").equals("pending").count()
    expect({ byStreamAndType, byStatus }).toEqual({ byStreamAndType: 1, byStatus: 0 })

    db.close()
    await Dexie.delete(name)
  })
})
