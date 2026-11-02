import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import type { DBCoreKeyRange } from "dexie"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { decodeKey, encodeKey, encodeRange } from "./key-codec"
import { MirrorStore, type MirrorQuery, type MirrorStoreSchema } from "./mirror-store"
import { decodeValue, encodeValue } from "./value-codec"

// IndexedDB (fake-indexeddb) is the oracle: every read must come back exactly as it answers.

const STORE = "items"
const INDEXES = [
  { name: "byGroup", keyPath: "group", multiEntry: false },
  { name: "[group+rank]", keyPath: ["group", "rank"], multiEntry: false },
  { name: "byTags", keyPath: "tags", multiEntry: true },
  { name: "byScore", keyPath: "meta.score", multiEntry: false },
  { name: "byTagCount", keyPath: "tags.length", multiEntry: false },
]
const SCHEMA: MirrorStoreSchema[] = [{ name: STORE, indexes: INDEXES }]

function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const rand = random(20261102)
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]
const GROUPS = ["a", "b", "c", "", "d\u0000e"]
const TAGS: unknown[] = ["x", "y", "z", 1, 2, [1, "x"], true, null, { no: 1 }, new Date(5)]

function makeRow(id: IDBValidKey): Record<string, unknown> {
  const row: Record<string, unknown> = { id }
  if (rand() < 0.9) row.group = pick(GROUPS)
  if (rand() < 0.8) row.rank = rand() < 0.2 ? new Date(Math.floor(rand() * 4) * 1000) : Math.floor(rand() * 6) - 2
  if (rand() < 0.85) row.tags = Array.from({ length: Math.floor(rand() * 5) }, () => pick(TAGS))
  else if (rand() < 0.5) row.tags = pick(["solo", 7, false])
  if (rand() < 0.7) row.meta = { score: pick(["high", false, -1, 0, 0.5, 1.5, 2, 3, 4.5, 4.5]) }
  row.payload = { bytes: new Uint8Array([Math.floor(rand() * 255), 0, 1]), when: new Date(Math.floor(rand() * 1e12)) }
  return row
}

// fake-indexeddb clones typed arrays through another realm's constructor; a browser hands back its own.
function sameRealm(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  if (value instanceof Date || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sameRealm)
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sameRealm(v)]))
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let sqlite: Database
let idb: IDBDatabase
let mirror: MirrorStore
const keyPool: IDBValidKey[] = []

beforeAll(async () => {
  const sqlite3 = await sqlite3InitModule()
  sqlite = new sqlite3.oo1.DB(":memory:")
  mirror = new MirrorStore(sqlite)
  mirror.ensureSchema(SCHEMA, 1)
  const open = indexedDB.open(`read_engine_${Date.now()}`, 1)
  open.onupgradeneeded = () => {
    const store = open.result.createObjectStore(STORE, { keyPath: "id" })
    for (const index of INDEXES) store.createIndex(index.name, index.keyPath, { multiEntry: index.multiEntry })
  }
  idb = await request(open)

  const rows = Array.from({ length: 400 }, (_, i) => makeRow(i % 3 === 0 ? `k${i}` : i - 100))
  const tx = idb.transaction(STORE, "readwrite")
  for (const row of rows) tx.objectStore(STORE).put(row)
  await new Promise((resolve) => (tx.oncomplete = resolve))
  mirror.apply([
    {
      store: STORE,
      op: "put",
      entries: rows.map((row) => ({ key: encodeKey(row.id as IDBValidKey), value: encodeValue(row) })),
    },
  ])
  // Overwrites and deletes after the first load, so stale index rows would show.
  const changed = rows.filter(() => rand() < 0.2).map((row) => makeRow(row.id as IDBValidKey))
  const deleted = rows.filter(() => rand() < 0.1).map((row) => row.id as IDBValidKey)
  const tx2 = idb.transaction(STORE, "readwrite")
  for (const row of changed) tx2.objectStore(STORE).put(row)
  for (const key of deleted) tx2.objectStore(STORE).delete(key)
  tx2.objectStore(STORE).delete(IDBKeyRange.bound(10, 20, true, false))
  await new Promise((resolve) => (tx2.oncomplete = resolve))
  mirror.apply([
    {
      store: STORE,
      op: "put",
      entries: changed.map((row) => ({ key: encodeKey(row.id as IDBValidKey), value: encodeValue(row) })),
    },
    { store: STORE, op: "delete", keys: deleted.map((key) => encodeKey(key)) },
    {
      store: STORE,
      op: "deleteRange",
      range: encodeRange({ type: 2, lower: 10, upper: 20, lowerOpen: true, upperOpen: false }),
    },
  ])

  keyPool.push(
    ...rows.map((row) => row.id as IDBValidKey),
    ...GROUPS,
    -Infinity,
    0,
    2.5,
    "k5",
    ["a"],
    ["b", 1],
    ["c", new Date(0)],
    "x",
    1
  )
})

afterAll(() => {
  sqlite.close()
  idb.close()
})

interface Case {
  index: string | null
  range: DBCoreKeyRange
  reverse: boolean
  unique: boolean
  values: boolean
  limit: number | null
}

