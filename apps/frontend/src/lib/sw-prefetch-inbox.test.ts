import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { sharedMessageSlotKey, type StreamEvent } from "@threahq/types"
import Dexie from "dexie"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ThreaDatabase, accountDbName, db } from "@/db/database"
import {
  PREFETCH_INBOX_MAX_AGE_MS,
  PREFETCH_INBOX_MAX_ENTRIES,
  appendPrefetch,
  deletePrefetch,
  hasPrefetches,
  oldestPrefetch,
  type PrefetchPayload,
} from "@/db/prefetch-inbox"
import { SqliteMirror } from "@/db/sqlite-mirror/client"
import { resumeSqliteMirror } from "@/db/sqlite-mirror/lifecycle"
import { mirroredDatabases } from "@/db/sqlite-mirror/mirrored-databases"
import { readRecordedMode } from "@/db/sqlite-mirror/storage-mode"
import { createBus, inProcessTransport } from "@/db/sqlite-mirror/test-harness"
import { browserPrefetchStore, storePrefetch } from "./sw-bootstrap-prefetch"
import { applyPrefetch, drainPrefetchInbox, drainPrefetchesOnOpen } from "./sw-prefetch-inbox"

const WS = "ws_1"
const FETCHED_AT = Date.now()
let streams = 0

const missingSlot = (messageId: string) => ({ type: "sharedMessage", state: "missing", messageId }) as const

function event(id: string, streamId: string, sequence: number, content: string): StreamEvent {
  return {
    id,
    streamId,
    sequence: String(sequence),
    eventType: "message_created",
    payload: { messageId: `msg_${id}`, contentMarkdown: content },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date(sequence * 1000).toISOString(),
  } as StreamEvent
}

function bootstrap(streamId: string, events: StreamEvent[], fetchedAt = FETCHED_AT): PrefetchPayload {
  return {
    kind: "streamBootstrap",
    workspaceId: WS,
    streamId,
    fetchedAt,
    bootstrap: {
      stream: { id: streamId },
      events,
      slots: { [sharedMessageSlotKey("msg_boot")]: missingSlot("msg_boot") },
    },
  }
}

function around(streamId: string, events: StreamEvent[], fetchedAt = FETCHED_AT): PrefetchPayload {
  return {
    kind: "eventsAround",
    workspaceId: WS,
    streamId,
    fetchedAt,
    around: { events, slots: { [sharedMessageSlotKey("msg_around")]: missingSlot("msg_around") } },
  }
}

/** A bootstrap, then a later events-around that edits one of its events. */
function twoPrefetches(streamId: string): PrefetchPayload[] {
  return [
    bootstrap(streamId, [event(`${streamId}_1`, streamId, 1, "first"), event(`${streamId}_2`, streamId, 2, "draft")]),
    around(streamId, [event(`${streamId}_2`, streamId, 2, "edited"), event(`${streamId}_3`, streamId, 3, "third")]),
  ]
}

async function streamState(database: ThreaDatabase, streamId: string) {
  const key: [string, string] = [WS, streamId]
  return {
    events: await database.events.where("[workspaceId+streamId]").equals(key).sortBy("_sequenceNum"),
    slots: await database.slots.where("[workspaceId+streamId]").equals(key).sortBy("slotKey"),
    stream: await database.streams.get(key),
  }
}

async function forgetStream(database: ThreaDatabase, streamId: string) {
  const key: [string, string] = [WS, streamId]
  await database.transaction("rw", [database.events, database.slots, database.streams], async () => {
    await database.events.where("[workspaceId+streamId]").equals(key).delete()
    await database.slots.where("[workspaceId+streamId]").equals(key).delete()
    await database.streams.delete(key)
  })
}

const nextStream = () => `stream_inbox_${++streams}`

