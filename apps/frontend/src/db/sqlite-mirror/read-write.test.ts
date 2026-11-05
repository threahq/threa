import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import Dexie, { liveQuery } from "dexie"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import type { SyncCursor, ThreaDatabase } from "../database"
import { SqliteMirror } from "./client"
import { encodeKey } from "./key-codec"
import { encodeValue } from "./value-codec"
import { resumeSqliteMirror } from "./lifecycle"
import { SQLITE_INCARNATION_STORE, sqliteMarksStore } from "./marks"
import { gate, mirroredDatabases, until, type MirroredOptions } from "./mirrored-databases"
import { txOf, type MirrorReply, type MirrorRequest } from "./protocol"
import * as storageDiagnostics from "./storage-diagnostics"
import {
  isSqlitePrimary,
  onStorageUpgrade,
  readRecordedMode,
  recordReadWrite,
  resetStorageUpgradeForTests,
  storageUpgrade,
  type StorageUpgradeProgress,
} from "./storage-mode"
import { createBus, inProcessTransport } from "./test-harness"

let openMirrored: ReturnType<typeof mirroredDatabases>["openMirrored"]
let plainDatabase: ReturnType<typeof mirroredDatabases>["plainDatabase"]
let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
const owned: Array<() => void> = []
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
  ;({ openMirrored, plainDatabase } = mirroredDatabases(sqlite3, owned))
})

/** The app never reloads a tab on its own; every test asserts on this. */
let reloadSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  reloadSpy = vi.fn()
  const spy = vi.spyOn(window, "location", "get").mockReturnValue({ reload: reloadSpy } as unknown as Location)
  owned.push(() => spy.mockRestore())
})

afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  resetStorageUpgradeForTests()
  armPerfCapture(NO_CAPTURE)
})

const cursor = (key: string, value: string, updatedAt = 1): SyncCursor => ({ key, cursor: value, updatedAt })

const never = new Promise<never>(() => {})

/** A tab of a database SQLite already holds, open. */
async function readWriteSession(options: MirroredOptions = {}) {
  const session = openMirrored(options)
  await session.database.open()
  return session
}

function freshSqlite(): Database {
  const sqlite: Database = new sqlite3.oo1.DB(":memory:")
  owned.push(() => sqlite.close())
  return sqlite
}

/** A tab booting as the app does: SQLite where it holds the database or this boot imports it, else IndexedDB. */
function bootTab(
  name: string,
  sqlite: Database,
  bus: ReturnType<typeof createBus>,
  intercept?: (request: MirrorRequest, next: () => Promise<MirrorReply>) => Promise<MirrorReply>
) {
  const database = plainDatabase(name)
  const lock = bus.modeLock()
  const coordination = bus.coordination(undefined, lock)
  const log: MirrorRequest["type"][] = []
  const createTransport = () => {
    const inner = inProcessTransport(sqlite, log)
    return intercept
      ? { ...inner, request: (request: MirrorRequest) => intercept(request, () => inner.request(request)) }
      : inner
  }
  resumeSqliteMirror(database, {
    lock,
    createMirror: (target, primary) => new SqliteMirror({ database: target, primary, coordination, createTransport }),
  })
  const close = () => {
    database.close()
    coordination.die()
  }
  return { database, coordination, log, close }
}

/** A tab running on IndexedDB, or one of a build that predates this one: it holds the shared side until it closes. */
async function tabOnIndexedDb(bus: ReturnType<typeof createBus>) {
  const lock = bus.modeLock()
  await lock.shared()
  owned.push(() => lock.close())
  return lock
}

/** What IndexedDB itself holds of `stores`, read without Dexie or SQLite. */
async function inIndexedDb(name: string, stores: string[]): Promise<Record<string, unknown[]>> {
  const request = indexedDB.open(name)
  const idb = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const tx = idb.transaction(stores)
    const reads = stores.map((store) => tx.objectStore(store).getAll())
    await new Promise((resolve) => (tx.oncomplete = resolve))
    return Object.fromEntries(stores.map((store, index) => [store, reads[index].result]))
  } finally {
    idb.close()
  }
}

async function seeded(rows: SyncCursor[]): Promise<string> {
  const name = `seeded_${Math.random().toString(36).slice(2)}`
  const database = plainDatabase(name)
  await database.syncCursors.bulkPut(rows)
  await database.uploadJobs.put({ attachmentId: "upload_1" } as never)
  await database.table(SQLITE_INCARNATION_STORE).put({ id: "incarnation_1" })
  await database.table(sqliteMarksStore("syncCursors")).put({ writer: "tab_old", seq: 1 })
  database.close()
  return name
}

