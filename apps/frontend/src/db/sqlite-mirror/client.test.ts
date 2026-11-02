import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { SqliteMirror, type MirrorBroadcast, type MirrorCoordination } from "./client"
import { createMirrorHandler } from "./handler"
import { decodeValue } from "./value-codec"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { SQLITE_UNMIRRORED_STORES } from "./stores"

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

const owned: Array<() => void> = []
afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqliteDirty:")) localStorage.removeItem(key)
})

let counter = 0

/** Tabs on one in-memory channel; the first to claim owns until it resigns. */
function createBus() {
  const listeners = new Set<(message: MirrorBroadcast) => void>()
  const queue: Array<(owner: boolean) => void> = []
  let holder: ((owner: boolean) => void) | null = null
  let held: Array<() => void> | null = null
  const handOver = () => {
    holder = queue.shift() ?? null
    holder?.(true)
  }
  return {
    /** Delays every broadcast until `release`, as a busy channel would. */
    hold() {
      held = []
    },
    release() {
      const deliveries = held ?? []
      held = null
      for (const deliver of deliveries) deliver()
    },
    coordination(): MirrorCoordination & { resigned: () => boolean } {
      let mine: ((owner: boolean) => void) | null = null
      let resigned = false
      const own = new Set<(message: MirrorBroadcast) => void>()
      const resign = () => {
        resigned = true
        if (holder === mine) handOver()
        else if (mine) queue.splice(queue.indexOf(mine), 1)
      }
      return {
        resigned: () => resigned,
        claim(onChange) {
          mine = onChange
          if (!holder) {
            holder = onChange
            onChange(true)
          } else {
            onChange(false)
            queue.push(onChange)
          }
        },
        resign,
        close() {
          resign()
          for (const listener of own) listeners.delete(listener)
        },
        broadcast(message) {
          for (const listener of listeners) {
            if (own.has(listener)) continue
            const deliver = () => listener(message)
            if (held) held.push(deliver)
            else queueMicrotask(deliver)
          }
        },
        onBroadcast(listener) {
          own.add(listener)
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    },
  }
}

function inProcessTransport(sqlite: Database, log: MirrorRequest["type"][] = []): MirrorTransport {
  const handler = createMirrorHandler(async () => ({ db: sqlite, close: () => {}, destroy: async () => {} }))
  return {
    request: (request) => {
      log.push(request.type)
      return handler.handle(request)
    },
    close: () => {},
  }
}

function openDatabase(name: string): ThreaDatabase {
  const database = new ThreaDatabase(name)
  owned.push(() => database.close())
  return database
}

function setup() {
  counter += 1
  const database = openDatabase(`sqlite_mirror_${counter}_${Date.now()}`)
  const sqlite: Database = new sqlite3.oo1.DB(":memory:")
  owned.push(() => sqlite.close())
  const bus = createBus()
  const mirror = new SqliteMirror({
    database,
    coordination: bus.coordination(),
    createTransport: () => inProcessTransport(sqlite),
  })
  const start = () => {
    database.sqliteMirror = mirror
    mirror.start()
  }
  return { database, sqlite, mirror, bus, start }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

function mirrored(sqlite: Database, store: string): unknown[] {
  return sqlite.selectValues(`SELECT v FROM "s_${store}" ORDER BY k`).map((v) => decodeValue(String(v)))
}

function dirtyKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith("threa:sqliteDirty:"))
}

describe("SqliteMirror", () => {
  it("mirrors committed writes and backfills pre-existing rows", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    await database.syncCursors.bulkPut([
      { key: "old_a", value: "1", updatedAt: 1 },
      { key: "old_b", value: "2", updatedAt: 2 },
    ] as never)
    await database.pendingMessages.put({ clientId: "c1", streamId: "s1", createdAt: 1 } as never)
    start()
    await settle()

    await database.syncCursors.put({ key: "new", value: "3", updatedAt: 3 } as never)
    await database.syncCursors.delete("old_a")
    await database.syncCursors.where("key").equals("old_b").modify({ updatedAt: 99 })
    await database.pendingMessages.put({ clientId: "c2", streamId: "s1", createdAt: 2 } as never)
    await database.transaction("rw", database.syncCursors, database.pendingMessages, async () => {
      await database.syncCursors.put({ key: "tx", value: "4", updatedAt: 4 } as never)
      await database.pendingMessages.clear()
    })
    await settle()

    const stores = database.tables.map((t) => t.name).filter((name) => !SQLITE_UNMIRRORED_STORES.has(name))
    const actual: Record<string, unknown[]> = {}
    const expected: Record<string, unknown[]> = {}
    for (const store of stores) {
      actual[store] = mirrored(sqlite, store)
      expected[store] = await database.table(store).toCollection().toArray()
    }
    expect(actual).toEqual(expected)
    expect(expected.syncCursors).toHaveLength(3)
    expect(
      sqlite.selectValues(`SELECT name FROM sqlite_master WHERE name IN ('s_e2eDeviceKeys','s_uploadJobs')`)
    ).toEqual([])
    expect(dirtyKeys()).toEqual([])
  })

  it("mirrors nothing from an aborted transaction", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    start()
    await settle()

    await expect(
      database.transaction("rw", database.syncCursors, async () => {
        await database.syncCursors.put({ key: "doomed", value: "x", updatedAt: 1 } as never)
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    await database.syncCursors.put({ key: "kept", value: "y", updatedAt: 2 } as never)
    await settle()

    expect(mirrored(sqlite, "syncCursors")).toEqual([{ key: "kept", value: "y", updatedAt: 2 }])
  })

  it("copies a value as it was put, not as the caller later changed it", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    start()
    await settle()

    const row = { key: "k", value: "at put", updatedAt: 1 }
    await database.transaction("rw", database.syncCursors, async () => {
      const written = database.syncCursors.put(row as never)
      row.value = "changed after put"
      await written
    })
    await settle()

    expect(mirrored(sqlite, "syncCursors")).toEqual([{ key: "k", value: "at put", updatedAt: 1 }])
  })

  it("keeps an unmirrorable entry out and journals the loss", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    start()
    await settle()

    await database.syncCursors.bulkPut([
      { key: "bad", value: new Blob(["x"]), updatedAt: 1 },
      { key: "good", value: "ok", updatedAt: 2 },
    ] as never)
    await settle()

    expect({ rows: mirrored(sqlite, "syncCursors"), dirty: dirtyKeys().length }).toEqual({
      rows: [{ key: "good", value: "ok", updatedAt: 2 }],
      dirty: 1,
    })
  })

  it("re-backfills every store when a dirty key was left behind", async () => {
    const { database, sqlite, mirror, start } = setup()
    await database.open()
    start()
    await settle()
    await mirror.stop()

    const requests: MirrorRequest["type"][] = []
    localStorage.setItem(`threa:sqliteDirty:${database.name}:dead-tab`, "1")
    const second = new SqliteMirror({
      database,
      coordination: createBus().coordination(),
      createTransport: () => inProcessTransport(sqlite, requests),
    })
    second.start()
    await settle()

    const stores = database.tables.map((t) => t.name).filter((name) => !SQLITE_UNMIRRORED_STORES.has(name))
    expect({
      begun: requests.filter((type) => type === "backfillBegin").length,
      dirty: dirtyKeys(),
    }).toEqual({ begun: stores.length, dirty: [] })
    await second.stop()
  })

  it("applies a follower's batch as IndexedDB holds it now, whichever commit arrives first", async () => {
    const owner = setup()
    await owner.database.open()
    owner.start()
    await settle()
    const followerDb = openDatabase(owner.database.name)
    const follower = new SqliteMirror({
      database: followerDb,
      coordination: owner.bus.coordination(),
      createTransport: () => {
        throw new Error("a follower never opens the file")
      },
    })
    followerDb.sqliteMirror = follower
    follower.start()

    owner.bus.hold()
    await followerDb.syncCursors.put({ key: "k", value: "follower", updatedAt: 1 } as never)
    await owner.database.syncCursors.put({ key: "k", value: "owner", updatedAt: 2 } as never)
    await settle()
    owner.bus.release()
    await followerDb.syncCursors.bulkPut([
      { key: "a", value: "1", updatedAt: 1 },
      { key: "b", value: "2", updatedAt: 1 },
    ] as never)
    await followerDb.syncCursors.where("key").between("a", "b", true, true).delete()
    await settle()

    expect({ rows: mirrored(owner.sqlite, "syncCursors"), dirty: dirtyKeys() }).toEqual({
      rows: [{ key: "k", value: "owner", updatedAt: 2 }],
      dirty: [],
    })
    await follower.stop()
    await owner.mirror.stop()
  })

  it("broadcasts writes buffered before the claim resolved to follower", async () => {
    const owner = setup()
    await owner.database.open()
    owner.start()
    await settle()
    const followerDb = openDatabase(owner.database.name)
    let answerClaim: (owner: boolean) => void = () => {}
    const base = owner.bus.coordination()
    const follower = new SqliteMirror({
      database: followerDb,
      coordination: { ...base, claim: (onChange) => (answerClaim = onChange) },
      createTransport: () => {
        throw new Error("a follower never opens the file")
      },
    })
    followerDb.sqliteMirror = follower
    follower.start()

    await followerDb.syncCursors.put({ key: "early", value: "x", updatedAt: 1 } as never)
    answerClaim(false)
    await settle()

    expect(mirrored(owner.sqlite, "syncCursors")).toEqual([{ key: "early", value: "x", updatedAt: 1 }])
    await owner.mirror.stop()
  })

  it("stopped while opening, deletes the file and leaves no worker behind", async () => {
    counter += 1
    const database = openDatabase(`sqlite_mirror_stop_${counter}`)
    const requests: MirrorRequest["type"][] = []
    let closed = 0
    const coordination = createBus().coordination()
    const mirror = new SqliteMirror({
      database,
      coordination,
      createTransport: () => ({
        request: async (request) => {
          requests.push(request.type)
          return { ok: true, ms: 0 }
        },
        close: () => closed++,
      }),
    })
    mirror.start()
    await mirror.stop()

    expect({ requests, closed, released: coordination.resigned() }).toEqual({
      requests: ["destroy"],
      closed: 1,
      released: true,
    })
  })

  it("hands ownership on and keeps broadcasting when its worker dies", async () => {
    counter += 1
    const database = openDatabase(`sqlite_mirror_crash_${counter}`)
    await database.open()
    const bus = createBus()
    let crash: (error: Error) => void = () => {}
    const coordination = bus.coordination()
    const crashing = new SqliteMirror({
      database,
      coordination,
      createTransport: () => ({
        request: (request): Promise<MirrorReply> =>
          request.type === "open" ? Promise.resolve({ ok: true, ms: 0 }) : new Promise((_, reject) => (crash = reject)),
        close: () => crash(new Error("closed")),
      }),
    })
    database.sqliteMirror = crashing
    crashing.start()
    await settle()

    const sqlite: Database = new sqlite3.oo1.DB(":memory:")
    owned.push(() => sqlite.close())
    const heirDb = openDatabase(database.name)
    const heir = new SqliteMirror({
      database: heirDb,
      coordination: bus.coordination(),
      createTransport: () => inProcessTransport(sqlite),
    })
    heir.start()
    crash(new Error("worker crashed"))
    await settle()
    await database.syncCursors.put({ key: "after", value: "crash", updatedAt: 1 } as never)
    await settle()

    expect({ released: coordination.resigned(), rows: mirrored(sqlite, "syncCursors") }).toEqual({
      released: true,
      rows: [{ key: "after", value: "crash", updatedAt: 1 }],
    })
    await heir.stop()
    await crashing.stop()
  })
})