describe("drainPrefetchInbox", () => {
  it("applies prefetches oldest first through the app's database and empties the inbox", async () => {
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(db.name, payload)

    await drainPrefetchInbox(db)

    const { events, slots, stream } = await streamState(db, streamId)
    expect({
      events: events.map((e) => [e.id, (e.payload as { contentMarkdown: string }).contentMarkdown, e._cachedAt]),
      slots: slots.map((s) => s.slotKey),
      preview: stream?.lastMessagePreview?.content,
      queued: await hasPrefetches(db.name),
    }).toEqual({
      events: [
        [`${streamId}_1`, "first", FETCHED_AT],
        [`${streamId}_2`, "edited", FETCHED_AT],
        [`${streamId}_3`, "third", FETCHED_AT],
      ],
      slots: [sharedMessageSlotKey("msg_around"), sharedMessageSlotKey("msg_boot")].sort(),
      preview: "draft",
      queued: false,
    })
  })

  it("lands the same rows when a drain died after a write committed but before its entry left", async () => {
    const streamId = nextStream()
    const payloads = twoPrefetches(streamId)
    for (const payload of payloads) await appendPrefetch(db.name, payload)
    await drainPrefetchInbox(db)
    const once = await streamState(db, streamId)
    await forgetStream(db, streamId)

    for (const payload of payloads) await appendPrefetch(db.name, payload)
    await applyPrefetch(db, payloads[0])
    await drainPrefetchInbox(db)

    expect(await streamState(db, streamId)).toEqual(once)
  })

  it("keeps every entry when a write fails, and applies them on the next drain", async () => {
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(db.name, payload)
    const first = await oldestPrefetch(db.name)
    const failing = vi.spyOn(Dexie.prototype, "transaction").mockRejectedValueOnce(new Error("disk full"))

    await expect(drainPrefetchInbox(db)).rejects.toThrow("disk full")
    failing.mockRestore()
    expect({ oldest: await oldestPrefetch(db.name), events: (await streamState(db, streamId)).events }).toEqual({
      oldest: first,
      events: [],
    })

    await drainPrefetchInbox(db)
    expect((await streamState(db, streamId)).events.map((e) => e.id)).toEqual([
      `${streamId}_1`,
      `${streamId}_2`,
      `${streamId}_3`,
    ])
  })

  it("drops prefetches past their age unapplied", async () => {
    const streamId = nextStream()
    await appendPrefetch(db.name, around(streamId, [event(`${streamId}_1`, streamId, 1, "old")]))

    await drainPrefetchInbox(db, () => FETCHED_AT + PREFETCH_INBOX_MAX_AGE_MS + 1)

    expect({ queued: await hasPrefetches(db.name), events: (await streamState(db, streamId)).events }).toEqual({
      queued: false,
      events: [],
    })
  })

  it("keeps only the latest prefetch of a stream and kind", async () => {
    const streamId = nextStream()
    const [first, second] = [1, 2].map((n) => around(streamId, [event(`${streamId}_${n}`, streamId, n, "x")]))
    await appendPrefetch(db.name, first)
    await appendPrefetch(db.name, bootstrap(streamId, []))
    await appendPrefetch(db.name, second)

    const queued: PrefetchPayload[] = []
    for (let entry = await oldestPrefetch(db.name); entry; entry = await oldestPrefetch(db.name)) {
      queued.push(entry.payload)
      await deletePrefetch(entry.key)
    }
    expect(queued).toEqual([bootstrap(streamId, []), second])
  })

  it("lands what was queued before the database opened ahead of the app's first transaction", async () => {
    const database = new ThreaDatabase(`inbox_open_${++streams}`)
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(database.name, payload)
    drainPrefetchesOnOpen(database)

    const firstRead = await streamState(database, streamId)
    database.close()

    expect({ events: firstRead.events.map((e) => e.id), queued: await hasPrefetches(database.name) }).toEqual({
      events: [`${streamId}_1`, `${streamId}_2`, `${streamId}_3`],
      queued: false,
    })
  })

  it("drops the oldest prefetches of a database past its cap, leaving other databases alone", async () => {
    const elsewhere = `inbox_other_${streams}`
    const other = around(nextStream(), [])
    await appendPrefetch(elsewhere, other)
    const streamIds = Array.from({ length: PREFETCH_INBOX_MAX_ENTRIES + 2 }, nextStream)
    for (const streamId of streamIds) {
      await appendPrefetch(db.name, around(streamId, [event(`${streamId}_1`, streamId, 1, "x")]))
    }

    await drainPrefetchInbox(db)

    const landed = await Promise.all(streamIds.map(async (id) => (await streamState(db, id)).events.length > 0))
    expect({ landed, other: (await oldestPrefetch(elsewhere))?.payload }).toEqual({
      landed: streamIds.map((_, index) => index >= 2),
      other,
    })
  })
})