async function cursorsIn(database: ThreaDatabase) {
  return database.syncCursors.orderBy("key").toArray()
}

function silenceErrors() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {})
  owned.push(() => spy.mockRestore())
}

/** Refuses the first readwrite transaction on the mode database, as a full disk would. */
function refuseModeWrite() {
  const transaction = IDBDatabase.prototype.transaction
  let refusals = 1
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    if (this.name === "threa-sqlite-mode" && args[1] === "readwrite" && refusals-- > 0) {
      throw new DOMException("The quota was exceeded", "QuotaExceededError")
    }
    return transaction.apply(this, args)
  })
  owned.push(() => spy.mockRestore())
}

function spyNativeTransactions() {
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction")
  owned.push(() => spy.mockRestore())
  return () => spy.mock.calls.length
}

/** What a database answers for IndexedDB's transaction semantics; IndexedDB itself is the reference. */
async function transactionSemantics(database: ThreaDatabase) {
  const table = database.syncCursors
  await table.bulkPut([cursor("a", "1"), cursor("b", "1", 2), cursor("c", "1", 9)])

  const aborted = await database
    .transaction("rw", table, async () => {
      await table.put(cursor("a", "aborted"))
      await table.delete("b")
      throw new Error("boom")
    })
    .catch((error: Error) => error.message)

  const bulk = await table
    .bulkAdd([cursor("a", "dup"), cursor("d", "1"), cursor("d", "dup-in-batch"), cursor("e", "1")])
    .catch((error: { name: string; failures: Array<{ name: string }> }) => ({
      name: error.name,
      failures: error.failures.map((failure) => failure.name),
    }))

  const caughtInside = await database.transaction("rw", table, async () => {
    const failure = await table.add(cursor("a", "dup")).catch((error: Error) => error.name)
    await table.put(cursor("f", "1"))
    return failure
  })

  const uncaughtAdd = await database
    .transaction("rw", table, async () => {
      await table.put(cursor("g", "1"))
      await table.add(cursor("a", "dup"))
    })
    .catch((error: Error) => error.name)

  const ownWrites = await database.transaction("rw", table, async () => {
    await table.put(cursor("h", "1", 5))
    await table.delete("c")
    return {
      got: await table.get("h"),
      count: await table.count(),
      below: await table.where("updatedAt").below(3).primaryKeys(),
    }
  })

  const increment = () =>
    database.transaction("rw", table, async () => {
      const current = await table.get("counter")
      await table.get("a")
      await table.put(cursor("counter", String(Number(current?.cursor ?? 0) + 1)))
    })
  await Promise.all([increment(), increment()])
  const counter = (await table.get("counter"))?.cursor

  const [readBeforeWrite] = await Promise.all([
    database.transaction("r", table, () => table.get("a")),
    database.transaction("rw", table, () => table.put(cursor("a", "later"))),
  ])

  const deletedRange = await table.where("key").between("d", "f", true, true).delete()
  const afterRange = await table.toCollection().primaryKeys()
  await table.clear()

  return {
    aborted,
    bulk,
    caughtInside,
    uncaughtAdd,
    ownWrites,
    counter,
    readBeforeWrite: readBeforeWrite?.cursor,
    deletedRange,
    afterRange,
    afterClear: await table.count(),
  }
}

