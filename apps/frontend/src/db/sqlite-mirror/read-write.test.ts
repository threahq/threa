import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import Dexie, { liveQuery } from "dexie"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import type { SyncCursor, ThreaDatabase } from "../database"
import { SqliteMirror } from "./client"
import { adoptDeliveredMode, resumeSqliteMirror } from "./lifecycle"
import { WS, gate, mirroredDatabases, mirroredStores, until, type MirroredOptions } from "./mirrored-databases"
import { txOf, type MirrorReply, type MirrorRequest } from "./protocol"
import { readRecordedMode, recordMode } from "./storage-mode"
import { createBus, inProcessTransport } from "./test-harness"

let openMirrored: ReturnType<typeof mirroredDatabases>["openMirrored"]
let plainDatabase: ReturnType<typeof mirroredDatabases>["plainDatabase"]
let copiedSession: ReturnType<typeof mirroredDatabases>["copiedSession"]
let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
const owned: Array<() => void> = []
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
  ;({ openMirrored, plainDatabase, copiedSession } = mirroredDatabases(sqlite3, owned))
})

afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  sessionStorage.clear()
  armPerfCapture(NO_CAPTURE)
})

const cursor = (key: string, value: string, updatedAt = 1): SyncCursor => ({ key, cursor: value, updatedAt })

const never = new Promise<never>(() => {})

function backlogRows(sqlite: Database): number {
  return Number(sqlite.selectValue("SELECT COUNT(*) FROM _idb_backlog"))
}

/** A second boot of a database whose first, read-write boot copied every store into SQLite; it records read-write. */
async function readWriteSession(options: MirroredOptions = {}) {
  const { name, sqlite } = await copiedSession({ mode: "read-write", entering: true })
  const second = openMirrored({ ...options, name, sqlite, mode: "read-write", entering: true })
  await second.database.open()
  return second
}

/** A tab booting as the app does, under the mode recorded for its database and the flag's in localStorage. */
function bootTab(
  name: string,
  sqlite: Database,
  bus: ReturnType<typeof createBus>,
  intercept?: (request: MirrorRequest, next: () => Promise<MirrorReply>) => Promise<MirrorReply>,
  reloadEveryTab: () => void = () => {}
) {
  const database = plainDatabase(name)
  const lock = bus.modeLock()
  const coordination = bus.coordination(database.sqliteWriter.id, lock)
  const log: MirrorRequest["type"][] = []
  const createTransport = () => {
    const inner = inProcessTransport(sqlite, log)
    return intercept
      ? { ...inner, request: (request: MirrorRequest) => intercept(request, () => inner.request(request)) }
      : inner
  }
  resumeSqliteMirror(database, {
    lock,
    createTransport,
    reloadEveryTab,
    createMirror: (target, mode, entering) =>
      new SqliteMirror({ database: target, mode, entering, coordination, createTransport, reloadEveryTab }),
  })
  return { database, coordination, log }
}

async function cursorsIn(database: ThreaDatabase) {
  return database.syncCursors.orderBy("key").toArray()
}

function silenceErrors() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {})
  owned.push(() => spy.mockRestore())
}

/** IndexedDB refuses `refusals` of the transactions `refuses` matches, as it does when over quota; `seen` sees each. */
function refuseTransactions(
  refuses: (idb: IDBDatabase, mode: IDBTransactionMode | undefined) => boolean,
  refusals: number,
  seen: (idb: IDBDatabase) => void = () => {}
) {
  const transaction = IDBDatabase.prototype.transaction
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    if (refuses(this, args[1])) {
      seen(this)
      if (refusals-- > 0) throw new DOMException("The quota was exceeded", "QuotaExceededError")
    }
    return transaction.apply(this, args)
  })
  owned.push(() => spy.mockRestore())
}

