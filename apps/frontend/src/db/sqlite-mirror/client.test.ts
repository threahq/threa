import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import Dexie from "dexie"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { SqliteMirror } from "./client"
import { SQLITE_INCARNATION_STORE, isSqliteMarksStore, type MirrorBroadcast, type SqliteMark } from "./marks"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { isMirroredStore } from "./stores"
import { createBus, inProcessTransport, settle } from "./test-harness"
import { decodeValue } from "./value-codec"

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

const owned: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of owned.splice(0).reverse()) await cleanup()
})

let counter = 0

function openDatabase(name: string): ThreaDatabase {
  const database = new ThreaDatabase(name)
  owned.push(() => database.close())
  return database
}

function memorySqlite(): Database {
  const sqlite: Database = new sqlite3.oo1.DB(":memory:")
  owned.push(() => sqlite.close())
  return sqlite
}

function newBus() {
  const bus = createBus()
  owned.push(() => bus.close())
  return bus
}

/** A tab running a mirror on `database`; it owns SQLite when its claim is first. */
function mirrorTab(
  database: ThreaDatabase,
  bus: ReturnType<typeof createBus>,
  transport: () => MirrorTransport = () => {
    throw new Error("a follower never opens the file")
  }
) {
  const coordination = bus.coordination(database.sqliteWriter.id)
  const mirror = new SqliteMirror({ database, mode: "shadow", coordination, createTransport: transport })
  database.sqliteMirror = mirror
  mirror.start()
  return { mirror, coordination }
}

function setup() {
  counter += 1
  const database = openDatabase(`sqlite_mirror_${counter}_${Date.now()}`)
  const sqlite = memorySqlite()
  const bus = newBus()
  bus.hearAnnouncements(database.name)
  const requests: MirrorRequest["type"][] = []
  let tab: ReturnType<typeof mirrorTab> | null = null
  const start = () => {
    tab = mirrorTab(database, bus, () => inProcessTransport(sqlite, requests))
    return tab
  }
  return { database, sqlite, bus, requests, start, mirror: () => tab!.mirror }
}

function mirrored(sqlite: Database, store: string): unknown[] {
  return sqlite.selectValues(`SELECT v FROM "s_${store}" ORDER BY k`).map((v) => decodeValue(String(v)))
}

/** Stores with a mark past what SQLite holds of its writer: the next owner must not trust them. */
async function behind(database: ThreaDatabase, sqlite: Database): Promise<string[]> {
  const held = new Map(
    sqlite.selectArrays(`SELECT writer, store, seq FROM _mirror_writers`).map(([w, st, s]) => [`${w}/${st}`, Number(s)])
  )
  const stores = (await allMarks(database))
    .filter((m) => m.seq > (held.get(`${m.writer}/${m.store}`) ?? 0))
    .map((m) => m.store)
  return [...new Set(stores)].sort()
}

async function allMarks(database: ThreaDatabase): Promise<SqliteMark[]> {
  const tables = database.tables.filter((table) => isSqliteMarksStore(table.name))
  return (await Promise.all(tables.map((table) => table.toArray() as Promise<SqliteMark[]>))).flat()
}

function begun(requests: MirrorRequest["type"][]): number {
  return requests.filter((type) => type === "backfillBegin").length
}

function mirroredStores(database: ThreaDatabase): string[] {
  return database.tables.map((t) => t.name).filter(isMirroredStore)
}