describe("SQLite storage", () => {
  it("answers IndexedDB's transaction semantics exactly as IndexedDB does", async () => {
    const reference = await transactionSemantics(plainDatabase(`reference_${Date.now()}`))
    const { database, mirror } = await readWriteSession()
    expect(mirror.readWrite).toBe(true)
    expect(await transactionSemantics(database)).toEqual(reference)
    expect({ counter: reference.counter, readBeforeWrite: reference.readBeforeWrite }).toEqual({
      counter: "2",
      readBeforeWrite: "1",
    })
  })

  it("serves every request on mirrored stores without opening an IndexedDB transaction", async () => {
    const { database } = await readWriteSession()
    const nativeTransactions = spyNativeTransactions()
    await database.syncCursors.bulkPut([cursor("a", "1"), cursor("b", "2")])
    await database.transaction("rw", database.syncCursors, database.drafts, async () => {
      await database.syncCursors.update("a", { cursor: "3" })
      await database.drafts.toArray()
    })
    expect({
      cursors: await cursorsIn(database),
      nativeTransactions: nativeTransactions(),
    }).toEqual({
      cursors: [cursor("a", "3"), cursor("b", "2")],
      nativeTransactions: 0,
    })
  })

  it("notifies live queries of commits", async () => {
    const { database } = await readWriteSession()
    const seen: Array<string | undefined> = []
    const subscription = liveQuery(() => database.syncCursors.get("a")).subscribe((row) => seen.push(row?.cursor))
    owned.push(() => subscription.unsubscribe())
    await until(() => seen.length === 1, "the first emission")
    await database.syncCursors.put(cursor("a", "1"))
    await until(() => seen.at(-1) === "1", "the live query to see the write")
    expect(seen).toEqual([undefined, "1"])
  })

  it("refuses a transaction that mixes SQLite stores with IndexedDB-only ones", async () => {
    const { database } = await readWriteSession()
    await expect(database.transaction("rw", database.syncCursors, database.uploadJobs, async () => {})).rejects.toThrow(
      /mixes stores SQLite serves with IndexedDB-only ones/
    )
    await database.uploadJobs.toArray()
  })

  it("stops starting workers for a database once it closes", async () => {
    let failing = false
    let opens = 0
    const { database } = await readWriteSession({
      intercept: async (request, next) => {
        if (request.type === "open") opens++
        if (failing) throw new Error("worker died")
        return next()
      },
      deadlines: { recoverMs: 1 },
    })
    silenceErrors()
    failing = true
    void database.syncCursors.get("b").catch(() => {})
    await until(() => opens >= 3, "workers to keep failing")
    database.close()
    const opensAtClose = opens
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(opens - opensAtClose).toBeLessThanOrEqual(1)
  })

  for (const lost of ["get", "commit"] as const) {
    it(`keeps IndexedDB-only stores when the owner closes during a ready handler's ${lost}, which runs again or waits for a worker`, async () => {
      silenceErrors()
      let holding = false
      let held = false
      let claim: number | undefined
      const owner = await readWriteSession({
        intercept: (request, next) => {
          if (request.type === "write" && request.write.store === "cacheOwnership") claim = request.tx
          const ownership = request.type === "get" ? request.store === "cacheOwnership" : txOf(request) === claim
          if (!holding || request.type !== lost || !ownership) return next()
          held = true
          return never
        },
      })
      await owner.database.uploadJobs.put({ attachmentId: "upload_1" } as never)
      holding = true
      const second = openMirrored({
        name: owner.name,
        sqlite: owner.sqlite,
        bus: owner.bus,
        owner: "workos_1",
        deadlines: { recoverMs: 1 },
      })
      const opened = second.database.open().then(
        () => "opened",
        () => "failed"
      )
      await until(() => held, `the ownership ${lost} to reach the owner`)
      owner.coordination.die()
      owner.database.close()
      // The commit's outcome is unknown and the held transaction keeps the next worker from opening: the open waits.
      const settled = new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 500))
      expect({
        opened: await Promise.race([opened, settled]),
        reconnecting: second.database.storageReconnecting,
        uploads: await plainDatabase(owner.name).uploadJobs.toArray(),
      }).toEqual({
        opened: lost === "get" ? "opened" : "waiting",
        reconnecting: lost === "commit",
        uploads: [{ attachmentId: "upload_1" }],
      })
      second.database.close()
    })
  }

  it("claims ownership again on a fresh worker after its worker fails, running what it had in flight there", async () => {
    silenceErrors()
    let kill = false
    const { database, mirror, log } = await readWriteSession({
      intercept: (request, next) => {
        if (!kill || request.type !== "begin") return next()
        kill = false
        return Promise.reject(new Error("worker died"))
      },
      deadlines: { recoverMs: 1 },
    })
    kill = true
    await database.syncCursors.put(cursor("in flight", "1"))
    await database.syncCursors.put(cursor("after", "1"))
    expect({
      readWrite: mirror.readWrite,
      cursors: await cursorsIn(database),
      opens: log.filter((type) => type === "open").length,
    }).toEqual({ readWrite: true, cursors: [cursor("after", "1"), cursor("in flight", "1")], opens: 2 })
  })

  it("keeps claiming a worker while workers keep failing, serving once one starts", async () => {
    silenceErrors()
    let dead = false
    let opens = 0
    const { database } = await readWriteSession({
      intercept: (request, next) => {
        if (request.type === "open") opens++
        return dead ? Promise.reject(new Error("worker died")) : next()
      },
      deadlines: { recoverMs: 1 },
    })
    const reconnecting: boolean[] = []
    database.onStorageReconnecting(() => reconnecting.push(database.storageReconnecting))
    dead = true
    const read = database.syncCursors.get("a")
    await until(() => opens >= 5, "repeated claims")
    const whileDead = { reconnecting: [...reconnecting], reloads: reloadSpy.mock.calls.length }
    dead = false
    expect({ whileDead, read: await read, reconnecting }).toEqual({
      whileDead: { reconnecting: [true], reloads: 0 },
      read: undefined,
      reconnecting: [true, false],
    })
  })

  describe("booting", () => {
    it("imports IndexedDB into SQLite behind the upgrade lock, then serves from SQLite without a reload", async () => {
      const name = await seeded([cursor("a", "1"), cursor("b", "1"), cursor("c", "1")])
      const seen: Array<StorageUpgradeProgress | null> = []
      owned.push(onStorageUpgrade(() => seen.push(storageUpgrade())))
      const tab = bootTab(name, freshSqlite(), createBus())
      await tab.database.open()
      const served = { readWrite: tab.database.sqliteMirror?.readWrite, cursors: await cursorsIn(tab.database) }
      const cleared = [sqliteMarksStore("syncCursors"), SQLITE_INCARNATION_STORE]
      await vi.waitFor(async () => expect((await inIndexedDb(name, ["syncCursors"])).syncCursors).toEqual([]))
      expect({
        served,
        progress: [seen[0], seen.at(-2), seen.at(-1)],
        primary: isSqlitePrimary(name),
        recorded: await readRecordedMode(name),
        indexedDb: await inIndexedDb(name, ["syncCursors", "uploadJobs", ...cleared]),
        reloads: reloadSpy.mock.calls.length,
      }).toEqual({
        served: { readWrite: true, cursors: [cursor("a", "1"), cursor("b", "1"), cursor("c", "1")] },
        progress: [{ copied: 0, total: null }, { copied: 3, total: 3 }, null],
        primary: true,
        recorded: "read-write",
        indexedDb: {
          syncCursors: [],
          uploadJobs: [{ attachmentId: "upload_1" }],
          [cleared[0]]: [],
          [cleared[1]]: [],
        },
        reloads: 0,
      })
    })

    it("holds a tab booting during the import until it ends, then boots it onto SQLite", async () => {
      const name = await seeded([cursor("a", "1")])
      const sqlite = freshSqlite()
      const bus = createBus()
      const copying = gate()
      const importing = bootTab(name, sqlite, bus, async (request, next) => {
        if (request.type === "backfillBegin") await copying.opened
        return next()
      })
      void importing.database.open()
      await until(() => storageUpgrade() !== null, "the import to lock the app")
      const later = bootTab(name, sqlite, bus)
      let opened = false
      const opening = later.database.open().then(() => (opened = true))
      await new Promise((resolve) => setTimeout(resolve, 50))
      const whileCopying = opened
      copying.open()
      await opening
      await later.database.syncCursors.put(cursor("later", "1"))
      expect({
        whileCopying,
        readWrite: [importing.database.sqliteMirror?.readWrite, later.database.sqliteMirror?.readWrite],
        cursors: await cursorsIn(importing.database),
      }).toEqual({ whileCopying: false, readWrite: [true, true], cursors: [cursor("a", "1"), cursor("later", "1")] })
    })

    it("runs a session on IndexedDB while another tab holds the database, importing on the first boot after it closed", async () => {
      const name = await seeded([cursor("a", "1")])
      const sqlite = freshSqlite()
      const bus = createBus()
      const other = await tabOnIndexedDb(bus)
      const blocked = bootTab(name, sqlite, bus)
      await blocked.database.open()
      await blocked.database.syncCursors.put(cursor("blocked", "1"))
      const whileBlocked = {
        mirror: blocked.database.sqliteMirror,
        primary: isSqlitePrimary(name),
        indexedDb: (await inIndexedDb(name, ["syncCursors"])).syncCursors,
      }
      blocked.close()
      other.close()
      const next = bootTab(name, sqlite, bus)
      await next.database.open()
      expect({
        whileBlocked,
        readWrite: next.database.sqliteMirror?.readWrite,
        cursors: await cursorsIn(next.database),
      }).toEqual({
        whileBlocked: { mirror: null, primary: false, indexedDb: [cursor("a", "1"), cursor("blocked", "1")] },
        readWrite: true,
        cursors: [cursor("a", "1"), cursor("blocked", "1")],
      })
    })

    it("boots a database SQLite holds onto SQLite at once while another tab holds it, adopting a recorded read-write", async () => {
      const name = await seeded([cursor("a", "1")])
      const sqlite = freshSqlite()
      const bus = createBus()
      await bootTab(name, sqlite, bus).database.open()
      await tabOnIndexedDb(bus)
      const marked = bootTab(name, sqlite, bus)
      await marked.database.open()
      for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
      const recorded = bootTab(name, sqlite, bus)
      await recorded.database.open()
      expect({
        readWrite: [marked.database.sqliteMirror?.readWrite, recorded.database.sqliteMirror?.readWrite],
        primary: isSqlitePrimary(name),
        imports: [...marked.log, ...recorded.log].filter((type) => type === "backfillBegin"),
      }).toEqual({ readWrite: [true, true], primary: true, imports: [] })
    })

    it.each(["the import", "recording it"] as const)(
      "stays on IndexedDB this session when %s fails, importing again on the next boot",
      async (failing) => {
        silenceErrors()
        const failures = vi.spyOn(storageDiagnostics, "reportStorageFailure")
        const boots = vi.spyOn(storageDiagnostics, "reportStorageBoot")
        owned.push(
          () => failures.mockRestore(),
          () => boots.mockRestore()
        )
        if (failing === "recording it") refuseModeWrite()
        const name = await seeded([cursor("a", "1")])
        const sqlite = freshSqlite()
        const bus = createBus()
        const failed = bootTab(name, sqlite, bus, (request, next) =>
          failing === "the import" && request.type === "backfillChunk"
            ? Promise.reject(new Error("disk I/O error"))
            : next()
        )
        await failed.database.open()
        // A tab booting meanwhile must not run on SQLite while this one writes IndexedDB.
        const meanwhile = bootTab(name, sqlite, bus)
        await meanwhile.database.open()
        await failed.database.syncCursors.put(cursor("b", "1"))
        const afterFailure = {
          readWrite: [failed.database.sqliteMirror?.readWrite, meanwhile.database.sqliteMirror?.readWrite ?? false],
          primary: isSqlitePrimary(name),
          recorded: await readRecordedMode(name),
          locked: storageUpgrade() !== null,
          indexedDb: (await inIndexedDb(name, ["syncCursors"])).syncCursors,
          kinds: failures.mock.calls.map(([kind]) => kind),
          boots: boots.mock.calls.map(([role]) => role),
        }
        failed.close()
        meanwhile.close()
        const next = bootTab(name, sqlite, bus)
        await next.database.open()
        expect({
          afterFailure,
          readWrite: next.database.sqliteMirror?.readWrite,
          cursors: await cursorsIn(next.database),
        }).toEqual({
          afterFailure: {
            readWrite: [false, false],
            primary: false,
            recorded: "off",
            locked: false,
            indexedDb: [cursor("a", "1"), cursor("b", "1")],
            kinds: ["import_failed"],
            boots: [null, null],
          },
          readWrite: true,
          cursors: [cursor("a", "1"), cursor("b", "1")],
        })
      }
    )

    it("reports a boot on IndexedDB when SQLite storage's worker cannot open", async () => {
      silenceErrors()
      const boots = vi.spyOn(storageDiagnostics, "reportStorageBoot")
      owned.push(() => boots.mockRestore())
      const tab = bootTab(await seeded([cursor("a", "1")]), freshSqlite(), createBus(), (request, next) =>
        request.type === "open" ? Promise.reject(new Error("no OPFS")) : next()
      )
      await tab.database.open()
      expect({
        readWrite: tab.database.sqliteMirror?.readWrite,
        boots: boots.mock.calls.map(([role]) => role),
      }).toEqual({ readWrite: false, boots: [null] })
    })

    it("imports a database an earlier build marked as maybe read-write but never recorded so", async () => {
      const name = await seeded([cursor("a", "1"), cursor("newer-on-idb", "1")])
      localStorage.setItem(`threa:sqliteMayBeReadWrite:${name}`, "1")
      const tab = bootTab(name, freshSqlite(), createBus())
      await tab.database.open()
      expect({ recorded: await readRecordedMode(name), cursors: await cursorsIn(tab.database) }).toEqual({
        recorded: "read-write",
        cursors: [cursor("a", "1"), cursor("newer-on-idb", "1")],
      })
    })

    it("upgrades IndexedDB's rows to the current schema before importing them", async () => {
      const name = `installed_older_${Date.now()}`
      const persona = { id: "persona_1", workspaceId: "ws_1", slug: "p", _cachedAt: 1 }
      const older = new Dexie(name)
      older.version(54).stores({ personas: "id, workspaceId, slug, _cachedAt" })
      await older.table("personas").put(persona)
      older.close()
      const tab = bootTab(name, freshSqlite(), createBus())
      await tab.database.open()
      expect({
        readWrite: tab.database.sqliteMirror?.readWrite,
        personas: await tab.database.personas.toArray(),
      }).toEqual({
        readWrite: true,
        personas: [persona],
      })
    })

    it("runs on IndexedDB this session when it cannot tell whether SQLite holds the database", async () => {
      silenceErrors()
      const failures = vi.spyOn(storageDiagnostics, "reportStorageFailure")
      owned.push(() => failures.mockRestore())
      const open = indexedDB.open.bind(indexedDB)
      const spy = vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
        if (name === "threa-sqlite-mode") throw new DOMException("The disk is unreadable", "UnknownError")
        return open(name, version)
      })
      owned.push(() => spy.mockRestore())
      const tab = bootTab(await seeded([cursor("a", "1")]), freshSqlite(), createBus())
      await tab.database.open()
      expect({
        mirror: tab.database.sqliteMirror,
        cursors: await cursorsIn(tab.database),
        kinds: failures.mock.calls.map(([kind]) => kind),
      }).toEqual({ mirror: null, cursors: [cursor("a", "1")], kinds: ["mode_unreadable"] })
    })

    it("runs on SQLite without importing when it cannot read the mode of a database an earlier build marked as maybe read-write", async () => {
      silenceErrors()
      const failures = vi.spyOn(storageDiagnostics, "reportStorageFailure")
      owned.push(() => failures.mockRestore())
      const name = await seeded([cursor("a", "1")])
      const sqlite = freshSqlite()
      const bus = createBus()
      const first = bootTab(name, sqlite, bus)
      await first.database.open()
      for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
      localStorage.setItem(`threa:sqliteMayBeReadWrite:${name}`, "1")
      const open = indexedDB.open.bind(indexedDB)
      const spy = vi.spyOn(indexedDB, "open").mockImplementation((database, version) => {
        if (database === "threa-sqlite-mode") throw new DOMException("The disk is unreadable", "UnknownError")
        return open(database, version)
      })
      owned.push(() => spy.mockRestore())
      const unreadable = bootTab(name, sqlite, bus)
      await unreadable.database.open()
      expect({
        readWrite: unreadable.database.sqliteMirror?.readWrite,
        cursors: await cursorsIn(unreadable.database),
        imports: unreadable.log.filter((type) => type === "backfillBegin"),
        kinds: failures.mock.calls.map(([kind]) => kind),
      }).toEqual({ readWrite: true, cursors: [cursor("a", "1")], imports: [], kinds: ["mode_unreadable"] })
    })

    it("fails to open a database SQLite holds when its mirror cannot start, or the browser cannot run one", async () => {
      silenceErrors()
      const name = `unstartable_${Date.now()}`
      await recordReadWrite(name)
      const unstartable = plainDatabase(name)
      resumeSqliteMirror(unstartable, {
        lock: createBus().modeLock(),
        createMirror: () => {
          throw new Error("BroadcastChannel is unavailable")
        },
      })
      const withoutSqlite = plainDatabase(name)
      resumeSqliteMirror(withoutSqlite, null)
      const fresh = plainDatabase(`never_imported_${Date.now()}`)
      resumeSqliteMirror(fresh, null)
      const outcome = (database: ThreaDatabase) =>
        database.open().then(
          () => "opened",
          (error: Error) => error.message
        )
      const refused = `SQLite holds the primary copy of ${name}, but cannot run in this tab`
      expect(await Promise.all([outcome(unstartable), outcome(withoutSqlite), outcome(fresh)])).toEqual([
        refused,
        refused,
        "opened",
      ])
    })
  })

  describe("in a second tab", () => {
    async function follower(owner: Awaited<ReturnType<typeof readWriteSession>>, options: MirroredOptions = {}) {
      const tab = openMirrored({
        ...options,
        name: owner.name,
        sqlite: owner.sqlite,
        bus: owner.bus,
      })
      await tab.database.open()
      return tab
    }

    it("runs every transaction on the owner's worker with IndexedDB's semantics", async () => {
      const reference = await transactionSemantics(plainDatabase(`reference_${Date.now()}`))
      const owner = await readWriteSession()
      const second = await follower(owner)
      const seen: Array<string | undefined> = []
      const subscription = liveQuery(() => owner.database.syncCursors.get("watched")).subscribe((row) =>
        seen.push(row?.cursor)
      )
      owned.push(() => subscription.unsubscribe())
      const nativeTransactions = spyNativeTransactions()
      expect(second.mirror.readWrite).toBe(true)
      expect(await transactionSemantics(second.database)).toEqual(reference)
      await second.database.syncCursors.put(cursor("watched", "from the second tab"))
      await until(() => seen.at(-1) === "from the second tab", "the owner's live query to see the write")
      expect({
        ownerSees: await owner.database.syncCursors.get("watched"),
        nativeTransactions: nativeTransactions(),
      }).toEqual({ ownerSees: cursor("watched", "from the second tab"), nativeTransactions: 0 })
      expect(second.log).toEqual([])
    })

    it("rolls back a transaction its tab left open, so the owner's worker is not held", async () => {
      const release = gate()
      const owner = await readWriteSession({
        intercept: async (request, next) => {
          if (request.type === "write" && request.write.store === "syncCursors") await release.opened
          return next()
        },
      })
      const second = await follower(owner)
      vi.spyOn(console, "error").mockImplementation(() => {})
      void second.database.syncCursors.put(cursor("abandoned", "1")).catch(() => {})
      await until(() => second.mirror.readWrite, "the second tab to serve")
      await new Promise((resolve) => setTimeout(resolve, 20))
      second.coordination.die()
      release.open()
      await owner.database.drafts.clear()
      await owner.database.syncCursors.put(cursor("owner", "1"))
      expect(await cursorsIn(owner.database)).toEqual([cursor("owner", "1")])
    })

    it("runs what was in flight when the owner closes again on the tab that takes over", async () => {
      let holdWrites = true
      const owner = await readWriteSession({
        intercept: (request, next) => (request.type === "write" && holdWrites ? never : next()),
      })
      holdWrites = false
      await owner.database.syncCursors.put(cursor("before", "1"))
      holdWrites = true
      const second = await follower(owner)
      const inFlight = second.database.syncCursors.put(cursor("in flight", "1"))
      await until(() => owner.log.includes("begin") && owner.log.lastIndexOf("begin") > 0, "the transaction to begin")
      await new Promise((resolve) => setTimeout(resolve, 20))
      owner.coordination.die()
      owner.database.close()
      // The owner's worker dies with its tab, and SQLite rolls back what it left open.
      owner.sqlite.exec("ROLLBACK")
      await inFlight
      await second.database.syncCursors.put(cursor("after", "1"))
      expect({ readWrite: second.mirror.readWrite, cursors: await cursorsIn(second.database) }).toEqual({
        readWrite: true,
        cursors: [cursor("after", "1"), cursor("before", "1"), cursor("in flight", "1")],
      })
    })

    it("fails a transaction the owner closed during once running it again reads what another tab wrote meanwhile", async () => {
      let holdWrites = false
      let held = false
      const owner = await readWriteSession({
        intercept: (request, next) => {
          if (request.type !== "write" || !holdWrites) return next()
          held = true
          return never
        },
      })
      await owner.database.syncCursors.put(cursor("k", "0"))
      const heir = await follower(owner)
      const reader = await follower(owner)
      holdWrites = true
      const readThenWrite = reader.database.transaction("rw", reader.database.syncCursors, async () => {
        const read = await reader.database.syncCursors.get("k")
        await reader.database.syncCursors.put(cursor("k", `${read?.cursor}+reader`))
      })
      await until(() => held, "the reader's write to reach the owner")
      const heirWrite = heir.database.syncCursors.put(cursor("k", "heir"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      owner.coordination.die()
      owner.database.close()
      owner.sqlite.exec("ROLLBACK")
      const failure = await readThenWrite.then(
        () => null,
        (error: Error) => error.name
      )
      await heirWrite
      expect({ failure, k: await heir.database.syncCursors.get("k") }).toEqual({
        failure: "OwnerLostError",
        k: cursor("k", "heir"),
      })
    })

    for (const heirWrites of ["k", "other"] as const) {
      const replay = heirWrites === "k" ? "fails, never committing," : "commits"
      it(`should wait for every replayed answer before the commit asked between owners, so it ${replay} when another tab wrote ${heirWrites}`, async () => {
        let holdWrites = false
        let held = false
        const owner = await readWriteSession({
          intercept: (request, next) => {
            if (request.type !== "write" || !holdWrites) return next()
            held = true
            return never
          },
        })
        await owner.database.syncCursors.put(cursor("k", "0"))
        const heir = await follower(owner)
        const reader = await follower(owner)
        const tx = reader.mirror.beginTransaction("readwrite", ["syncCursors"])
        await reader.mirror.read({ type: "get", tx, store: "syncCursors", key: encodeKey("k") })
        await reader.mirror.write(tx, {
          store: "syncCursors",
          op: "put",
          entries: [{ key: encodeKey("reader"), value: encodeValue(cursor("reader", "1")) }],
        })
        holdWrites = true
        const heirWrite = heir.database.syncCursors.put(cursor(heirWrites, "heir"))
        await until(() => held, "the heir's write to reach the owner")
        owner.coordination.die()
        owner.database.close()
        owner.sqlite.exec("ROLLBACK")
        await Promise.resolve()
        const commit = await reader.mirror.commitTransaction(tx).then(
          () => "committed",
          (error: Error) => error.name
        )
        await heirWrite
        expect({
          commit,
          cursors: await cursorsIn(heir.database),
        }).toEqual(
          heirWrites === "k"
            ? { commit: "OwnerLostError", cursors: [cursor("k", "heir")] }
            : { commit: "committed", cursors: [cursor("k", "0"), cursor("other", "heir"), cursor("reader", "1")] }
        )
      })
    }

    it("runs a commit the closed owner never applied again ahead of the transactions created after it", async () => {
      let loseCommits = false
      let reached = false
      const owner = await readWriteSession({
        intercept: async (request, next) => {
          if (request.type !== "commit" || !loseCommits) return next()
          reached = true
          return never
        },
      })
      const second = await follower(owner)
      loseCommits = true
      const first = second.database.syncCursors.put(cursor("k", "first"))
      await until(() => reached, "the first commit to reach the worker")
      const later = second.database.transaction("rw", second.database.syncCursors, async () => {
        const read = await second.database.syncCursors.get("k")
        await second.database.syncCursors.put(cursor("later", read?.cursor ?? "none"))
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      owner.coordination.die()
      owner.database.close()
      owner.sqlite.exec("ROLLBACK")
      await Promise.all([first, later])
      expect(await cursorsIn(second.database)).toEqual([cursor("k", "first"), cursor("later", "first")])
    })

    it("serves nothing from the tab taking over until its worker opened", async () => {
      const owner = await readWriteSession()
      const opening = gate()
      const requests: MirrorRequest["type"][] = []
      const second = await follower(owner, {
        intercept: async (request, next) => {
          requests.push(request.type)
          if (request.type === "open") await opening.opened
          return next()
        },
      })
      owner.coordination.die()
      owner.database.close()
      await until(() => requests.includes("open"), "the new owner to open its worker")
      const put = second.database.syncCursors.put(cursor("after", "1"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const begunBeforeOpen = requests.includes("begin")
      opening.open()
      await put
      expect({
        begunBeforeOpen,
        readWrite: second.mirror.readWrite,
        cursors: await cursorsIn(second.database),
      }).toEqual({
        begunBeforeOpen: false,
        readWrite: true,
        cursors: [cursor("after", "1")],
      })
    })

    for (const applied of [true, false]) {
      const landed = applied ? "landed" : "never ran"
      it(`completes a commit that ${landed} on the owner, closed before answering, exactly once on the tab taking over`, async () => {
        let loseReply = false
        let reached = false
        const owner = await readWriteSession({
          intercept: async (request, next) => {
            if (request.type !== "commit" || !loseReply) return next()
            reached = true
            if (applied) await next()
            return never
          },
        })
        const second = await follower(owner)
        loseReply = true
        const put = second.database.syncCursors.add(cursor("once", "1"))
        await until(() => reached, "the commit to reach the worker")
        owner.coordination.die()
        owner.database.close()
        if (!applied) owner.sqlite.exec("ROLLBACK")
        const failure = await put.then(
          () => null,
          (error: Error & { inner?: Error }) => error.inner?.name ?? error.name
        )
        expect({ failure, cursors: await cursorsIn(second.database) }).toEqual({
          failure: null,
          cursors: [cursor("once", "1")],
        })
      })
    }

    it("fails a commit as outcome-unknown once the owner, still open, answers no tab in time", async () => {
      let holdCommits = false
      const owner = await readWriteSession({
        intercept: (request, next) => (holdCommits && request.type === "commit" ? never : next()),
      })
      const second = await follower(owner, { deadlines: { workerMs: 50 } })
      holdCommits = true
      const failure = await second.database.syncCursors.put(cursor("maybe", "1")).then(
        () => null,
        (error: Error & { inner?: Error }) => error.inner?.name
      )
      expect(failure).toBe("OutcomeUnknownError")
    })

    it("fails a request rather than following an owner of another build, once none answered in time", async () => {
      const capture = new PerfCapture()
      armPerfCapture(capture)
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      owned.push(() => error.mockRestore())
      const bus = createBus()
      const otherBuild = bus.coordination()
      otherBuild.claim(() => {})
      otherBuild.onBroadcast((message) => {
        if (message.type === "hello") otherBuild.broadcast({ type: "decided", tab: otherBuild.tabId, protocol: 0 })
      })
      const tab = openMirrored({ bus, deadlines: { decidedMs: 30 } })
      await tab.database.open()
      await expect(tab.database.syncCursors.get("a")).rejects.toThrow(/SQLite storage has no owner/)
      expect(capture.snapshot().filter((sample) => sample.name === "sqlite.decisionOverdue").length).toBe(1)
    })
  })
})