/** A database whose rows SQLite committed, read-write, without IndexedDB holding them yet. */
async function unlandedSession(rows: SyncCursor[]) {
  const session = await readWriteSession({
    intercept: (request, next) => (request.type === "backlog" ? never : next()),
  })
  await session.database.syncCursors.bulkPut(rows)
  session.database.close()
  session.coordination.die()
  return session
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

describe("read-write SQLite storage", () => {
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
    const { database } = await readWriteSession({
      intercept: (request, next) => (request.type === "backlog" ? never : next()),
    })
    const nativeTransactions = spyNativeTransactions()
    await database.syncCursors.bulkPut([cursor("a", "1"), cursor("b", "2")])
    await database.transaction("rw", database.syncCursors, database.drafts, async () => {
      await database.syncCursors.update("a", { cursor: "3" })
      await database.drafts.toArray()
    })
    expect({ cursors: await cursorsIn(database), nativeTransactions: nativeTransactions() }).toEqual({
      cursors: [cursor("a", "3"), cursor("b", "2")],
      nativeTransactions: 0,
    })
  })

  it("replays every committed transaction into IndexedDB in the background, leaving no marks to re-copy", async () => {
    const { database, coordination, name, sqlite } = await readWriteSession()
    await database.syncCursors.bulkPut([cursor("a", "1"), cursor("b", "1"), cursor("c", "1")])
    await database.syncCursors.delete("b")
    await database.syncCursors.where("key").above("b").modify({ cursor: "2" })
    const backup = plainDatabase(name)
    await until(() => backlogRows(sqlite) === 0, "the backlog to drain")
    expect(await cursorsIn(backup)).toEqual([cursor("a", "1"), cursor("c", "2")])
    database.close()
    coordination.die()

    const next = openMirrored({ name, sqlite, mode: "read-write" })
    await next.database.open()
    expect({ readWrite: next.mirror.readWrite, copied: next.log.filter((type) => type === "backfillBegin") }).toEqual({
      readWrite: true,
      copied: [],
    })
  })

  it("notifies live queries of read-write commits", async () => {
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

  it("stays read-only until every mirrored store is held in full", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    owned.push(() => warn.mockRestore())
    const { database, mirror, name } = openMirrored({ mode: "read-write", entering: true })
    await database.open()
    await until(() => mirroredStores(database).every((store) => mirror.trusts(store)), "a full backfill")
    expect({
      readWrite: mirror.readWrite,
      recorded: await readRecordedMode(name),
      deferred: capture.snapshot().filter((sample) => sample.name === "sqlite.readWriteDeferred").length,
      warned: warn.mock.calls.map(([message]) => message),
    }).toEqual({
      readWrite: false,
      recorded: "off",
      deferred: 1,
      warned: [
        `SQLite storage stays read-only until it holds every store in full; missing: ${mirroredStores(database).join(", ")}`,
      ],
    })
  })

  for (const killed of ["backlog", "backlogDone"] as const) {
    it(`lands every committed row in IndexedDB once when the worker dies at ${killed}`, async () => {
      const drain = gate()
      let died = false
      const { database, name, sqlite } = await readWriteSession({
        intercept: async (request, next) => {
          if (request.type !== killed) return next()
          await drain.opened
          died = true
          throw new Error("worker died")
        },
        deadlines: { recoverMs: 1 },
      })
      vi.spyOn(console, "error").mockImplementation(() => {})
      await database.syncCursors.bulkPut([cursor("a", "1"), cursor("b", "1")])
      await database.syncCursors.delete("a")
      await database.syncCursors.put(cursor("b", "2"))
      drain.open()
      await until(() => died, "the worker to die")
      await expect(database.syncCursors.get("b")).rejects.toThrow(/SQLite storage is unavailable/)
      database.close()
      expect(backlogRows(sqlite)).toBe(3)

      const third = openMirrored({ name, sqlite, mode: "read-write" })
      expect(await cursorsIn(third.database)).toEqual([cursor("b", "2")])
      expect({ backlog: backlogRows(sqlite), readWrite: third.mirror.readWrite }).toEqual({
        backlog: 0,
        readWrite: true,
      })
      third.database.close()
      expect(await cursorsIn(plainDatabase(name))).toEqual([cursor("b", "2")])
    })
  }

  it("records read-write, durably, before the first write only SQLite holds", async () => {
    const recordedAtWrite: string[] = []
    let name = ""
    const session = await readWriteSession({
      intercept: async (request, next) => {
        if (request.type === "write") recordedAtWrite.push(await readRecordedMode(name))
        return next()
      },
    })
    name = session.name
    await session.database.syncCursors.put(cursor("a", "1"))
    expect(recordedAtWrite).toEqual(["read-write"])
  })

  it("reloads every tab once the backfill an entering boot deferred on completes, once per tab session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    owned.push(() => warn.mockRestore())
    const name = `deferred_${Date.now()}`
    adoptDeliveredMode(name, WS, "read-write")
    const reloadEveryTab = vi.fn()
    const entering = openMirrored({ name, mode: "read-write", entering: true, reloadEveryTab })
    await entering.database.open()
    await until(() => reloadEveryTab.mock.calls.length === 1, "every tab to reload")
    const afterBackfill = { readWrite: entering.mirror.readWrite, recorded: await readRecordedMode(name) }
    entering.database.close()
    entering.coordination.die()

    const reloaded = openMirrored({ name, sqlite: entering.sqlite, mode: "read-only", reloadEveryTab })
    await reloaded.database.open()
    await until(() => mirroredStores(reloaded.database).every((store) => reloaded.mirror.trusts(store)), "trust")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect({ afterBackfill, reloads: reloadEveryTab.mock.calls.length }).toEqual({
      afterBackfill: { readWrite: false, recorded: "off" },
      reloads: 1,
    })
  })

  it("hands a read-write database back to every tab's IndexedDB when SQLite no longer holds every store, as after an upgrade", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    owned.push(() => warn.mockRestore())
    const name = `demoted_${Date.now()}`
    await recordMode(name, "read-write")
    const reloadEveryTab = vi.fn()
    const { database } = openMirrored({ name, mode: "read-write", reloadEveryTab })
    void database.open()
    await until(() => reloadEveryTab.mock.calls.length === 1, "every tab to reload")
    expect(await readRecordedMode(name)).toBe("read-only")
  })

  it("closes the connections of builds that predate the recorded mode", async () => {
    const name = `evicted_${Date.now()}`
    const request = indexedDB.open(name, 580)
    const old = await new Promise<IDBDatabase>((resolve) => (request.onsuccess = () => resolve(request.result)))
    let upgradedTo: number | null = null
    old.onversionchange = (event) => {
      upgradedTo = event.newVersion
      old.close()
    }
    await plainDatabase(name).open()
    expect(upgradedTo).toBe(590)
  })

  it("keeps SQLite's rows when a tab writes IndexedDB directly meanwhile, failing loudly", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    owned.push(() => error.mockRestore())
    const owner = await readWriteSession()
    owner.bus.hearAnnouncements(owner.name)
    await owner.database.syncCursors.put(cursor("a", "sqlite"))
    await plainDatabase(owner.name).syncCursors.put(cursor("a", "native"))
    await until(() => capture.snapshot().some((sample) => sample.name === "sqlite.foreignWrite"), "the foreign write")
    expect(await owner.database.syncCursors.get("a")).toEqual(cursor("a", "sqlite"))
  })

  it("keeps serving and retries the replay into IndexedDB until it lands, strictly durable, counting each failure", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { database, sqlite, mirror, name } = await readWriteSession({ deadlines: { drainRetryMs: 5 } })
    const replays: Array<IDBTransactionOptions | undefined> = []
    let refusals = 2
    const transaction = IDBDatabase.prototype.transaction
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (this.name === name && args[1] === "readwrite") {
        replays.push(args[2])
        if (refusals-- > 0) throw new DOMException("The quota was exceeded", "QuotaExceededError")
      }
      return transaction.apply(this, args)
    })
    owned.push(() => spy.mockRestore())
    await database.syncCursors.put(cursor("a", "1"))
    await until(() => backlogRows(sqlite) === 0, "the replay to land")
    expect({
      failures: capture.snapshot().filter((sample) => sample.name === "sqlite.drainFailure").length,
      durability: [...new Set(replays.map((options) => options?.durability))],
      readWrite: mirror.readWrite,
      inIdb: await cursorsIn(plainDatabase(name)),
    }).toEqual({ failures: 2, durability: ["strict"], readWrite: true, inIdb: [cursor("a", "1")] })
  })

  it("stops retrying the replay once its database closed, reporting no failure after", async () => {
    silenceErrors()
    const { database, sqlite, name } = await readWriteSession({ deadlines: { drainRetryMs: 5 } })
    let attempts = 0
    refuseTransactions(
      (idb, mode) => idb.name === name && mode === "readwrite",
      Infinity,
      () => attempts++
    )
    await database.syncCursors.put(cursor("a", "1"))
    await until(() => attempts > 0, "a refused replay")
    database.close()
    const capture = new PerfCapture()
    armPerfCapture(capture)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect({
      failures: capture.snapshot().filter((sample) => sample.name === "sqlite.drainFailure").length,
      backlog: backlogRows(sqlite),
    }).toEqual({ failures: 0, backlog: 1 })
  })

  it("lands every committed row in IndexedDB before an upgrade from another tab proceeds", async () => {
    const drains = gate()
    const { database, name } = await readWriteSession({
      intercept: async (request, next) => {
        if (request.type === "backlog") await drains.opened
        return next()
      },
    })
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ reload } as unknown as Location)
    await database.syncCursors.bulkPut([cursor("a", "1"), cursor("b", "1")])
    const upgrade = indexedDB.open(name, database.verno * 10 + 10)
    const upgraded = new Promise<IDBDatabase>((resolve) => (upgrade.onsuccess = () => resolve(upgrade.result)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    drains.open()
    const idb = await upgraded
    const rows = idb.transaction("syncCursors").objectStore("syncCursors").getAll()
    await new Promise((resolve) => (rows.onsuccess = resolve))
    idb.close()
    expect({ rows: rows.result, reloaded: reload.mock.calls.length }).toEqual({
      rows: [cursor("a", "1"), cursor("b", "1")],
      reloaded: 1,
    })
  })

  it("keeps retrying the replay before another tab's upgrade, then lets it proceed", async () => {
    silenceErrors()
    const { database, name, sqlite } = await readWriteSession({ deadlines: { drainRetryMs: 5 } })
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ reload } as unknown as Location)
    await database.syncCursors.put(cursor("a", "1"))
    await until(() => backlogRows(sqlite) === 0, "the first replay to land")
    refuseTransactions((idb, mode) => idb.name === name && mode === "readwrite", 3)
    await database.syncCursors.put(cursor("b", "1"))
    const upgrade = indexedDB.open(name, database.verno * 10 + 10)
    const idb = await new Promise<IDBDatabase>((resolve) => (upgrade.onsuccess = () => resolve(upgrade.result)))
    const rows = idb.transaction("syncCursors").objectStore("syncCursors").getAll()
    await new Promise((resolve) => (rows.onsuccess = resolve))
    idb.close()
    expect({ rows: rows.result, reloaded: reload.mock.calls.length }).toEqual({
      rows: [cursor("a", "1"), cursor("b", "1")],
      reloaded: 1,
    })
  })

  it("lands a backlog in the IndexedDB schema it was written under before opening upgrades it, telling the user while it cannot", async () => {
    silenceErrors()
    const { sqlite } = await unlandedSession([cursor("a", "1")])
    const name = `installed_older_${Date.now()}`
    const older = new Dexie(name)
    older.version(58).stores({ syncCursors: "key, updatedAt" })
    await older.open()
    older.close()
    const landedUnder: number[] = []
    refuseTransactions(
      (idb, mode) => idb.name === name && mode === "readwrite",
      2,
      (idb) => landedUnder.push(idb.version)
    )
    const { database } = openMirrored({
      name,
      sqlite,
      mode: "read-write",
      deadlines: { drainRetryMs: 5 },
      reloadEveryTab: vi.fn(),
    })
    const told: boolean[] = []
    database.onStorageFailure(() => told.push(database.storageFailure))
    await database.open()
    await until(() => backlogRows(sqlite) === 0, "the backlog to land")
    expect({
      landedUnder: [...new Set(landedUnder.slice(0, 3))],
      told,
      cursors: await cursorsIn(plainDatabase(name)),
    }).toEqual({ landedUnder: [580], told: [true, false], cursors: [cursor("a", "1")] })
  })

  for (const failing of ["open", "recordMode"] as const) {
    it(`keeps a boot entering read-write on IndexedDB when ${failing} fails before read-write is recorded`, async () => {
      silenceErrors()
      if (failing === "recordMode")
        refuseTransactions((idb, mode) => idb.name === "threa-sqlite-mode" && mode === "readwrite", 1)
      const options = { mode: "read-write" as const, entering: true }
      const { database, mirror, name } =
        failing === "open"
          ? openMirrored({ ...options, failOpen: true })
          : openMirrored({ ...options, ...(await copiedSession(options)) })
      await database.open()
      await database.syncCursors.put(cursor("a", "1"))
      expect({
        readWrite: mirror.readWrite,
        recorded: await readRecordedMode(name),
        inIdb: await cursorsIn(plainDatabase(name)),
      }).toEqual({ readWrite: false, recorded: "off", inIdb: [cursor("a", "1")] })
    })
  }

  it("serves a tab entering in the gap after the entering owner stayed on IndexedDB from IndexedDB", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    owned.push(() => warn.mockRestore())
    const owner = openMirrored({ mode: "read-write", entering: true })
    await owner.database.open()
    const gap = openMirrored({
      name: owner.name,
      sqlite: owner.sqlite,
      bus: owner.bus,
      mode: "read-write",
      entering: true,
      deadlines: { decidedMs: 50 },
    })
    await gap.database.open()
    await gap.database.syncCursors.put(cursor("a", "1"))
    expect({ readWrite: gap.mirror.readWrite, inIdb: await cursorsIn(plainDatabase(owner.name)) }).toEqual({
      readWrite: false,
      inIdb: [cursor("a", "1")],
    })
  })

  it("lands a backlog an owner outside read-write finds", async () => {
    silenceErrors()
    const { name, sqlite } = await unlandedSession([cursor("a", "1")])
    const { database } = openMirrored({ name, sqlite, mode: "read-only" })
    await database.open()
    await until(() => backlogRows(sqlite) === 0, "the backlog to land")
    expect(await cursorsIn(plainDatabase(name))).toEqual([cursor("a", "1")])
  })

  it("keeps every SQLite row when IndexedDB is recreated under read-write storage, writing all of them to it again", async () => {
    silenceErrors()
    let stall = false
    const session = await readWriteSession({
      intercept: (request, next) => (stall && request.type === "backlog" ? never : next()),
    })
    const { name, sqlite } = session
    await session.database.syncCursors.put(cursor("landed", "1"))
    await until(() => backlogRows(sqlite) === 0, "the first row to land")
    stall = true
    await session.database.syncCursors.put(cursor("unlanded", "1"))
    session.database.close()
    session.coordination.die()
    await Dexie.delete(name)
    refuseTransactions((idb, mode) => idb.name === name && mode === "readwrite", 1)
    const { database, mirror } = openMirrored({
      name,
      sqlite,
      mode: "read-write",
      deadlines: { drainRetryMs: 5, recoverMs: 1 },
      reloadEveryTab: vi.fn(),
    })
    await database.open()
    const served = { readWrite: mirror.readWrite, cursors: await cursorsIn(database) }
    await until(() => backlogRows(sqlite) === 0, "IndexedDB to be written again")
    expect({ served, inIdb: await cursorsIn(plainDatabase(name)) }).toEqual({
      served: { readWrite: true, cursors: [cursor("landed", "1"), cursor("unlanded", "1")] },
      inIdb: [cursor("landed", "1"), cursor("unlanded", "1")],
    })
  })

  for (const lost of ["get", "commit"] as const) {
    it(`never deletes IndexedDB when the owner closes during a ready handler's ${lost}, which runs again or fails the open`, async () => {
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
        mode: "read-write",
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
      expect({ opened: await opened, uploads: await plainDatabase(owner.name).uploadJobs.toArray() }).toEqual({
        opened: lost === "get" ? "opened" : "failed",
        uploads: [{ attachmentId: "upload_1" }],
      })
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

  it("fails requests and tells the user once workers keep failing", async () => {
    silenceErrors()
    let dead = false
    const { database } = await readWriteSession({
      intercept: (_request, next) => (dead ? Promise.reject(new Error("worker died")) : next()),
      deadlines: { recoverMs: 1 },
    })
    dead = true
    void database.syncCursors.get("a").catch(() => {})
    await until(() => database.storageFailure, "the user to be told")
    await expect(database.syncCursors.get("b")).rejects.toThrow(/SQLite storage is unavailable/)
  })

  it("lands the backlog before another tab's upgrade proceeds while the owner is still deciding", async () => {
    silenceErrors()
    const { name, sqlite } = await unlandedSession([cursor("a", "1")])
    refuseTransactions((idb, mode) => idb.name === name && mode === "readwrite", 1)
    const deciding = gate()
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ reload } as unknown as Location)
    const { database } = openMirrored({
      name,
      sqlite,
      mode: "read-write",
      deadlines: { drainRetryMs: 60_000 },
      intercept: async (request, next) => {
        if (request.type === "status") await deciding.opened
        return next()
      },
    })
    void database.open()
    await database.whenIdbOpen()
    const upgrade = indexedDB.open(name, database.verno * 10 + 10)
    const idb = await new Promise<IDBDatabase>((resolve) => (upgrade.onsuccess = () => resolve(upgrade.result)))
    const rows = idb.transaction("syncCursors").objectStore("syncCursors").getAll()
    await new Promise((resolve) => (rows.onsuccess = resolve))
    idb.close()
    deciding.open()
    expect({ rows: rows.result, reloaded: reload.mock.calls.length }).toEqual({
      rows: [cursor("a", "1")],
      reloaded: 1,
    })
  })

  describe("switching modes at boot", () => {
    it("enters read-write only at a boot holding every other tab of the database out", async () => {
      const { name, sqlite } = await copiedSession({ mode: "read-write", entering: true })
      const bus = createBus()
      const native = bootTab(name, sqlite, bus)
      await native.database.open()
      adoptDeliveredMode(name, WS, "read-write")
      const blocked = bootTab(name, sqlite, bus)
      await blocked.database.open()
      const whileBlocked = { mirror: blocked.database.sqliteMirror, recorded: await readRecordedMode(name) }
      for (const tab of [native, blocked]) {
        tab.database.close()
        tab.coordination.die()
      }
      const entering = bootTab(name, sqlite, bus)
      await entering.database.open()
      expect({
        whileBlocked,
        readWrite: entering.database.sqliteMirror?.readWrite,
        recorded: await readRecordedMode(name),
      }).toEqual({ whileBlocked: { mirror: null, recorded: "off" }, readWrite: true, recorded: "read-write" })
    })

    it("leaves read-write only once every tab closed, landing every tab's rows in IndexedDB and dropping SQLite", async () => {
      const established = await readWriteSession()
      established.database.close()
      established.coordination.die()
      const { name, sqlite } = established
      adoptDeliveredMode(name, WS, "read-write")
      const bus = createBus()
      const first = bootTab(name, sqlite, bus, (request, next) => (request.type === "backlog" ? never : next()))
      await first.database.syncCursors.put(cursor("first", "1"))
      adoptDeliveredMode(name, WS, "off")
      const second = bootTab(name, sqlite, bus)
      await second.database.syncCursors.put(cursor("second", "1"))
      const whileOpen = { readWrite: second.database.sqliteMirror?.readWrite, recorded: await readRecordedMode(name) }
      for (const tab of [first, second]) {
        tab.database.close()
        tab.coordination.die()
      }
      expect(backlogRows(sqlite)).toBe(2)

      const next = bootTab(name, sqlite, bus)
      expect({
        whileOpen,
        cursors: await cursorsIn(next.database),
        mirror: next.database.sqliteMirror,
        recorded: await readRecordedMode(name),
        backlog: backlogRows(sqlite),
        destroyed: next.log.includes("destroy"),
      }).toEqual({
        whileOpen: { readWrite: true, recorded: "read-write" },
        cursors: [cursor("first", "1"), cursor("second", "1")],
        mirror: null,
        recorded: "off",
        backlog: 0,
        destroyed: true,
      })
    })

    it("records off before dropping SQLite's file, so a file it cannot drop still leaves read-write", async () => {
      silenceErrors()
      const established = await readWriteSession()
      established.database.close()
      established.coordination.die()
      const { name, sqlite } = established
      const tab = bootTab(name, sqlite, createBus(), (request, next) =>
        request.type === "destroy" ? Promise.reject(new Error("The file is busy")) : next()
      )
      await tab.database.open()
      expect({ recorded: await readRecordedMode(name), mirror: tab.database.sqliteMirror }).toEqual({
        recorded: "off",
        mirror: null,
      })
    })

    it("boots at once under the recorded mode while another tab runs, waiting for it only after a reload to switch", async () => {
      const { name, sqlite } = await copiedSession({ mode: "read-only" })
      const bus = createBus()
      const running = bootTab(name, sqlite, bus)
      await running.database.open()
      adoptDeliveredMode(name, WS, "read-only")
      const later = bootTab(name, sqlite, bus)
      const waited = await Promise.race([
        later.database.open().then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_000)),
      ])
      sessionStorage.setItem("threa:sqliteSwitchReload", "1")
      const reloaded = bootTab(name, sqlite, bus)
      for (const tab of [running, later]) {
        tab.database.close()
        tab.coordination.die()
      }
      await reloaded.database.open()
      expect({
        waited,
        laterMirror: later.database.sqliteMirror,
        reloadedMode: reloaded.database.sqliteMirror?.mode,
        recorded: await readRecordedMode(name),
      }).toEqual({ waited: false, laterMirror: null, reloadedMode: "read-only", recorded: "read-only" })
    })

    it("reloads every tab once when a plain boot cannot switch past a running tab, switching on the boot after", async () => {
      const { name, sqlite } = await copiedSession({ mode: "read-only" })
      const bus = createBus()
      const running = bootTab(name, sqlite, bus)
      await running.database.open()
      adoptDeliveredMode(name, WS, "read-only")
      const reloadEveryTab = vi.fn()
      const blocked = bootTab(name, sqlite, bus, undefined, reloadEveryTab)
      await blocked.database.open()
      const blockedAgain = bootTab(name, sqlite, bus, undefined, reloadEveryTab)
      await blockedAgain.database.open()
      const beforeReload = {
        reloads: reloadEveryTab.mock.calls.length,
        mirrors: [blocked.database.sqliteMirror, blockedAgain.database.sqliteMirror],
        recorded: await readRecordedMode(name),
      }
      for (const tab of [running, blocked, blockedAgain]) {
        tab.database.close()
        tab.coordination.die()
      }
      sessionStorage.setItem("threa:sqliteSwitchReload", "1")
      const reloaded = bootTab(name, sqlite, bus, undefined, reloadEveryTab)
      await reloaded.database.open()
      expect({
        beforeReload,
        reloads: reloadEveryTab.mock.calls.length,
        reloadedMode: reloaded.database.sqliteMirror?.mode,
        recorded: await readRecordedMode(name),
      }).toEqual({
        beforeReload: { reloads: 1, mirrors: [null, null], recorded: "off" },
        reloads: 1,
        reloadedMode: "read-only",
        recorded: "read-only",
      })
    })

    it("retries an unreadable recorded mode, then boots off only a database never recorded read-write", async () => {
      silenceErrors()
      const readWrite = `recorded_read_write_${Date.now()}`
      await recordMode(readWrite, "read-write")
      const open = indexedDB.open.bind(indexedDB)
      let failures = 1
      const spy = vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
        if (name === "threa-sqlite-mode" && failures-- > 0)
          throw new DOMException("The disk is unreadable", "UnknownError")
        return open(name, version)
      })
      owned.push(() => spy.mockRestore())
      const { name, sqlite } = await copiedSession({ mode: "read-only" })
      const bus = createBus()
      const retried = bootTab(name, sqlite, bus)
      await retried.database.open()
      failures = Infinity
      const neverMirrored = bootTab(`never_mirrored_${Date.now()}`, sqlite, bus)
      await neverMirrored.database.open()
      const mirrored = bootTab(name, sqlite, bus)
      await mirrored.database.open()
      const recordedReadWrite = bootTab(readWrite, sqlite, bus)
      expect({
        retried: retried.database.isOpen(),
        neverMirrored: neverMirrored.database.isOpen(),
        mirrored: mirrored.database.isOpen(),
        recordedReadWrite: await recordedReadWrite.database.open().then(
          () => "opened",
          (error: Error) => error.message
        ),
      }).toEqual({
        retried: true,
        neverMirrored: true,
        mirrored: true,
        recordedReadWrite: `Cannot tell whether SQLite holds the primary copy of ${readWrite}`,
      })
    })

    it("fails to open a database recorded read-write when its mirror cannot start, or no tab could run one", async () => {
      silenceErrors()
      const name = `unstartable_${Date.now()}`
      await recordMode(name, "read-write")
      adoptDeliveredMode(name, WS, "read-write")
      const unstartable = plainDatabase(name)
      resumeSqliteMirror(unstartable, {
        lock: createBus().modeLock(),
        createTransport: () => {
          throw new Error("No worker")
        },
        createMirror: () => {
          throw new Error("BroadcastChannel is unavailable")
        },
      })
      const withoutLocks = plainDatabase(name)
      resumeSqliteMirror(withoutLocks, null)
      const outcome = (database: ThreaDatabase) =>
        database.open().then(
          () => "opened",
          (error: Error) => error.message
        )
      const refused = `SQLite holds the primary copy of ${name}, but SQLite storage cannot run in this tab`
      const [unstartableOpen, withoutLocksOpen] = await Promise.all([outcome(unstartable), outcome(withoutLocks)])
      expect({
        unstartable: unstartableOpen,
        withoutLocks: withoutLocksOpen,
        told: [unstartable.storageFailure, withoutLocks.storageFailure],
      }).toEqual({ unstartable: refused, withoutLocks: refused, told: [true, true] })
    })
  })

  describe("in a second tab", () => {
    async function follower(owner: Awaited<ReturnType<typeof readWriteSession>>, options: MirroredOptions = {}) {
      const tab = openMirrored({
        ...options,
        name: owner.name,
        sqlite: owner.sqlite,
        bus: owner.bus,
        mode: "read-write",
      })
      await tab.database.open()
      return tab
    }

    it("runs every transaction on the owner's worker with IndexedDB's semantics", async () => {
      const reference = await transactionSemantics(plainDatabase(`reference_${Date.now()}`))
      const owner = await readWriteSession({
        intercept: (request, next) => (request.type === "backlog" ? never : next()),
      })
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

    it("serves nothing from the tab taking over until it decided SQLite still holds every store", async () => {
      const owner = await readWriteSession()
      const reconciling = gate()
      const requests: MirrorRequest["type"][] = []
      const second = await follower(owner, {
        intercept: async (request, next) => {
          requests.push(request.type)
          if (request.type === "status") await reconciling.opened
          return next()
        },
      })
      owner.coordination.die()
      owner.database.close()
      await until(() => requests.includes("status"), "the new owner to reconcile")
      const put = second.database.syncCursors.put(cursor("after", "1"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const begunBeforeDecided = requests.includes("begin")
      reconciling.open()
      await put
      expect({
        begunBeforeDecided,
        readWrite: second.mirror.readWrite,
        cursors: await cursorsIn(second.database),
      }).toEqual({
        begunBeforeDecided: false,
        readWrite: true,
        cursors: [cursor("after", "1")],
      })
    })

    it("fails a commit the owner's worker may have applied as outcome-unknown when the owner closes before answering", async () => {
      let loseReply = false
      const owner = await readWriteSession({
        intercept: async (request, next) => {
          if (request.type !== "commit" || !loseReply) return next()
          await next()
          return never
        },
      })
      const second = await follower(owner)
      loseReply = true
      const commits = owner.log.filter((type) => type === "commit").length
      const put = second.database.syncCursors.put(cursor("maybe", "1"))
      await until(
        () => owner.log.filter((type) => type === "commit").length > commits,
        "the commit to reach the worker"
      )
      owner.coordination.die()
      owner.database.close()
      // Dexie reports a transaction's abort as AbortError, carrying what aborted it.
      const failure = await put.then(
        () => null,
        (error: Error & { inner?: Error }) => error.inner?.name
      )
      expect({ failure, afterTakeover: await second.database.syncCursors.get("maybe") }).toEqual({
        failure: "OutcomeUnknownError",
        afterTakeover: cursor("maybe", "1"),
      })
    })

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
      const tab = openMirrored({ bus, mode: "read-write", deadlines: { decidedMs: 30 } })
      await tab.database.open()
      await expect(tab.database.syncCursors.get("a")).rejects.toThrow(/SQLite storage is unavailable/)
      expect(capture.snapshot().filter((sample) => sample.name === "sqlite.decisionOverdue").length).toBe(1)
    })
  })
})