describe("service-worker prefetch under read-write storage", () => {
  let openMirrored: ReturnType<typeof mirroredDatabases>["openMirrored"]
  let copiedSession: ReturnType<typeof mirroredDatabases>["copiedSession"]
  let plainDatabase: ReturnType<typeof mirroredDatabases>["plainDatabase"]
  const owned: Array<() => void> = []
  beforeAll(async () => {
    ;({ openMirrored, copiedSession, plainDatabase } = mirroredDatabases(await sqlite3InitModule(), owned))
  })
  afterEach(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  })

  /** A second boot of a database whose first boot copied every store into SQLite and recorded read-write. */
  async function readWriteTab(name: string, bus = createBus()) {
    const copied = await copiedSession({ name, mode: "read-write", entering: true })
    return openMirrored({ ...copied, bus, mode: "read-write", entering: true })
  }
  afterEach(() => {
    for (const cleanup of owned.splice(0)) cleanup()
  })

  it("never writes the account's IndexedDB, and reaches SQLite once the app drains the inbox", async () => {
    const workosUserId = `user_rw_${++streams}`
    const name = accountDbName(workosUserId)
    const bus = createBus()
    const tab = await readWriteTab(name, bus)
    await tab.database.open()
    expect({ serving: tab.mirror.readWrite, recorded: await readRecordedMode(name) }).toEqual({
      serving: true,
      recorded: "read-write",
    })

    const browser = browserPrefetchStore()
    const writeNative = vi.fn(browser.writeNative)
    const announce = vi.fn(async () => {})
    const streamId = nextStream()
    const [payload] = twoPrefetches(streamId)
    const opens = vi.spyOn(indexedDB, "open")
    await storePrefetch(workosUserId, payload, { ...browser, modeLock: () => bus.modeLock(), writeNative, announce })
    const opened = opens.mock.calls.map(([opening]) => opening)
    opens.mockRestore()

    expect({
      opened,
      native: writeNative.mock.calls.length,
      announced: announce.mock.calls,
      queued: (await oldestPrefetch(name))?.payload,
      sqlite: (await streamState(tab.database, streamId)).events,
    }).toEqual({
      opened: ["threa-sqlite-mode", "threa-sw-inbox"],
      native: 0,
      announced: [[name]],
      queued: payload,
      sqlite: [],
    })

    await drainPrefetchInbox(tab.database)

    expect({
      serving: tab.mirror.readWrite,
      events: (await streamState(tab.database, streamId)).events.map((e) => e.id),
      queued: await hasPrefetches(name),
    }).toEqual({ serving: true, events: [`${streamId}_1`, `${streamId}_2`], queued: false })
  })

  it("lands what was queued before a read-write boot in SQLite ahead of the app's first transaction", async () => {
    const name = `inbox_rw_open_${++streams}`
    const streamId = nextStream()
    const copied = await copiedSession({ name, mode: "read-write", entering: true })
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(name, payload)
    const tab = openMirrored({ ...copied, mode: "read-write", entering: true })
    drainPrefetchesOnOpen(tab.database)

    const firstRead = await streamState(tab.database, streamId)

    expect({
      serving: tab.mirror.readWrite,
      events: firstRead.events.map((e) => e.id),
      queued: await hasPrefetches(name),
    }).toEqual({ serving: true, events: [`${streamId}_1`, `${streamId}_2`, `${streamId}_3`], queued: false })
  })

  it("discards what is queued when a boot leaves read-write, before SQLite's backlog lands", async () => {
    const name = `inbox_rw_leave_${++streams}`
    const established = await readWriteTab(name)
    await established.database.open()
    established.database.close()
    established.coordination.die()
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(name, payload)

    const bus = createBus()
    const database = plainDatabase(name)
    const lock = bus.modeLock()
    const coordination = bus.coordination(database.sqliteWriter.id, lock)
    const createTransport = () => inProcessTransport(established.sqlite)
    resumeSqliteMirror(database, {
      lock,
      switchWaitMs: 20,
      createTransport,
      createMirror: (target, mode, entering) =>
        new SqliteMirror({ database: target, mode, entering, coordination, createTransport }),
    })
    drainPrefetchesOnOpen(database)

    expect({
      events: (await streamState(database, streamId)).events,
      recorded: await readRecordedMode(name),
      queued: await hasPrefetches(name),
    }).toEqual({ events: [], recorded: "off", queued: false })
  })
})