function makeCase(): Case {
  const index = rand() < 0.25 ? null : pick(INDEXES).name
  const roll = rand()
  let range: Case["range"]
  if (roll < 0.15) range = { type: 3, lower: undefined, upper: undefined }
  else if (roll < 0.35) {
    const key = pick(keyPool)
    range = { type: 1, lower: key, upper: key }
  } else {
    let [lower, upper] = [rand() < 0.2 ? undefined : pick(keyPool), rand() < 0.2 ? undefined : pick(keyPool)]
    if (lower !== undefined && upper !== undefined && indexedDB.cmp(lower, upper) > 0) [lower, upper] = [upper, lower]
    // IndexedDB rejects an open bound on a single-key range.
    const point = lower !== undefined && upper !== undefined && indexedDB.cmp(lower, upper) === 0
    range = { type: 2, lower, upper, lowerOpen: !point && rand() < 0.5, upperOpen: !point && rand() < 0.5 }
  }
  return {
    index,
    range,
    reverse: rand() < 0.5,
    unique: index !== null && rand() < 0.3,
    values: rand() < 0.5,
    limit: rand() < 0.4 ? null : 1 + Math.floor(rand() * 25),
  }
}

function toIdbRange(range: Case["range"]): IDBKeyRange | null {
  if (range.type === 3) return null
  if (range.type === 1) return IDBKeyRange.only(range.lower)
  const { lower, upper, lowerOpen, upperOpen } = range
  if (lower === undefined) return upper === undefined ? null : IDBKeyRange.upperBound(upper, upperOpen)
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, lowerOpen)
  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen)
}

interface Row {
  key: unknown
  primaryKey: unknown
  value?: unknown
}

async function oracle(c: Case): Promise<{ rows: Row[]; count: number }> {
  const tx = idb.transaction(STORE, "readonly")
  const store = tx.objectStore(STORE)
  const source = c.index === null ? store : store.index(c.index)
  const direction = `${c.reverse ? "prev" : "next"}${c.unique ? "unique" : ""}` as IDBCursorDirection
  const rows: Row[] = []
  await new Promise<void>((resolve, reject) => {
    const req = source.openCursor(toIdbRange(c.range), direction)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || rows.length === c.limit) return resolve()
      rows.push(
        c.values
          ? { key: cursor.key, primaryKey: cursor.primaryKey, value: sameRealm(cursor.value) }
          : { key: cursor.key, primaryKey: cursor.primaryKey }
      )
      cursor.continue()
    }
  })
  const count = await request(source.count(toIdbRange(c.range) ?? undefined))
  return { rows, count }
}

function query(c: Case, from: MirrorQuery["from"] = null, limit = c.limit): MirrorQuery {
  return {
    index: c.index,
    range: encodeRange(c.range),
    reverse: c.reverse,
    unique: c.unique,
    values: c.values,
    limit,
    from,
  }
}

function decodeRows(rows: ReturnType<MirrorStore["query"]>): Row[] {
  return rows.map((row) => {
    const decoded: Row = { key: decodeKey(row.key), primaryKey: decodeKey(row.primaryKey) }
    if (row.value !== undefined) decoded.value = decodeValue(row.value)
    return decoded
  })
}

describe("SQLite read engine against IndexedDB", () => {
  it("answers 400 random queries and counts exactly as IndexedDB", { timeout: 20_000 }, async () => {
    const cases = Array.from({ length: 400 }, makeCase)
    let nonEmpty = 0
    for (const c of cases) {
      const expected = await oracle(c)
      const actual = {
        rows: decodeRows(mirror.query(STORE, query(c))),
        count: mirror.count(STORE, c.index, encodeRange(c.range)),
      }
      expect({ case: c, ...actual }).toEqual({ case: c, ...expected })
      if (expected.rows.length > 0) nonEmpty++
    }
    expect(nonEmpty).toBeGreaterThan(200)
  })

  it("pages through results from where the last page ended", { timeout: 20_000 }, async () => {
    for (const c of Array.from({ length: 150 }, makeCase)) {
      const pages: Row[] = []
      let from: MirrorQuery["from"] = null
      for (;;) {
        const page = mirror.query(STORE, query({ ...c, limit: null }, from, 7))
        pages.push(...decodeRows(page))
        if (page.length < 7) break
        const last = page[page.length - 1]
        from = { key: last.key, primaryKey: c.index === null || c.unique ? null : last.primaryKey, open: true }
      }
      const { rows } = await oracle({ ...c, limit: null })
      expect({ case: c, rows: pages }).toEqual({ case: c, rows })
    }
  })

  it("gets single and many rows, missing ones as undefined", async () => {
    const keys = [...keyPool.slice(0, 30), "missing", 9999]
    const tx = idb.transaction(STORE, "readonly")
    const expected = (await Promise.all(keys.map((key) => request(tx.objectStore(STORE).get(key))))).map(sameRealm)
    const many = mirror.getMany(
      STORE,
      keys.map((key) => encodeKey(key))
    )
    const single = keys.map((key) => mirror.get(STORE, encodeKey(key)))
    const decode = (values: Array<string | undefined>) =>
      values.map((v) => (v === undefined ? undefined : decodeValue(v)))
    expect({ many: decode(many), single: decode(single) }).toEqual({ many: expected, single: expected })
  })
})
