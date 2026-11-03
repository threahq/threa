import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import Dexie, { liveQuery, type DBCoreCursor, type DBCoreKeyRange, type Transaction } from "dexie"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import { ThreaDatabase, type CachedEvent } from "../database"
import { SqliteMirror, type MirrorCoordination, type MirrorDeadlines, type SqliteMirrorMode } from "./client"
import { isSqliteMarksStore, type SqliteMark } from "./marks"
import type { MirrorRequest, MirrorTransport } from "./protocol"
import { isMirroredStore } from "./stores"
import { createBus, inProcessTransport, settle } from "./test-harness"
import { encodeValue } from "./value-codec"

const WS = "ws_1"
const EVENTS = "eventsByWorkspace"
const READS: ReadonlySet<string> = new Set(["get", "getMany", "query", "count"])
const OWNER = "workos_user_1"

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

const owned: Array<() => void> = []
afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  armPerfCapture(NO_CAPTURE)
})

let counter = 0

function event(id: string, streamId: string, sequence: number, extra: Partial<CachedEvent> = {}): CachedEvent {
  return {
    id,
    workspaceId: WS,
    streamId,
    sequence: String(sequence),
    _sequenceNum: sequence,
    eventType: sequence % 4 === 0 ? "reaction_added" : "message_created",
    payload: { messageId: `msg_${id}`, at: new Date(sequence * 1000) },
    actorId: null,
    actorType: null,
    createdAt: new Date(sequence * 1000).toISOString(),
    ...extra,
  } as CachedEvent
}

interface MirroredOptions {
  mode?: SqliteMirrorMode
  bus?: ReturnType<typeof createBus>
  name?: string
  sqlite?: Database
  failReads?: (request: MirrorRequest) => boolean
  /** Awaited before each request reaches the worker. */
  beforeRequest?: (request: MirrorRequest) => Promise<void> | undefined
  deadlines?: Partial<MirrorDeadlines>
  /** Constructs the database as the app does for a signed-in account, gated on cache ownership. */
  owner?: string
  /** Holds every request, the open included, until this settles. */
  workerStarted?: Promise<void>
  failOpen?: boolean
  /** Holds this tab's claim until this settles, as the Web Locks API answers asynchronously. */
  claimAnswered?: Promise<void>
}

function withDelayedClaim(coordination: MirrorCoordination, answered: Promise<void>): MirrorCoordination {
  return { ...coordination, claim: (onChange) => void answered.then(() => coordination.claim(onChange)) }
}

function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

function openMirrored(options: MirroredOptions = {}) {
  counter += 1
  const name = options.name ?? `read_only_${counter}_${Date.now()}`
  const database = new ThreaDatabase(name, options.owner)
  owned.push(() => database.close())
  let sqlite = options.sqlite
  if (!sqlite) {
    const created: Database = new sqlite3.oo1.DB(":memory:")
    owned.push(() => created.close())
    sqlite = created
  }
  const log: MirrorRequest["type"][] = []
  const bus = options.bus ?? createBus()
  const transport = (): MirrorTransport => {
    const inner = inProcessTransport(sqlite, log)
    return {
      request: async (request) => {
        await options.workerStarted
        await options.beforeRequest?.(request)
        if (request.type === "open" && options.failOpen) throw new Error("The worker failed to start")
        if (READS.has(request.type) && options.failReads?.(request))
          return { ok: false, error: "SQLiteError", message: "disk I/O error" }
        return inner.request(request)
      },
      heardAt: inner.heardAt,
      close: inner.close,
    }
  }
  const coordination = bus.coordination()
  const mirror = new SqliteMirror({
    database,
    mode: options.mode ?? "read-only",
    coordination: options.claimAnswered ? withDelayedClaim(coordination, options.claimAnswered) : coordination,
    createTransport: transport,
    deadlines: options.deadlines,
  })
  database.sqliteMirror = mirror
  mirror.start()
  const sqliteReads = () => log.filter((type) => READS.has(type)).length
  return { database, sqlite, mirror, bus, name, log, sqliteReads }
}