/** The previous owner is gone without stopping, as a killed tab is; the next one opens the same file. */
async function nextOwner(database: ThreaDatabase, sqlite: Database) {
  const requests: MirrorRequest["type"][] = []
  const bus = newBus()
  const heir = openDatabase(database.name)
  const tab = mirrorTab(heir, bus, () => inProcessTransport(sqlite, requests))
  owned.push(() => tab.mirror.stop())
  await settle()
  return { requests, heir, backfilled: () => begun(requests) }
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

    const actual: Record<string, unknown[]> = {}
    const expected: Record<string, unknown[]> = {}
    for (const store of mirroredStores(database)) {
      actual[store] = mirrored(sqlite, store)
      expected[store] = await database.table(store).toCollection().toArray()
    }
    expect(actual).toEqual(expected)
    expect(expected.syncCursors).toHaveLength(3)
    expect(
      sqlite.selectValues(
        `SELECT name FROM sqlite_master WHERE name IN ('s_e2eDeviceKeys','s_uploadJobs','s_${SQLITE_INCARNATION_STORE}') OR name LIKE 's_sqliteMarks%'`
      )
    ).toEqual([])
    expect(await behind(database, sqlite)).toEqual([])
  })

  it("commits a mark with each write to a mirrored store, and none with a rolled back one", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    start()
    await settle()

    await expect(
      database.transaction("rw", database.syncCursors, database.streams, async () => {
        await database.streams.put({ id: "doomed", workspaceId: "ws" } as never)
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    const afterAbort = await allMarks(database)
    await database.syncCursors.put({ key: "kept", value: "y", updatedAt: 2 } as never)
    await settle()

    expect({
      afterAbort,
      marks: await allMarks(database),
      rows: mirrored(sqlite, "syncCursors"),
      behind: await behind(database, sqlite),
    }).toEqual({
      afterAbort: [],
      marks: [{ store: "syncCursors", writer: database.sqliteWriter.id, seq: expect.any(Number) }],
      rows: [{ key: "kept", value: "y", updatedAt: 2 }],
      behind: [],
    })
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

  it("keeps an unmirrorable entry out and leaves its store behind for the next owner", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    start()
    await settle()

    await database.syncCursors.bulkPut([
      { key: "bad", value: new Blob(["x"]), updatedAt: 1 },
      { key: "good", value: "ok", updatedAt: 2 },
    ] as never)
    await settle()

    expect({ rows: mirrored(sqlite, "syncCursors"), behind: await behind(database, sqlite) }).toEqual({
      rows: [{ key: "good", value: "ok", updatedAt: 2 }],
      behind: ["syncCursors"],
    })
  })

  it("trusts a copy whose marks it holds: the next owner backfills nothing and drops the marks", async () => {
    const { database, sqlite, start } = setup()
    await database.open()
    start()
    await settle()
    await database.syncCursors.put({ key: "k", value: "v", updatedAt: 1 } as never)
    await settle()

    const next = await nextOwner(database, sqlite)

    expect({
      backfilled: next.backfilled(),
      marks: await allMarks(database),
    }).toEqual({ backfilled: 0, marks: [] })
  })

  describe("writes SQLite never received", () => {
    it("re-backfills the stores an owner killed between the IndexedDB commit and the SQLite apply wrote", async () => {
      counter += 1
      const database = openDatabase(`sqlite_mirror_killed_${counter}`)
      const sqlite = memorySqlite()
      await database.open()
      let applies = true
      mirrorTab(database, newBus(), () => {
        const inner = inProcessTransport(sqlite)
        return {
          request: (request) =>
            request.type === "apply" && !applies ? new Promise<MirrorReply>(() => {}) : inner.request(request),
          heardAt: () => 0,
          close: () => {},
        }
      })
      await settle()
      applies = false
      await database.streams.put({ id: "s1", workspaceId: "ws" } as never)
      await settle()

      const next = await nextOwner(database, sqlite)

      expect({ backfilled: next.backfilled(), streams: mirrored(sqlite, database.streams.name) }).toEqual({
        backfilled: 1,
        streams: [{ id: "s1", workspaceId: "ws" }],
      })
    })

    it("applies a write from a handle with no mirror (service worker, mode off) while an owner listens", async () => {
      const { database, sqlite, start } = setup()
      await database.open()
      start()
      await settle()

      await openDatabase(database.name).streams.put({ id: "s1", workspaceId: "ws" } as never)
      await settle()

      expect({ streams: mirrored(sqlite, database.streams.name), behind: await behind(database, sqlite) }).toEqual({
        streams: [{ id: "s1", workspaceId: "ws" }],
        behind: [],
      })
    })

    it("re-backfills only the stores a handle with no mirror wrote while no owner listened", async () => {
      const { database, sqlite, start } = setup()
      await database.open()
      start()
      await settle()
      await database.syncCursors.put({ key: "k", value: "v", updatedAt: 1 } as never)
      await settle()

      const unmirrored = openDatabase(database.name)
      await unmirrored.transaction("rw", unmirrored.streams, unmirrored.events, async () => {
        await unmirrored.streams.put({ id: "s1", workspaceId: "ws" } as never)
        await unmirrored.events.put({ id: "e1", workspaceId: "ws", streamId: "s1" } as never)
      })
      const next = await nextOwner(database, sqlite)

      expect({
        backfilled: next.backfilled(),
        streams: mirrored(sqlite, database.streams.name),
        events: mirrored(sqlite, database.events.name).length,
        behind: await behind(database, sqlite),
      }).toEqual({ backfilled: 2, streams: [{ id: "s1", workspaceId: "ws" }], events: 1, behind: [] })
    })

    it("covers a stopped follower's later writes, through the owner or the next one", async () => {
      const { database, sqlite, bus, start } = setup()
      await database.open()
      start()
      await settle()
      const followerDb = openDatabase(database.name)
      const follower = mirrorTab(followerDb, bus)
      await settle()
      await follower.mirror.stop()
      followerDb.sqliteMirror = null

      await followerDb.streams.put({ id: "heard", workspaceId: "ws" } as never)
      await settle()
      const heardByOwner = mirrored(sqlite, database.streams.name)
      bus.close()
      await followerDb.streams.put({ id: "unheard", workspaceId: "ws" } as never)
      const next = await nextOwner(database, sqlite)

      expect({ heardByOwner, backfilled: next.backfilled(), streams: mirrored(sqlite, database.streams.name) }).toEqual(
        {
          heardByOwner: [{ id: "heard", workspaceId: "ws" }],
          backfilled: 1,
          streams: [
            { id: "heard", workspaceId: "ws" },
            { id: "unheard", workspaceId: "ws" },
          ],
        }
      )
    })

    it("re-backfills everything once the IndexedDB it copied was deleted and recreated", async () => {
      const { database, sqlite, start } = setup()
      await database.open()
      start()
      await settle()
      await database.syncCursors.put({ key: "gone", value: "v", updatedAt: 1 } as never)
      await settle()
      database.close()
      await Dexie.delete(database.name)

      const next = await nextOwner(database, sqlite)

      expect({
        backfilled: next.backfilled(),
        syncCursors: mirrored(sqlite, "syncCursors"),
      }).toEqual({ backfilled: mirroredStores(database).length, syncCursors: [] })
    })
  })

  it("re-sends a batch its owner died holding to the next owner", async () => {
    counter += 1
    const name = `sqlite_mirror_heir_${counter}_${Date.now()}`
    const bus = newBus()
    const deadSqlite = memorySqlite()
    const heirSqlite = memorySqlite()
    const dyingDb = openDatabase(name)
    const dying = mirrorTab(dyingDb, bus, () => {
      const inner = inProcessTransport(deadSqlite)
      return {
        request: (request) => (request.type === "apply" ? new Promise<MirrorReply>(() => {}) : inner.request(request)),
        heardAt: () => 0,
        close: () => {},
      }
    })
    await dyingDb.open()
    await settle()
    const heirDb = openDatabase(name)
    const heir = mirrorTab(heirDb, bus, () => inProcessTransport(heirSqlite))
    const writerDb = openDatabase(name)
    const writer = mirrorTab(writerDb, bus)

    await writerDb.syncCursors.put({ key: "held", value: "by the dead owner", updatedAt: 1 } as never)
    await settle()
    dying.coordination.die()
    await settle()
    bus.hold()
    await writerDb.syncCursors.put({ key: "later", value: "x", updatedAt: 2 } as never)
    bus.release()
    await settle()

    expect({ rows: mirrored(heirSqlite, "syncCursors"), behind: await behind(writerDb, heirSqlite) }).toEqual({
      rows: [
        { key: "held", value: "by the dead owner", updatedAt: 1 },
        { key: "later", value: "x", updatedAt: 2 },
      ],
      behind: [],
    })
    await writer.mirror.stop()
    await heir.mirror.stop()
  })

  it("keeps at most 1000 unacknowledged batches while no owner can open", { timeout: 30_000 }, async () => {
    counter += 1
    const database = openDatabase(`sqlite_mirror_unowned_${counter}`)
    const bus = newBus()
    await database.open()
    const failing = mirrorTab(database, bus, () => ({
      request: async () => {
        throw new Error("no OPFS")
      },
      heardAt: () => 0,
      close: () => {},
    }))
    await settle()
    for (let i = 0; i < 1001; i++) await database.syncCursors.put({ key: `k${i}`, value: "v", updatedAt: i } as never)

    const resent: MirrorBroadcast[] = []
    const listener = bus.coordination()
    listener.onBroadcast((message) => resent.push(message))
    listener.broadcast({ type: "owner" })
    await settle()

    expect(resent.filter((message) => message.type === "batch")).toHaveLength(1000)
    await failing.mirror.stop()
  })

  it("applies a follower's batch as IndexedDB holds it now, whichever commit arrives first", async () => {
    const owner = setup()
    await owner.database.open()
    owner.start()
    await settle()
    const followerDb = openDatabase(owner.database.name)
    const follower = mirrorTab(followerDb, owner.bus)

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

    expect({ rows: mirrored(owner.sqlite, "syncCursors"), behind: await behind(followerDb, owner.sqlite) }).toEqual({
      rows: [{ key: "k", value: "owner", updatedAt: 2 }],
      behind: [],
    })
    await follower.mirror.stop()
    await owner.mirror().stop()
  })

  it("broadcasts writes buffered before the claim resolved to follower", async () => {
    const owner = setup()
    await owner.database.open()
    owner.start()
    await settle()
    const followerDb = openDatabase(owner.database.name)
    let answerClaim: (owner: boolean) => void = () => {}
    const base = owner.bus.coordination(followerDb.sqliteWriter.id)
    const follower = new SqliteMirror({
      database: followerDb,
      mode: "shadow",
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
    await owner.mirror().stop()
  })

  it("stopped while opening, deletes the file and leaves no worker behind", async () => {
    counter += 1
    const database = openDatabase(`sqlite_mirror_stop_${counter}`)
    const requests: MirrorRequest["type"][] = []
    let closed = 0
    const coordination = newBus().coordination()
    const mirror = new SqliteMirror({
      database,
      mode: "shadow",
      coordination,
      createTransport: () => ({
        request: async (request) => {
          requests.push(request.type)
          return { ok: true, ms: 0 }
        },
        heardAt: () => 0,
        close: () => closed++,
      }),
    })
    mirror.start()
    await mirror.stop()

    expect({ requests, closed, released: coordination.resigned() }).toEqual({
      requests: ["open", "destroy"],
      closed: 1,
      released: true,
    })
  })

  it("hands ownership on and keeps broadcasting when its worker dies", async () => {
    counter += 1
    const database = openDatabase(`sqlite_mirror_crash_${counter}`)
    await database.open()
    const bus = newBus()
    let crash: (error: Error) => void = () => {}
    const crashing = mirrorTab(database, bus, () => ({
      request: (request): Promise<MirrorReply> =>
        request.type === "open" ? Promise.resolve({ ok: true, ms: 0 }) : new Promise((_, reject) => (crash = reject)),
      heardAt: () => 0,
      close: () => crash(new Error("closed")),
    }))
    await settle()

    const sqlite = memorySqlite()
    const heirDb = openDatabase(database.name)
    const heir = mirrorTab(heirDb, bus, () => inProcessTransport(sqlite))
    crash(new Error("worker crashed"))
    await settle()
    await database.syncCursors.put({ key: "after", value: "crash", updatedAt: 1 } as never)
    await settle()

    expect({ released: crashing.coordination.resigned(), rows: mirrored(sqlite, "syncCursors") }).toEqual({
      released: true,
      rows: [{ key: "after", value: "crash", updatedAt: 1 }],
    })
    await heir.mirror.stop()
    await crashing.mirror.stop()
  })
})
