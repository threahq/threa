import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { ThreaDatabase, type CachedEvent } from "./database"

const V47_EVENTS =
  "id, workspaceId, streamId, sequence, [streamId+sequence], [streamId+_sequenceNum], eventType, [streamId+eventType], _clientId, _cachedAt, _status, payload.messageId"

function cachedEvent(overrides: Partial<CachedEvent> & Pick<CachedEvent, "id" | "workspaceId">): CachedEvent {
  const sequence = overrides._sequenceNum ?? 1
  return {
    streamId: "stream_1",
    sequence: String(sequence),
    _sequenceNum: sequence,
    eventType: "message_created",
    payload: { messageId: `msg_${overrides.id}`, contentMarkdown: overrides.id },
    actorId: "usr_1",
    actorType: "user",
    createdAt: "2026-08-20T10:00:00.000Z",
    _cachedAt: 1000,
    ...overrides,
  }
}

async function seedV50(name: string, seed: (legacy: Dexie) => Promise<void>): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(50).stores({ events: V47_EVENTS })
  await legacy.open()
  await seed(legacy)
  legacy.close()
}

describe("v51 events keyed by workspace", () => {
  it("should carry rows that name a workspace to the new keys and drop the rest when upgrading from v50", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const second = cachedEvent({ id: "evt_2", workspaceId: "ws_1", _sequenceNum: 2 })
    const first = cachedEvent({ id: "evt_1", workspaceId: "ws_1", _sequenceNum: 1 })
    const otherWorkspace = cachedEvent({
      id: "evt_3",
      workspaceId: "ws_2",
      streamId: "stream_2",
      _status: "pending",
    })
    const { workspaceId: _omitted, ...withoutWorkspace } = cachedEvent({ id: "evt_orphan", workspaceId: "ws_1" })
    await seedV50(name, async (legacy) => {
      await legacy.table("events").bulkPut([second, first, otherWorkspace, withoutWorkspace])
    })

    const db = new ThreaDatabase(name)
    await db.open()

    expect({
      events: await db.events.toArray(),
      byKey: await db.events.get(["ws_1", "evt_1"]),
      bySequence: await db.events
        .where("[workspaceId+streamId+_sequenceNum]")
        .between(["ws_1", "stream_1", Dexie.minKey], ["ws_1", "stream_1", Dexie.maxKey])
        .toArray(),
      byMessage: await db.events.where("[workspaceId+payload.messageId]").equals(["ws_1", "msg_evt_2"]).toArray(),
      unsent: await db.events.where("_status").equals("pending").toArray(),
      orphan: await db.events.get(["ws_1", "evt_orphan"]),
    }).toEqual({
      events: [first, second, otherWorkspace],
      byKey: first,
      bySequence: [first, second],
      byMessage: [second],
      unsent: [otherWorkspace],
      orphan: undefined,
    })

    db.close()
    await Dexie.delete(name)
  })

  it("should keep the same event id separate per workspace when written after the upgrade", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const inA = cachedEvent({
      id: "evt_copied",
      workspaceId: "ws_a",
      payload: { messageId: "msg_copied", contentMarkdown: "in a" },
    })
    const inB = cachedEvent({
      id: "evt_copied",
      workspaceId: "ws_b",
      payload: { messageId: "msg_copied", contentMarkdown: "in b" },
    })
    await seedV50(name, async (legacy) => {
      await legacy.table("events").put(inA)
    })

    const db = new ThreaDatabase(name)
    await db.open()
    await db.events.put(inB)

    expect({
      events: await db.events.toArray(),
      streamInA: await db.events.where("[workspaceId+streamId]").equals(["ws_a", "stream_1"]).toArray(),
      streamInB: await db.events.where("[workspaceId+streamId]").equals(["ws_b", "stream_1"]).toArray(),
    }).toEqual({ events: [inA, inB], streamInA: [inA], streamInB: [inB] })

    db.close()
    await Dexie.delete(name)
  })
})
