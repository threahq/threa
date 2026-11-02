import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import { liveQuery } from "dexie"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import type { SyncCursor, ThreaDatabase } from "../database"
import { SqliteMirror } from "./client"
import { primaryMarked } from "./idb-guard"
import { resumeSqliteMirror } from "./lifecycle"
import { gate, mirroredDatabases, mirroredStores, until, type MirroredOptions } from "./mirrored-databases"
import type { MirrorRequest } from "./protocol"
import { createBus, inProcessTransport } from "./test-harness"

let openMirrored: ReturnType<typeof mirroredDatabases>["openMirrored"]
let plainDatabase: ReturnType<typeof mirroredDatabases>["plainDatabase"]
let copiedSession: ReturnType<typeof mirroredDatabases>["copiedSession"]
const owned: Array<() => void> = []
beforeAll(async () => {
  ;({ openMirrored, plainDatabase, copiedSession } = mirroredDatabases(await sqlite3InitModule(), owned))
})

afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  armPerfCapture(NO_CAPTURE)
})

const cursor = (key: string, value: string, updatedAt = 1): SyncCursor => ({ key, cursor: value, updatedAt })

const never = new Promise<never>(() => {})

function backlogRows(sqlite: Database): number {
  return Number(sqlite.selectValue("SELECT COUNT(*) FROM _idb_backlog"))
}

/** A second boot of a database whose first, read-write boot copied every store into SQLite. */
async function readWriteSession(options: MirroredOptions = {}) {
  const { name, sqlite } = await copiedSession({ mode: "read-write" })
  const second = openMirrored({ ...options, name, sqlite, mode: "read-write" })
  await second.database.open()
  return second
}

/** A tab booted with the flag off, on the same browser as `bus`'s tabs. */
function offTab(name: string, sqlite: Database, bus: ReturnType<typeof createBus>, log: MirrorRequest["type"][] = []) {
  const off = plainDatabase(name)
  resumeSqliteMirror(
    off,
    (target, mode, guard) =>
      new SqliteMirror({
        database: target,
        mode,
        coordination: bus.coordination(),
        guard: guard!,
        createTransport: () => inProcessTransport(sqlite, log),
      }),
    bus.guard(name)
  )
  return off
}

