import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { sharedMessageSlotKey, type StreamEvent } from "@threahq/types"
import Dexie from "dexie"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ThreaDatabase, accountDbName, db } from "@/db/database"
import {
  PREFETCH_INBOX_MAX_AGE_MS,
  PREFETCH_INBOX_MAX_ENTRIES,
  appendPrefetch,
  deletePrefetches,
  queuedPrefetches,
  type PrefetchPayload,
} from "@/db/prefetch-inbox"
import { mirroredDatabases } from "@/db/sqlite-mirror/mirrored-databases"
import { createBus } from "@/db/sqlite-mirror/test-harness"
import { browserPrefetchStore, storePrefetch } from "./sw-bootstrap-prefetch"
import { applyPrefetch, drainPrefetchInbox, drainPrefetchesOnOpen, watchPrefetchInbox } from "./sw-prefetch-inbox"

const WS = "ws_1"

async function hasPrefetches(dbName: string): Promise<boolean> {
  return (await queuedPrefetches(dbName)).length > 0
}
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

/** Holds the inbox's store in a busy readwrite transaction for `ms`, as a stalled IndexedDB engine would. */
async function stallInbox(ms: number): Promise<void> {
  const inbox = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("threa-sw-inbox", 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const tx = inbox.transaction("entries", "readwrite")
  const entries = tx.objectStore("entries")
  const until = performance.now() + ms
  const spin = () => {
    if (performance.now() < until) entries.get(0).onsuccess = spin
  }
  spin()
  return new Promise<void>((resolve) => {
    tx.oncomplete = () => {
      inbox.close()
      resolve()
    }
  })
}

const owned: Array<() => void> = []
afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
})

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
    const queued = await queuedPrefetches(db.name)
    const failing = vi.spyOn(Dexie.prototype, "transaction").mockRejectedValueOnce(new Error("disk full"))

    await expect(drainPrefetchInbox(db)).rejects.toThrow("disk full")
    failing.mockRestore()
    expect({ queued: await queuedPrefetches(db.name), events: (await streamState(db, streamId)).events }).toEqual({
      queued,
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

    const queued = await queuedPrefetches(db.name)
    await deletePrefetches(queued.map((entry) => entry.key))
    expect(queued.map((entry) => entry.payload)).toEqual([bootstrap(streamId, []), second])
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

  it("opens without waiting out a stalled inbox, and drops what the late read finds unapplied", async () => {
    const database = new ThreaDatabase(`inbox_stalled_${++streams}`)
    owned.push(() => database.close())
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(database.name, payload)
    const stalled = stallInbox(1_000)
    drainPrefetchesOnOpen(database)

    const startedAt = performance.now()
    const firstRead = await streamState(database, streamId)
    const waitedMs = performance.now() - startedAt
    await stalled
    await vi.waitFor(async () => expect(await hasPrefetches(database.name)).toBe(false))

    expect({
      firstRead: firstRead.events,
      openedDuringStall: waitedMs < 1_000,
      afterStall: (await streamState(database, streamId)).events,
    }).toEqual({ firstRead: [], openedDuringStall: true, afterStall: [] })
  })

  it("lets an open in progress drain first when the page becomes visible, instead of holding it", async () => {
    const queues = new Map<string, Promise<unknown>>()
    const locks = {
      request: (name: string, callback: () => Promise<unknown>) => {
        const run = (queues.get(name) ?? Promise.resolve()).then(callback, callback)
        queues.set(
          name,
          run.catch(() => undefined)
        )
        return run
      },
    }
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true })
    owned.push(() => Reflect.deleteProperty(navigator, "locks"))
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    owned.push(() => visible.mockRestore())
    const database = new ThreaDatabase(`inbox_visible_${++streams}`)
    owned.push(() => database.close())
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(database.name, payload)
    drainPrefetchesOnOpen(database)
    owned.push(watchPrefetchInbox(database))

    const opening = database.open()
    document.dispatchEvent(new Event("visibilitychange"))
    await opening
    await vi.waitFor(async () => expect(await hasPrefetches(database.name)).toBe(false))
    expect((await streamState(database, streamId)).events.map((e) => e.id)).toEqual([
      `${streamId}_1`,
      `${streamId}_2`,
      `${streamId}_3`,
    ])
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
    expect({ landed, other: (await queuedPrefetches(elsewhere)).map((entry) => entry.payload) }).toEqual({
      landed: streamIds.map((_, index) => index >= 2),
      other: [other],
    })
  })
})

describe("service-worker prefetch under SQLite storage", () => {
  let openMirrored: ReturnType<typeof mirroredDatabases>["openMirrored"]
  beforeAll(async () => {
    ;({ openMirrored } = mirroredDatabases(await sqlite3InitModule(), owned))
  })

  it("never writes the account's IndexedDB, and reaches SQLite once the app drains the inbox", async () => {
    const workosUserId = `user_rw_${++streams}`
    const name = accountDbName(workosUserId)
    const tab = openMirrored({ name, bus: createBus() })
    await tab.database.open()
    expect(tab.mirror.readWrite).toBe(true)

    const browser = browserPrefetchStore()
    const writeNative = vi.fn(browser.writeNative)
    const announce = vi.fn(async () => {})
    const streamId = nextStream()
    const [payload] = twoPrefetches(streamId)
    const opens = vi.spyOn(indexedDB, "open")
    await storePrefetch(workosUserId, payload, { ...browser, sqliteCapable: true, writeNative, announce })
    const opened = opens.mock.calls.map(([opening]) => opening)
    opens.mockRestore()

    expect({
      opened,
      native: writeNative.mock.calls.length,
      announced: announce.mock.calls,
      queued: (await queuedPrefetches(name)).map((entry) => entry.payload),
      sqlite: (await streamState(tab.database, streamId)).events,
    }).toEqual({
      opened: ["threa-sw-inbox"],
      native: 0,
      announced: [[name]],
      queued: [payload],
      sqlite: [],
    })

    await drainPrefetchInbox(tab.database)

    expect({
      serving: tab.mirror.readWrite,
      events: (await streamState(tab.database, streamId)).events.map((e) => e.id),
      queued: await hasPrefetches(name),
    }).toEqual({ serving: true, events: [`${streamId}_1`, `${streamId}_2`], queued: false })
  })

  it("lands what was queued before a boot in SQLite ahead of the app's first transaction", async () => {
    const name = `inbox_rw_open_${++streams}`
    const streamId = nextStream()
    for (const payload of twoPrefetches(streamId)) await appendPrefetch(name, payload)
    const tab = openMirrored({ name })
    drainPrefetchesOnOpen(tab.database)

    const firstRead = await streamState(tab.database, streamId)

    expect({
      serving: tab.mirror.readWrite,
      events: firstRead.events.map((e) => e.id),
      queued: await hasPrefetches(name),
    }).toEqual({ serving: true, events: [`${streamId}_1`, `${streamId}_2`, `${streamId}_3`], queued: false })
  })
})
