import { afterEach, describe, it, expect, vi } from "vitest"

afterEach(() => {
  vi.restoreAllMocks()
})
import Dexie from "dexie"
import { ThreaDatabase } from "./database"

describe("events upgraded from v46", () => {
  it("should keep v46 rows reachable through the workspace-led indexes when opened at the current version", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`

    // Seed at the v46 events shape so the rows predate every events index added
    // since, the dotted payload.messageId key path included.
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

    // The pre-existing row is reachable through the workspace-led message index
    // with its payload intact.
    const matched = await db.events.where("[workspaceId+payload.messageId]").equals(["ws_1", "msg_1"]).toArray()
    expect(matched.map((row) => ({ id: row.id, payload: row.payload }))).toEqual([
      { id: "event_1", payload: { messageId: "msg_1", contentMarkdown: "hello" } },
    ])

    // Sparse: the row carrying no payload.messageId is not in the index.
    const all = await db.events
      .where("[workspaceId+payload.messageId]")
      .between(["ws_1", Dexie.minKey], ["ws_1", Dexie.maxKey])
      .count()
    expect(all).toBe(1)

    // The stream/type and _status indexes answer on the upgraded handle too, so a
    // silently dropped index goes red instead of invisible.
    const byStreamAndType = await db.events
      .where("[workspaceId+streamId+eventType]")
      .equals(["ws_1", "stream_1", "message_created"])
      .count()
    const byStatus = await db.events.where("_status").equals("pending").count()
    expect({ byStreamAndType, byStatus }).toEqual({ byStreamAndType: 1, byStatus: 0 })

    db.close()
    await Dexie.delete(name)
  })
})

describe("v48 composer target + conversation messageIds index", () => {
  it("serves the fork lookup from the multiEntry index and keeps the conversations store's other indexes", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`

    // Seed at the v47 conversations shape — before the multiEntry index — so the
    // rows exist before the index does.
    const legacy = new Dexie(name)
    legacy.version(47).stores({
      conversations: "id, workspaceId, [workspaceId+_lastActivityMs], _cachedAt",
    })
    await legacy.open()
    await legacy.table("conversations").bulkPut([
      {
        id: "conv_1",
        workspaceId: "ws_1",
        conversation: { id: "conv_1", streamId: "stream_1", messageIds: ["msg_a", "msg_b"] },
        _lastActivityMs: 10,
        _cachedAt: 1000,
      },
      {
        id: "conv_2",
        workspaceId: "ws_1",
        conversation: { id: "conv_2", streamId: "stream_1", messageIds: ["msg_c"] },
        _lastActivityMs: 20,
        _cachedAt: 1000,
      },
    ])
    legacy.close()

    const db = new ThreaDatabase(name)
    await db.open()

    // The index was built over the pre-existing rows: a fork message resolves to
    // its hosting conversation without scanning the workspace, and a
    // conversation holding two of the queried ids comes back once.
    const hosts = await db.conversations
      .where("conversation.messageIds")
      .anyOf(["msg_a", "msg_b", "msg_c"])
      .distinct()
      .toArray()
    expect(hosts.map((row) => row.id).sort()).toEqual(["conv_1", "conv_2"])

    // The version bump ADDS an index; the store's existing ones must survive.
    const byActivity = await db.conversations.where("[workspaceId+_lastActivityMs]").equals(["ws_1", 20]).count()
    expect(byActivity).toBe(1)

    // The new device-local target store opens and round-trips.
    await db.composerTarget.put({ host: "stream:stream_1", workspaceId: "ws_1", scope: "board:reply:conv_1" })
    expect(await db.composerTarget.get("stream:stream_1")).toEqual({
      host: "stream:stream_1",
      workspaceId: "ws_1",
      scope: "board:reply:conv_1",
    })

    db.close()
    await Dexie.delete(name)
  })
})

describe("one-way-door recovery", () => {
  it("a versionchange from another tab closes the connection and reloads", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const db = new ThreaDatabase(name)
    await db.open()
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ reload } as unknown as Location)

    db.on("versionchange").fire({ newVersion: 480 } as IDBVersionChangeEvent)

    expect({ open: db.isOpen(), reloaded: reload.mock.calls.length }).toEqual({ open: false, reloaded: 1 })
    await Dexie.delete(name)
  })

  it("a quota-aborted upgrade deletes the cache and reopens once, then rethrows", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const db = new ThreaDatabase(name)
    const quota = Object.assign(new Error("upgrade aborted"), { name: "AbortError" })
    const wrapped = Object.assign(new Error("wrapped"), { name: "OpenFailedError", inner: quota })
    const open = vi
      .spyOn(Dexie.prototype, "open")
      .mockImplementation(() => Promise.reject(wrapped) as unknown as ReturnType<Dexie["open"]>)
    const del = vi.spyOn(Dexie, "delete").mockResolvedValue(undefined)
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(db.open()).rejects.toBe(wrapped)

    expect({ deleted: del.mock.calls.map(([n]) => n), superOpens: open.mock.calls.length }).toEqual({
      deleted: [name],
      superOpens: 2,
    })
  })

  it("an unrelated open failure rethrows without deleting the cache", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const db = new ThreaDatabase(name)
    const other = Object.assign(new Error("nope"), { name: "InvalidStateError" })
    vi.spyOn(Dexie.prototype, "open").mockImplementation(
      () => Promise.reject(other) as unknown as ReturnType<Dexie["open"]>
    )
    const del = vi.spyOn(Dexie, "delete").mockResolvedValue(undefined)

    await expect(db.open()).rejects.toBe(other)

    expect(del).not.toHaveBeenCalled()
  })
})