async function cursorsIn(database: ThreaDatabase) {
  return database.syncCursors.orderBy("key").toArray()
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

  it("syncs device-only stores to disk before acknowledging their commit", async () => {
    const begun: Array<Extract<MirrorRequest, { type: "begin" }>> = []
    const { database } = await readWriteSession({
      intercept: (request, next) => {
        if (request.type === "begin") begun.push(request)
        return next()
      },
    })
    await database.syncCursors.put(cursor("a", "1"))
    await database.pendingOperations.clear()
    expect(begun.map((request) => request.strict)).toEqual([false, true])
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
    const { database, mirror, name } = openMirrored({ mode: "read-write" })
    await database.open()
    await until(() => mirroredStores(database).every((store) => mirror.trusts(store)), "a full backfill")
    expect({
      readWrite: mirror.readWrite,
      primary: await primaryMarked(name),
      deferred: capture.snapshot().filter((sample) => sample.name === "sqlite.readWriteDeferred").length,
      warned: warn.mock.calls.map(([message]) => message),
    }).toEqual({
      readWrite: false,
      primary: false,
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

  it("marks SQLite primary, durably, before the first write only SQLite holds", async () => {
    const markedAtWrite: boolean[] = []
    let name = ""
    const session = await readWriteSession({
      intercept: async (request, next) => {
        if (request.type === "write") markedAtWrite.push(await primaryMarked(name))
        return next()
      },
    })
    name = session.name
    await session.database.syncCursors.put(cursor("a", "1"))
    expect(markedAtWrite).toEqual([true])
  })

  it("lands SQLite's writes before a flag-off boot opens IndexedDB, when the browser died before the backlog drained", async () => {
    const { database, coordination, name, sqlite } = await readWriteSession({
      intercept: (request, next) => (request.type === "backlog" ? never : next()),
    })
    await database.syncCursors.bulkPut([cursor("a", "1"), cursor("b", "1")])
    await database.drafts.clear()
    database.close()
    coordination.die()
    // localStorage is flushed lazily, so a browser kill may lose all of it.
    localStorage.clear()
    expect({ backlog: backlogRows(sqlite), primary: await primaryMarked(name) }).toEqual({ backlog: 2, primary: true })

    const log: MirrorRequest["type"][] = []
    const off = offTab(name, sqlite, createBus(), log)
    expect(await cursorsIn(off)).toEqual([cursor("a", "1"), cursor("b", "1")])
    await until(() => off.sqliteMirror === null && log.includes("destroy"), "the mirror to be destroyed")
    expect({ backlog: backlogRows(sqlite), primary: await primaryMarked(name) }).toEqual({ backlog: 0, primary: false })
  })

  it("stays read-only while a tab writes IndexedDB itself, and that tab's writes stay in IndexedDB", async () => {
    const { name, sqlite } = await copiedSession({ mode: "read-write" })
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    owned.push(() => warn.mockRestore())
    const bus = createBus()
    const native = offTab(name, sqlite, bus)
    await native.open()
    const owner = openMirrored({ name, sqlite, bus, mode: "read-write" })
    await owner.database.open()
    await until(() => mirroredStores(owner.database).every((store) => owner.mirror.trusts(store)), "trust")
    await native.syncCursors.put(cursor("native", "1"))
    await owner.database.syncCursors.put(cursor("owner", "1"))
    expect({
      readWrite: owner.mirror.readWrite,
      primary: await primaryMarked(name),
      deferred: capture.snapshot().filter((sample) => sample.name === "sqlite.readWriteDeferred").length,
      nativeSees: await cursorsIn(native),
      warned: warn.mock.calls.map(([message]) => message),
    }).toEqual({
      readWrite: false,
      primary: false,
      deferred: 1,
      warned: ["SQLite storage stays read-only: another tab writes IndexedDB directly"],
      nativeSees: [cursor("native", "1"), cursor("owner", "1")],
    })
  })

  it("routes a flag-off tab through the tab serving read-write, then lands the backlog and drops SQLite when it takes over", async () => {
    const owner = await readWriteSession({
      intercept: (request, next) => (request.type === "backlog" ? never : next()),
    })
    const log: MirrorRequest["type"][] = []
    const off = offTab(owner.name, owner.sqlite, owner.bus, log)
    await off.syncCursors.put(cursor("from off", "1"))
    expect({ readWrite: off.sqliteMirror?.readWrite, ownerSees: await cursorsIn(owner.database) }).toEqual({
      readWrite: true,
      ownerSees: [cursor("from off", "1")],
    })

    owner.coordination.die()
    owner.database.close()
    await until(() => off.sqliteMirror === null && log.includes("destroy"), "the flag-off tab to drop SQLite")
    await off.syncCursors.put(cursor("native", "1"))
    expect({
      backlog: backlogRows(owner.sqlite),
      primary: await primaryMarked(owner.name),
      inIdb: await cursorsIn(plainDatabase(owner.name)),
    }).toEqual({ backlog: 0, primary: false, inIdb: [cursor("from off", "1"), cursor("native", "1")] })
  })

  describe("in a second tab", () => {
    async function follower(owner: Awaited<ReturnType<typeof readWriteSession>>) {
      const tab = openMirrored({ name: owner.name, sqlite: owner.sqlite, bus: owner.bus, mode: "read-write" })
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

    it("fails what was in flight when the owner closes, then serves from the tab that takes over", async () => {
      let holdWrites = true
      const owner = await readWriteSession({
        intercept: (request, next) => (request.type === "write" && holdWrites ? never : next()),
      })
      holdWrites = false
      await owner.database.syncCursors.put(cursor("before", "1"))
      holdWrites = true
      const second = await follower(owner)
      const inFlight = second.database.syncCursors.put(cursor("lost", "1"))
      await until(() => owner.log.includes("begin") && owner.log.lastIndexOf("begin") > 0, "the transaction to begin")
      await new Promise((resolve) => setTimeout(resolve, 20))
      owner.coordination.die()
      owner.database.close()
      // The owner's worker dies with its tab, and SQLite rolls back what it left open.
      owner.sqlite.exec("ROLLBACK")
      await expect(inFlight).rejects.toThrow(/closed during this transaction/)
      await second.database.syncCursors.put(cursor("after", "1"))
      expect({ readWrite: second.mirror.readWrite, cursors: await cursorsIn(second.database) }).toEqual({
        readWrite: true,
        cursors: [cursor("after", "1"), cursor("before", "1")],
      })
    })
  })
})