function plainDatabase(name: string): ThreaDatabase {
  const database = new ThreaDatabase(name)
  owned.push(() => database.close())
  return database
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const counted = (capture: PerfCapture, name: string) =>
  capture.snapshot().filter((sample) => sample.name === name).length

function mirroredStores(database: ThreaDatabase): string[] {
  return database.tables.map((table) => table.name).filter(isMirroredStore)
}

/** A previous session of this account that left SQLite holding every store, and the trusted set persisted. */
async function previousSession() {
  const first = openMirrored({ owner: OWNER })
  await first.database.open()
  await first.database.events.bulkPut([event("e1", "s1", 1), event("e2", "s1", 2), event("e3", "s2", 1)])
  await until(() => mirroredStores(first.database).every((store) => first.mirror.trusts(store)), "a full backfill")
  await settle()
  first.database.close()
  return { name: first.name, sqlite: first.sqlite, expected: await readEvents(plainDatabase(first.name)) }
}

const readEvents = (db: ThreaDatabase) =>
  Promise.all([db.events.get([WS, "e1"]), db.events.where("[workspaceId+streamId]").equals([WS, "s1"]).primaryKeys()])

/** Native readonly transactions, past Dexie's own read of the installed schema over every store at open. */
function spyNativeReadonly() {
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction")
  owned.push(() => spy.mockRestore())
  return () =>
    spy.mock.contexts.filter((idb, call) => {
      const [stores, mode] = spy.mock.calls[call]
      const count = typeof stores === "string" ? 1 : [...stores].length
      return mode === "readonly" && count < (idb as IDBDatabase).objectStoreNames.length
    }).length
}

function silenceErrors() {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  owned.push(() => errors.mockRestore())
  return () => errors.mock.calls.some(([message]) => String(message).includes("IndexedDB answered"))
}

/** A readwrite transaction over `store` kept running for `ms`, as a long writer in another tab would. */
function occupy(idb: IDBDatabase, store: string, ms: number): Promise<void> {
  const tx = idb.transaction(store, "readwrite")
  const until = performance.now() + ms
  const again = () => {
    if (performance.now() < until) tx.objectStore(store).count().onsuccess = again
  }
  again()
  return new Promise((resolve) => (tx.oncomplete = () => resolve()))
}

/** Stores with a mark past what SQLite holds of its writer: the next owner must not trust them. */
async function behind(database: ThreaDatabase, sqlite: Database): Promise<string[]> {
  const held = new Map(
    sqlite.selectArrays(`SELECT writer, store, seq FROM _mirror_writers`).map(([w, st, s]) => [`${w}/${st}`, Number(s)])
  )
  const tables = database.tables.filter((table) => isSqliteMarksStore(table.name))
  const marks = (await Promise.all(tables.map((table) => table.toArray() as Promise<SqliteMark[]>))).flat()
  const stores = marks.filter((m) => m.seq > (held.get(`${m.writer}/${m.store}`) ?? 0)).map((m) => m.store)
  return [...new Set(stores)].sort()
}

interface CursorCase {
  name: string
  /** `null` for the primary key. */
  index: string | null
  reverse?: boolean
  unique?: boolean
  values?: boolean
  /** The move after the row at `n`. */
  move?: (cursor: DBCoreCursor, n: number) => void
}

const STREAM_INDEX = "[workspaceId+streamId]"
const CURSOR_ROWS = 1100
const id4 = (n: number) => String(n).padStart(4, "0")

const CURSOR_CASES: CursorCase[] = [
  { name: "primary key, keys", index: null },
  { name: "index, reverse, values", index: STREAM_INDEX, reverse: true, values: true },
  { name: "index, nextunique", index: STREAM_INDEX, unique: true },
  { name: "index, prevunique", index: STREAM_INDEX, unique: true, reverse: true },
  {
    name: "index, seeks within and past the page",
    index: STREAM_INDEX,
    move: (cursor, n) => {
      if (n === 1) cursor.continue([WS, "s0003"])
      else if (n === 5) cursor.continue([WS, "s0450"])
      else cursor.continue()
    },
  },
  {
    name: "index, continuePrimaryKey past the page",
    index: STREAM_INDEX,
    values: true,
    move: (cursor, n) => (n === 3 ? cursor.continuePrimaryKey([WS, "s0400"], [WS, "a0801"]) : cursor.continue()),
  },
  { name: "primary key, advance", index: null, move: (cursor) => cursor.advance(7) },
  {
    name: "primary key, reverse, values, seek",
    index: null,
    reverse: true,
    values: true,
    move: (cursor, n) => (n === 2 ? cursor.continue([WS, "a0100"]) : cursor.continue()),
  },
]

/** Two events per stream, so an index cursor has more than a page of unique keys. */
async function cursorSession() {
  const first = openMirrored()
  await first.database.open()
  await first.database.events.bulkPut(
    Array.from({ length: CURSOR_ROWS }, (_, i) => event(`a${id4(i)}`, `s${id4(Math.floor(i / 2))}`, i))
  )
  await until(() => first.mirror.trusts(EVENTS), "a full backfill")
  await settle()
  first.database.close()
  return { name: first.name, sqlite: first.sqlite }
}

/** Every row a DBCore cursor visits, in one readonly transaction. */
function iterateCursor(db: ThreaDatabase, spec: CursorCase): Promise<unknown[][]> {
  return db.transaction("r", db.events, async () => {
    const table = db.core.table(EVENTS)
    const index =
      spec.index === null ? table.schema.primaryKey : table.schema.indexes.find((i) => i.name === spec.index)!
    const cursor = await table.openCursor({
      trans: Dexie.currentTransaction.idbtrans as never,
      values: spec.values === true,
      reverse: spec.reverse === true,
      unique: spec.unique === true,
      query: { index, range: { type: 3 } as DBCoreKeyRange },
    })
    const rows: unknown[][] = []
    if (!cursor) return rows
    let n = 0
    await cursor.start(() => {
      rows.push([cursor.key, cursor.primaryKey, spec.values ? (cursor.value as CachedEvent).id : null])
      if (spec.move) spec.move(cursor, n++)
      else cursor.continue()
    })
    return rows
  })
}

describe("read-only SQLite mirror", () => {
  it("serves Dexie reads from SQLite with exactly IndexedDB's answers", { timeout: 20_000 }, async () => {
    const { database, mirror, name, sqliteReads } = openMirrored()
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    const long = Array.from({ length: 1200 }, (_, i) =>
      event(`a${String(i).padStart(4, "0")}`, "s1", i, i % 97 === 0 ? { _status: "pending" } : {})
    )
    await database.events.bulkPut([...long, ...Array.from({ length: 30 }, (_, i) => event(`b${i}`, "s2", i))])
    await database.events.update([WS, "a0005"], { _status: "failed" })
    await database.events.delete([WS, "a0007"])
    await database.events.where("[workspaceId+streamId+_sequenceNum]").between([WS, "s2", 10], [WS, "s2", 20]).delete()

    const seq = "[workspaceId+streamId+_sequenceNum]"
    const reads = (db: ThreaDatabase) =>
      Promise.all([
        db.events.where(seq).between([WS, "s1", 3], [WS, "s1", 12]).toArray(),
        db.events
          .where(seq)
          .between([WS, "s1", Dexie.minKey], [WS, "s1", Dexie.maxKey])
          .reverse()
          .limit(4)
          .primaryKeys(),
        db.events.where("[workspaceId+streamId]").equals([WS, "s2"]).count(),
        db.events.count(),
        db.events.get([WS, "a0005"]),
        db.events.bulkGet([
          [WS, "a0001"],
          [WS, "a0007"],
          [WS, "b3"],
        ]),
        db.events.where("_status").anyOf(["failed", "pending"]).primaryKeys(),
        db.events.where(seq).between([WS, "s1", 0], [WS, "s1", Infinity]).offset(700).limit(3).toArray(),
        db.events.orderBy("[workspaceId+streamId]").uniqueKeys(),
        db.events.orderBy("[workspaceId+streamId]").reverse().uniqueKeys(),
        db.events.filter((row) => row._sequenceNum % 250 === 1).primaryKeys(),
        db.events.where("[workspaceId+payload.messageId]").anyOf([WS, "msg_a0900"], [WS, "msg_b2"]).toArray(),
        db.events.where("[workspaceId+streamId+eventType]").equals([WS, "s1", "reaction_added"]).reverse().keys(),
        db.transaction("r", db.events, async () => {
          const first = await db.events.get([WS, "a0002"])
          const total = await db.events.where("[workspaceId+streamId]").equals([WS, "s1"]).count()
          return { first: first?.id, total }
        }),
      ])

    const before = sqliteReads()
    const served = await reads(database)
    const servedBySqlite = sqliteReads() - before
    expect({ served, servedBySqlite: servedBySqlite >= 15 }).toEqual({
      served: await reads(plainDatabase(name)),
      servedBySqlite: true,
    })
  })

  it("reads a write back once it resolves, and after it commits when not awaited", async () => {
    const { database, mirror, log } = openMirrored()
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    log.length = 0
    await database.events.put(event("rw", "s1", 1))
    const awaited = await database.events.get([WS, "rw"])
    void database.events.put(event("rw2", "s1", 2))
    const notAwaited = await database.events.get([WS, "rw2"])
    const order = log.filter((type) => type === "apply" || type === "get")
    expect({ awaited: awaited?.id, notAwaited: notAwaited?.id, order }).toEqual({
      awaited: "rw",
      notAwaited: "rw2",
      order: ["apply", "get", "apply", "get"],
    })
  })

  it("keeps live queries current with this tab's writes", async () => {
    const { database, mirror } = openMirrored()
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.bulkPut([event("e1", "s1", 1), event("e2", "s1", 2)])
    let seen: string[] | null = null
    const subscription = liveQuery(() =>
      database.events.where("[workspaceId+streamId]").equals([WS, "s1"]).toArray()
    ).subscribe((rows) => (seen = rows.map((row) => row.id)))
    owned.push(() => subscription.unsubscribe())
    await until(() => seen?.length === 2, "the first result")
    await database.events.put(event("e3", "s1", 3))
    await until(() => seen?.includes("e3") === true, "the put")
    await database.events.delete([WS, "e1"])
    await until(() => seen?.includes("e1") === false, "the delete")
    expect(seen).toEqual(["e2", "e3"])
  })

  it("re-runs the owner's live queries once a follower tab's write reaches SQLite", async () => {
    const owner = openMirrored()
    await owner.database.open()
    await until(() => owner.mirror.servesReads([EVENTS]), "the owner to serve reads")
    const follower = openMirrored({ bus: owner.bus, name: owner.name, sqlite: owner.sqlite })
    await follower.database.open()
    const capture = new PerfCapture()
    armPerfCapture(capture)
    let seen: string[] = []
    const subscription = liveQuery(() => owner.database.events.toCollection().primaryKeys()).subscribe(
      (keys) => (seen = keys.map((key) => key[1]))
    )
    owned.push(() => subscription.unsubscribe())
    await settle()
    await follower.database.events.put(event("from-follower", "s1", 1))
    await until(() => seen.includes("from-follower"), "the follower's row in the owner's live query")
    const followerRead = await follower.database.events.get([WS, "from-follower"])
    expect({ followerRead: followerRead?.id, fallbacks: counted(capture, "sqlite.readFallback") }).toEqual({
      followerRead: "from-follower",
      fallbacks: 1,
    })
  })

  it("aborts an emulated transaction as IndexedDB aborts a native one", async () => {
    const { database, mirror, name } = openMirrored()
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    const abort = async (db: ThreaDatabase) => {
      let abortEvents = 0
      const error = await db
        .transaction("r", db.events, async (tx) => {
          tx.on("abort", () => abortEvents++)
          await db.events.get([WS, "x"])
          tx.abort()
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
        .catch((caught: Error) => caught.name)
      return { error, abortEvents }
    }
    expect(await abort(database)).toEqual(await abort(plainDatabase(name)))
  })

  it("answers a read SQLite fails from IndexedDB, then keeps that store on IndexedDB", async () => {
    let failing = false
    const { database, mirror, sqliteReads } = openMirrored({ failReads: () => failing })
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.put(event("e1", "s1", 1))
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const logged = silenceErrors()
    failing = true
    const failedOver = await database.events.filter((row) => row.streamId === "s1").primaryKeys()
    const readsBefore = sqliteReads()
    const after = await database.events.get([WS, "e1"])
    expect({
      failedOver,
      after: after?.id,
      trusted: mirror.trusts(EVENTS),
      sqliteReadsAfter: sqliteReads() - readsBefore,
      marked: counted(capture, "sqlite.readFallback") > 0,
      logged: logged(),
    }).toEqual({
      failedOver: [[WS, "e1"]],
      after: "e1",
      trusted: false,
      sqliteReadsAfter: 0,
      marked: true,
      logged: true,
    })
  })

  it("serves the first reads of a boot from SQLite while its worker is still opening", async () => {
    const previous = await previousSession()
    const nativeReadonly = spyNativeReadonly()
    const worker = gate()
    const { database, sqliteReads } = openMirrored({
      name: previous.name,
      sqlite: previous.sqlite,
      owner: OWNER,
      workerStarted: worker.opened,
    })
    let answered = false
    const reads = readEvents(database).then((result) => {
      answered = true
      return result
    })
    await settle()
    const answeredBeforeWorker = answered
    worker.open()
    const served = await reads
    expect({
      served,
      answeredBeforeWorker,
      nativeReadonly: nativeReadonly(),
      // The ownership check at open, then both reads.
      sqliteReads: sqliteReads(),
    }).toEqual({ served: previous.expected, answeredBeforeWorker: false, nativeReadonly: 0, sqliteReads: 3 })
  })

  it("answers boot reads from IndexedDB when the worker fails to open", async () => {
    const previous = await previousSession()
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const logged = silenceErrors()
    const worker = gate()
    const { database, sqliteReads } = openMirrored({
      name: previous.name,
      sqlite: previous.sqlite,
      workerStarted: worker.opened,
      failOpen: true,
    })
    const reads = readEvents(database)
    await settle()
    worker.open()
    expect({
      served: await reads,
      sqliteReads: sqliteReads(),
      marked: counted(capture, "sqlite.readFallback") > 0,
      logged: logged(),
    }).toEqual({ served: previous.expected, sqliteReads: 0, marked: true, logged: true })
  })

  it("answers a DBCore query limit of 0 as Dexie's IndexedDB core does, with no rows", async () => {
    const { database, mirror, name, sqliteReads } = openMirrored()
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.bulkPut([event("e1", "s1", 1), event("e2", "s1", 2)])
    const limitZero = (db: ThreaDatabase) =>
      db.transaction("r", db.events, () => {
        const table = db.core.table(EVENTS)
        return table.query({
          trans: Dexie.currentTransaction.idbtrans as never,
          values: false,
          limit: 0,
          query: { index: table.schema.primaryKey, range: { type: 3 } as DBCoreKeyRange },
        })
      })
    const before = sqliteReads()
    const served = await limitZero(database)
    expect({ served, bySqlite: sqliteReads() - before }).toEqual({
      served: await limitZero(plainDatabase(name)),
      bySqlite: 1,
    })
  })

  it("keeps a commit from landing between the reads of one transaction, as IndexedDB would", async () => {
    const firstRead = gate()
    let held: Promise<void> | undefined
    let readArrived = false
    const { database, mirror } = openMirrored({
      beforeRequest: (request) => {
        if (request.type !== "count" || !held) return undefined
        readArrived = true
        return held
      },
    })
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.put(event("e1", "s1", 1))
    held = firstRead.opened
    const inTransaction = database.transaction("r", database.events, async () => {
      const first = await database.events.count()
      const second = await database.events.count()
      const written = await database.events.get([WS, "e2"])
      return { first, second, written: written?.id ?? null }
    })
    await until(() => readArrived, "the transaction's first read at the worker")
    await database.events.put(event("e2", "s1", 2))
    firstRead.open()
    expect({ inTransaction: await inTransaction, after: await database.events.count() }).toEqual({
      inTransaction: { first: 1, second: 1, written: null },
      after: 2,
    })
  })

  it("serves a write from a handle with no mirror once the owner hears it, re-running live queries", async () => {
    const { database, mirror, name, bus, sqliteReads } = openMirrored()
    bus.hearAnnouncements(name)
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.put(event("e1", "s1", 1))
    let seen: string[] = []
    const subscription = liveQuery(() => database.events.toCollection().primaryKeys()).subscribe(
      (keys) => (seen = keys.map((key) => key[1]))
    )
    owned.push(() => subscription.unsubscribe())
    await until(() => seen.length === 1, "the first result")
    await plainDatabase(name).events.put(event("unmirrored", "s1", 2))
    await until(() => seen.includes("unmirrored"), "the live query to see the write")
    const readsBefore = sqliteReads()
    expect({
      seen,
      servedBySqlite: (await database.events.toCollection().primaryKeys()).map((key) => key[1]),
      stillServing: mirror.servesReads([EVENTS]) && sqliteReads() > readsBefore,
    }).toEqual({ seen: ["e1", "unmirrored"], servedBySqlite: ["e1", "unmirrored"], stillServing: true })
  })

  it("answers from IndexedDB and stops serving reads when a SQLite read never returns", async () => {
    let hang = false
    const { database, mirror } = openMirrored({
      beforeRequest: (request) => (hang && READS.has(request.type) ? new Promise<void>(() => {}) : undefined),
      deadlines: { readMs: 50 },
    })
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.put(event("e1", "s1", 1))
    const capture = new PerfCapture()
    armPerfCapture(capture)
    silenceErrors()
    hang = true
    const read = await database.events.get([WS, "e1"])
    expect({
      read: read?.id,
      serves: mirror.servesReads([EVENTS]),
      fellBack: counted(capture, "sqlite.readFallback") > 0,
      failed: counted(capture, "sqlite.mirrorFailure") > 0,
    }).toEqual({ read: "e1", serves: false, fellBack: true, failed: true })
  })

  it(
    "reads the rest of a cursor from one native cursor, past every row SQLite yielded, when a later page fails",
    { timeout: 60_000 },
    async () => {
      const seeded = await cursorSession()
      silenceErrors()
      for (const spec of CURSOR_CASES) {
        let laterPages = 0
        const { database, mirror } = openMirrored({
          name: seeded.name,
          sqlite: seeded.sqlite,
          failReads: (request) => {
            if (request.type !== "query" || request.query.from === null) return false
            laterPages++
            return true
          },
        })
        await database.open()
        await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
        const served = await iterateCursor(database, spec)
        expect({ spec: spec.name, served, laterPageFailed: laterPages > 0, trusted: mirror.trusts(EVENTS) }).toEqual({
          spec: spec.name,
          served: await iterateCursor(plainDatabase(seeded.name), spec),
          laterPageFailed: true,
          trusted: false,
        })
        database.close()
      }
    }
  )

  it("reads a commit that lands between a SQLite page and the native rest only past the rows already yielded", async () => {
    const seeded = await cursorSession()
    silenceErrors()
    const writer = plainDatabase(seeded.name)
    await writer.open()
    const { database, mirror } = openMirrored({
      name: seeded.name,
      sqlite: seeded.sqlite,
      beforeRequest: async (request) => {
        if (request.type !== "query" || request.query.from === null) return
        await writer.transaction("rw", writer.events, async () => {
          await writer.events.bulkPut([event("a0000x", "s0000", 1), event("a0950x", "s0475", 1)])
          await writer.events.delete([WS, "a0700"])
        })
      },
      failReads: (request) => request.type === "query" && request.query.from !== null,
    })
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    const spec = CURSOR_CASES[0]
    const before = (await iterateCursor(writer, spec)).map(([, primaryKey]) => primaryKey)
    const served = (await iterateCursor(database, spec)).map(([, primaryKey]) => primaryKey)
    const yielded = before.slice(0, 500)
    const lastYielded = (yielded[499] as string[])[1]
    const after = (await iterateCursor(writer, spec)).map(([, primaryKey]) => primaryKey)
    expect(served).toEqual([...yielded, ...after.filter((key) => (key as string[])[1] > lastYielded)])
    expect(served.map((key) => (key as string[])[1])).toEqual(expect.arrayContaining(["a0950x"]))
    expect(served.map((key) => (key as string[])[1])).not.toEqual(expect.arrayContaining(["a0000x", "a0700"]))
  })

  it("reads the rest of a transaction from one native transaction once a read falls back", async () => {
    let failing = false
    // Before open: Dexie's IndexedDB core binds `transaction` when it opens.
    const nativeReadonly = spyNativeReadonly()
    const { database, mirror, name, sqliteReads } = openMirrored({
      failReads: (request) => failing && request.type === "get",
    })
    await database.open()
    await until(() => mirror.servesReads([EVENTS]), "the mirror to serve reads")
    await database.events.put(event("e1", "s1", 1))
    const writer = plainDatabase(name)
    await writer.open()
    silenceErrors()
    await settle()
    const nativeBefore = nativeReadonly()
    const readsBefore = sqliteReads()
    failing = true
    let written: Promise<unknown> = Promise.resolve()
    const inTransaction = await database.transaction("r", database.events, async () => {
      const got = await database.events.get([WS, "e1"])
      written = Dexie.ignoreTransaction(() => writer.events.put(event("e2", "s1", 2)))
      const count = await database.events.count()
      const keys = await database.events.toCollection().primaryKeys()
      return { got: got?.id, count, keys: keys.map((key) => key[1]) }
    })
    await written
    expect({
      inTransaction,
      nativeReadonly: nativeReadonly() - nativeBefore,
      sqliteReads: sqliteReads() - readsBefore,
    }).toEqual({
      inTransaction: { got: "e1", count: 1, keys: ["e1"] },
      nativeReadonly: 1,
      sqliteReads: 0,
    })
  })

  it("answers boot reads from IndexedDB when the worker never answers", async () => {
    const previous = await previousSession()
    const capture = new PerfCapture()
    armPerfCapture(capture)
    silenceErrors()
    const { database, mirror } = openMirrored({
      name: previous.name,
      sqlite: previous.sqlite,
      owner: OWNER,
      workerStarted: new Promise<void>(() => {}),
      deadlines: { claimMs: 50, workerMs: 200 },
    })
    const served = await readEvents(database)
    const servesAfterDeadline = mirror.servesReads([EVENTS])
    await until(() => counted(capture, "sqlite.mirrorFailure") >= 2, "the worker deadline")
    expect({ served, servesAfterDeadline, fellBack: counted(capture, "sqlite.readFallback") > 0 }).toEqual({
      served: previous.expected,
      servesAfterDeadline: false,
      fellBack: true,
    })
  })

  it("answers boot reads from IndexedDB once the claim makes this tab a follower", async () => {
    const previous = await previousSession()
    const bus = createBus()
    bus.coordination().claim(() => {})
    const logged = silenceErrors()
    const claim = gate()
    const { database, mirror, log } = openMirrored({
      name: previous.name,
      sqlite: previous.sqlite,
      bus,
      claimAnswered: claim.opened,
    })
    const reads = readEvents(database)
    await settle()
    const servedWhilePending = mirror.servesReads([EVENTS])
    claim.open()
    expect({ served: await reads, servedWhilePending, workerRequests: log, logged: logged() }).toEqual({
      served: previous.expected,
      servedWhilePending: true,
      workerRequests: [],
      logged: true,
    })
  })

  describe("while a transaction holds writes to its stores", () => {
    /** Opens a mirror whose next `count` read waits at the worker, so the transaction issuing it holds applies to its stores. */
    async function heldRead(options: MirroredOptions = {}) {
      const read = gate()
      let holdNext = false
      let held = false
      const opened = openMirrored({
        ...options,
        beforeRequest: (request) => {
          const before = options.beforeRequest?.(request)
          if (!holdNext || request.type !== "count") return before
          holdNext = false
          held = true
          return read.opened
        },
      })
      const { database, mirror } = opened
      await database.open()
      await until(() => mirroredStores(database).every((store) => mirror.trusts(store)), "a full backfill")
      await database.events.put(event("e1", "s1", 1))
      holdNext = true
      const holding = database.transaction("r", database.events, async () => [
        await database.events.count(),
        await database.events.count(),
      ])
      await until(() => held, "the holding read at the worker")
      return { ...opened, holding, release: read.open }
    }

    it("serves other stores at once and a store with a held apply once it is released, in commit order", async () => {
      const { database, holding, release } = await heldRead()
      await database.events.put(event("e2", "s1", 2))
      await database.syncCursors.put({ key: "c1", value: "1", updatedAt: 1 } as never)
      const cursors = database.transaction("r", database.syncCursors, () => database.syncCursors.count())
      let cursorsAnswered = false
      void cursors.then(() => (cursorsAnswered = true))
      const pending = await database.transaction("r", database.pendingMessages, () => database.pendingMessages.count())
      await settle()
      const cursorsBeforeRelease = cursorsAnswered
      release()
      expect({ holding: await holding, pending, cursorsBeforeRelease, cursors: await cursors }).toEqual({
        holding: [1, 1],
        pending: 0,
        cursorsBeforeRelease: false,
        cursors: 1,
      })
    })

    it("aborts a transaction waiting for the held apply, and the apply still lands", async () => {
      const { database, mirror, holding, release } = await heldRead()
      await database.events.put(event("e2", "s1", 2))
      let waiting: Transaction | undefined
      const aborted = database
        .transaction("r", database.events, (tx) => {
          waiting = tx
          return database.events.count()
        })
        .catch((error: Error) => error.name)
      await settle()
      waiting!.abort()
      const abortedBeforeRelease = await aborted
      release()
      expect({
        holding: await holding,
        abortedBeforeRelease,
        after: await database.events.count(),
        serves: mirror.servesReads([EVENTS]),
      }).toEqual({ holding: [1, 1], abortedBeforeRelease: "AbortError", after: 2, serves: true })
    })

    for (const ending of ["fails", "stops"] as const) {
      it(`drops the held apply when the mirror ${ending}, leaving its store behind for the next owner`, async () => {
        silenceErrors()
        let breakWorker = false
        const { database, mirror, sqlite, log, holding, release } = await heldRead({
          beforeRequest: (request) => {
            if (breakWorker && request.type === "get") throw new Error("The worker is gone")
            return undefined
          },
        })
        await database.events.put(event("e2", "s1", 2))
        const sentBefore = log.length
        if (ending === "fails") {
          breakWorker = true
          await database.syncCursors.get("missing")
        } else {
          await mirror.stop()
        }
        release()
        expect({
          holding: await holding,
          appliedAfter: log.slice(sentBefore).filter((type) => type === "apply"),
          behind: await behind(database, sqlite),
          serves: mirror.servesReads([EVENTS]),
        }).toEqual({ holding: [2, 2], appliedAfter: [], behind: [EVENTS], serves: false })
      })
    }
  })

  it("sends a read ahead of queued writes to other stores and right behind the last one to its own", async () => {
    const sent: string[] = []
    const applyGate = gate()
    let holdApply = false
    const { database, mirror } = openMirrored({
      deadlines: { readMs: 50 },
      beforeRequest: (request) => {
        if (request.type === "apply") sent.push(`apply ${request.batch.map((mutation) => mutation.store).join()}`)
        else if (request.type === "count") sent.push(`count ${request.store}`)
        if (!holdApply || request.type !== "apply") return undefined
        holdApply = false
        return applyGate.opened
      },
    })
    await database.open()
    await until(() => mirroredStores(database).every((store) => mirror.trusts(store)), "a full backfill")
    await settle()
    sent.length = 0
    holdApply = true
    await database.syncCursors.put({ key: "c1", value: "1", updatedAt: 1 } as never)
    await database.pendingMessages.put({ clientId: "p1", streamId: "s1", createdAt: 1 } as never)
    await database.events.put(event("e1", "s1", 1))
    await database.pendingMessages.put({ clientId: "p2", streamId: "s1", createdAt: 2 } as never)
    const events = database.events.count()
    const personas = database.personas.count()
    // Longer than readMs: time spent queued, not sent, is no silence.
    await new Promise((resolve) => setTimeout(resolve, 150))
    applyGate.open()
    const personasStore = database.personas.name
    expect({
      sent,
      events: await events,
      personas: await personas,
      serves: mirror.servesReads([EVENTS]),
    }).toEqual({
      sent: [
        "apply syncCursors",
        `count ${personasStore}`,
        "apply pendingMessages",
        `apply ${EVENTS}`,
        `count ${EVENTS}`,
        "apply pendingMessages",
      ],
      events: 1,
      personas: 0,
      serves: true,
    })
  })

  it("reads a follower's write back from SQLite as soon as it commits", async () => {
    const owner = openMirrored()
    await owner.database.open()
    await until(() => owner.mirror.servesReads([EVENTS]), "the owner to serve reads")
    const follower = openMirrored({ bus: owner.bus, name: owner.name, sqlite: owner.sqlite })
    await follower.database.open()
    await settle()
    const readsBefore = owner.sqliteReads()
    await follower.database.events.put(event("from-follower", "s1", 1))
    const read = await owner.database.events.get([WS, "from-follower"])
    expect({ read: read?.id, bySqlite: owner.sqliteReads() - readsBefore }).toEqual({
      read: "from-follower",
      bySqlite: 1,
    })
  })

  it("answers from IndexedDB and stops serving a store when a follower's write cannot reach SQLite in time", async () => {
    const owner = openMirrored({ deadlines: { readMs: 50 } })
    await owner.database.open()
    await until(() => owner.mirror.servesReads([EVENTS]), "the owner to serve reads")
    const follower = openMirrored({ bus: owner.bus, name: owner.name, sqlite: owner.sqlite })
    await follower.database.open()
    const blocking = plainDatabase(owner.name)
    await blocking.open()
    await settle()
    const capture = new PerfCapture()
    armPerfCapture(capture)
    silenceErrors()
    owner.bus.hold()
    await follower.database.events.put(event("late", "s1", 1))
    // The owner's re-read of the follower's rows queues behind this writer.
    const blocked = occupy(blocking.backendDB(), EVENTS, 300)
    owner.bus.release()
    const read = await owner.database.events.get([WS, "late"])
    await blocked
    expect({
      read: read?.id,
      trusted: owner.mirror.trusts(EVENTS),
      failed: counted(capture, "sqlite.mirrorFailure") > 0,
    }).toEqual({ read: "late", trusted: false, failed: true })
  })
})

describe("shadow SQLite mirror", () => {
  it("counts a follower's write as a change when it arrives and again once SQLite holds it", async () => {
    const owner = openMirrored({ mode: "shadow" })
    await owner.database.open()
    await until(() => owner.mirror.trusts(EVENTS), "the mirror to trust events")
    const follower = openMirrored({ mode: "shadow", bus: owner.bus, name: owner.name, sqlite: owner.sqlite })
    await follower.database.open()
    await settle()
    const before = owner.mirror.changes(EVENTS)
    owner.bus.hold()
    await follower.database.events.put(event("from-follower", "s1", 1))
    owner.bus.release()
    const onArrival = owner.mirror.changes(EVENTS) - before
    await settle()
    expect({ onArrival, onceApplied: owner.mirror.changes(EVENTS) - before }).toEqual({ onArrival: 1, onceApplied: 2 })
  })

  it("answers from IndexedDB and counts a read SQLite answers differently", async () => {
    const { database, mirror, sqlite } = openMirrored({ mode: "shadow" })
    await database.open()
    await until(() => mirror.trusts(EVENTS), "the mirror to trust events")
    await database.events.put(event("e1", "s1", 1))
    await settle()
    sqlite.exec(`UPDATE "s_${EVENTS}" SET v = ?`, { bind: [encodeValue(event("e1", "s1", 99))] })
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const read = await database.events.get([WS, "e1"])
    await settle()
    expect({
      sequence: read?._sequenceNum,
      emulated: mirror.servesReads([EVENTS]),
      mismatches: counted(capture, "sqlite.readMismatch"),
      timed: counted(capture, "sqlite.readMs"),
    }).toEqual({ sequence: 1, emulated: false, mismatches: 1, timed: 1 })
  })
})
