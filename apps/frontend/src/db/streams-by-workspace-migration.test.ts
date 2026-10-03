import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { ThreaDatabase } from "./database"

const sharedSlot = (messageId: string) => ({ type: "sharedMessage", state: "missing", messageId })

async function seedV50(name: string, seed: (legacy: Dexie) => Promise<void>): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(50).stores({
    streams: "id, workspaceId, type, [workspaceId+type], _cachedAt",
    slots: "[streamId+slotKey], streamId, workspaceId, _cachedAt",
    boardMutedStreams: "id, workspaceId",
  })
  await legacy.open()
  await seed(legacy)
  legacy.close()
}

describe("v52 streams, slots and board mutes keyed by workspace", () => {
  it("should carry rows that name a workspace to the new keys and drop the rest when upgrading from v50", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const stream = { id: "stream_1", workspaceId: "ws_1", type: "channel", displayName: "general", _cachedAt: 1000 }
    const slot = {
      workspaceId: "ws_1",
      streamId: "stream_1",
      slotKey: "shared:msg_1",
      value: sharedSlot("msg_1"),
      _cachedAt: 1000,
    }
    const muted = { id: "stream_1", workspaceId: "ws_1", _cachedAt: 1000 }
    await seedV50(name, async (legacy) => {
      await legacy.table("streams").bulkPut([stream, { id: "stream_orphan", type: "channel", _cachedAt: 1000 }])
      await legacy
        .table("slots")
        .bulkPut([
          slot,
          { streamId: "stream_orphan", slotKey: "shared:msg_2", value: sharedSlot("msg_2"), _cachedAt: 1000 },
        ])
      await legacy.table("boardMutedStreams").bulkPut([muted, { id: "stream_orphan", _cachedAt: 1000 }])
    })

    const db = new ThreaDatabase(name)
    await db.open()

    expect({
      streams: await db.streams.toArray(),
      slots: await db.slots.toArray(),
      muted: await db.boardMutedStreams.toArray(),
      byKey: await db.streams.get(["ws_1", "stream_1"]),
    }).toEqual({
      streams: [stream],
      slots: [slot],
      muted: [muted],
      byKey: stream,
    })

    db.close()
    await Dexie.delete(name)
  })

  it("should keep the same stream id separate per workspace when written after the upgrade", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    await seedV50(name, async (legacy) => {
      await legacy
        .table("streams")
        .put({ id: "stream_copied", workspaceId: "ws_a", type: "channel", displayName: "in a", _cachedAt: 1 })
    })

    const db = new ThreaDatabase(name)
    await db.open()
    await db.streams.put({
      id: "stream_copied",
      workspaceId: "ws_b",
      type: "channel",
      displayName: "in b",
      _cachedAt: 2,
    } as never)
    await db.slots.bulkPut([
      { workspaceId: "ws_a", streamId: "stream_copied", slotKey: "shared:msg_1", value: sharedSlot("a"), _cachedAt: 1 },
      { workspaceId: "ws_b", streamId: "stream_copied", slotKey: "shared:msg_1", value: sharedSlot("b"), _cachedAt: 2 },
    ] as never)
    await db.boardMutedStreams.bulkPut([
      { id: "stream_copied", workspaceId: "ws_a", _cachedAt: 1 },
      { id: "stream_copied", workspaceId: "ws_b", _cachedAt: 2 },
    ])

    expect({
      names: [
        (await db.streams.get(["ws_a", "stream_copied"]))?.displayName,
        (await db.streams.get(["ws_b", "stream_copied"]))?.displayName,
      ],
      slotMessages: [
        (await db.slots.where("[workspaceId+streamId]").equals(["ws_a", "stream_copied"]).toArray()).map(
          (row) => (row.value as { messageId: string }).messageId
        ),
        (await db.slots.where("[workspaceId+streamId]").equals(["ws_b", "stream_copied"]).toArray()).map(
          (row) => (row.value as { messageId: string }).messageId
        ),
      ],
      muted: (await db.boardMutedStreams.toArray()).map((row) => row.workspaceId).sort(),
    }).toEqual({ names: ["in a", "in b"], slotMessages: [["a"], ["b"]], muted: ["ws_a", "ws_b"] })

    db.close()
    await Dexie.delete(name)
  })
})
