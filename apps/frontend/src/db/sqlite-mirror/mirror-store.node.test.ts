import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { encodeKey, encodeRange } from "./key-codec"
import { MirrorStore, type MirrorEntry, type MirrorMutation, type MirrorStoreSchema } from "./mirror-store"
import { encodeValue } from "./value-codec"

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>

let sqlite3: Sqlite3
let db: Database
let store: MirrorStore

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

const plain = (...names: string[]): MirrorStoreSchema[] => names.map((name) => ({ name, indexes: [] }))

beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:")
  store = new MirrorStore(db)
  store.ensureSchema(plain("a", "b"), 1)
})

afterEach(() => {
  db.close()
})

const entry = (key: IDBValidKey, value: string): MirrorEntry => ({ key: encodeKey(key), value })
const put = (name: string, ...entries: MirrorEntry[]): MirrorMutation => ({ store: name, op: "put", entries })
const del = (name: string, ...keys: IDBValidKey[]): MirrorMutation => ({
  store: name,
  op: "delete",
  keys: keys.map(encodeKey),
})
const delRange = (name: string, lower: number, upper: number, lowerOpen = false): MirrorMutation => ({
  store: name,
  op: "deleteRange",
  range: encodeRange({ type: 2, lower, upper, lowerOpen, upperOpen: false }),
})

function rows(name: string): string[] {
  return db.selectArrays(`SELECT v FROM "s_${name}" ORDER BY k`).map((row) => String(row[0]))
}

describe("MirrorStore", () => {
  it("applies put, delete and deleteRange in key order", () => {
    store.apply([put("a", entry(3, "c"), entry(1, "a"), entry(2, "b"), entry(4, "d"), entry(5, "e"))])
    store.apply([put("a", entry(1, "a2")), del("a", 2)])
    store.apply([delRange("a", 4, 5, true), put("b", entry("k", "other"))])
    expect({ a: rows("a"), b: rows("b") }).toEqual({ a: ["a2", "c", "d"], b: ["other"] })
  })

  it("deletes everything for an unbounded range", () => {
    store.apply([
      put("a", entry(1, "x"), entry(2, "y")),
      { store: "a", op: "deleteRange", range: { lowerOpen: false, upperOpen: false } },
    ])
    expect(rows("a")).toEqual([])
  })

  it("rolls the whole batch back when one statement fails", () => {
    const bad = { store: "a", op: "put", entries: [{ key: encodeKey(2), value: null }] } as unknown as MirrorMutation
    expect(() => store.apply([put("a", entry(1, "ok")), bad])).toThrow()
    expect(rows("a")).toEqual([])
  })

  it("rejects mutations for unknown stores", () => {
    expect(() => store.apply([put("nope", entry(1, "x"))])).toThrow(/Unknown mirrored store/)
  })

  describe("backfill", () => {
    it("lets a live put win over a stale chunk row and fills the rest", () => {
      store.beginBackfill("a")
      store.apply([put("a", entry(1, "live"))])
      store.backfillChunk("a", [entry(1, "stale"), entry(2, "old")])
      store.finishBackfill("a")
      expect({ rows: rows("a"), done: store.status().backfilled.includes("a") }).toEqual({
        rows: ["live", "old"],
        done: true,
      })
    })

    it("keeps a live-deleted key absent", () => {
      store.beginBackfill("a")
      store.apply([del("a", 1)])
      store.backfillChunk("a", [entry(1, "stale"), entry(2, "old")])
      store.finishBackfill("a")
      expect(rows("a")).toEqual(["old"])
    })

    it("skips chunk rows inside a range deleted during the backfill", () => {
      store.beginBackfill("a")
      store.backfillChunk("a", [entry(1, "one")])
      store.apply([delRange("a", 2, 4)])
      store.backfillChunk("a", [entry(2, "x"), entry(4, "y"), entry(5, "keep")])
      store.finishBackfill("a")
      expect(rows("a")).toEqual(["one", "keep"])
    })

    it("restarts cleanly and leaves other stores alone", () => {
      store.apply([put("b", entry(1, "b1"))])
      store.beginBackfill("a")
      store.backfillChunk("a", [entry(1, "x")])
      store.finishBackfill("a")
      store.beginBackfill("a")
      expect({ a: rows("a"), done: store.status().backfilled.includes("a"), b: rows("b") }).toEqual({
        a: [],
        done: false,
        b: ["b1"],
      })
    })

    it("persists backfill completion across a reopen with the same version", () => {
      store.beginBackfill("a")
      store.finishBackfill("a")
      const reopened = new MirrorStore(db)
      reopened.ensureSchema(plain("a", "b"), 1)
      expect(reopened.status().backfilled).toEqual(["a"])
    })
  })

  it("keeps data but drops trust when the IndexedDB version changes, and drops removed stores", () => {
    store.apply([put("a", entry(1, "x")), put("b", entry(1, "y"))])
    store.beginBackfill("a")
    store.finishBackfill("a")
    store.apply([put("a", entry(1, "x"))])
    const upgraded = new MirrorStore(db)
    upgraded.ensureSchema(plain("a", "c"), 2)
    const tables = db.selectValues(`SELECT name FROM sqlite_master WHERE name LIKE 's\\_%' ESCAPE '\\' ORDER BY name`)
    expect({ tables, a: rows("a"), backfilled: upgraded.status().backfilled }).toEqual({
      tables: ["s_a", "s_c"],
      a: ["x"],
      backfilled: [],
    })
  })

  describe("indexes", () => {
    const value = (record: Record<string, unknown>) => encodeValue(record)
    const schema = (keyPath: string | string[], multiEntry = false): MirrorStoreSchema[] => [
      { name: "a", indexes: [{ name: "idx", keyPath, multiEntry }] },
    ]
    const indexRows = () =>
      db
        .selectArrays(`SELECT ik, k FROM "i_a__idx" ORDER BY ik, k`)
        .map(([ik, k]) => [Array.from(ik as Uint8Array), Array.from(k as Uint8Array)])
    const expected = (...pairs: Array<[IDBValidKey, IDBValidKey]>) =>
      pairs.map(([ik, k]) => [Array.from(encodeKey(ik)), Array.from(encodeKey(k))])

    it("follows put, overwrite, delete and deleteRange", () => {
      store.ensureSchema(schema("tags", true), 1)
      store.apply([
        put("a", entry(1, value({ tags: ["x", "y", "x"] })), entry(2, value({ tags: "y" })), entry(3, value({}))),
      ])
      store.apply([put("a", entry(1, value({ tags: ["z"] })))])
      store.apply([del("a", 3), delRange("a", 2, 2)])
      expect(indexRows()).toEqual(expected(["z", 1]))
    })

    it("is rebuilt from stored values when its definition changes", () => {
      store.ensureSchema(schema("n"), 1)
      store.apply([put("a", entry(1, value({ n: 5, m: "q" }))), put("a", entry(2, value({ m: "p" })))])
      store.ensureSchema(schema("m"), 2)
      expect(indexRows()).toEqual(expected(["p", 2], ["q", 1]))
    })
  })

  describe("writers", () => {
    const commit = (seq: number, prev: Record<string, number>) => ({ writer: "w", seq, prev })

    it("holds a writer's commits only through the first one it has not received", () => {
      store.apply([put("a", entry(1, "x"))], commit(1, { a: 0 }))
      store.apply([put("a", entry(3, "z"))], commit(3, { a: 2 }))
      const beforeGap = store.status().writers
      store.apply([put("a", entry(2, "y"))], commit(2, { a: 1 }))
      expect({ beforeGap, after: store.status().writers }).toEqual({
        beforeGap: { w: { a: 1 } },
        after: { w: { a: 3 } },
      })
    })

    it("follows a commit past seqs the writer never committed", () => {
      store.apply([put("a", entry(1, "x"))], commit(2, { a: 0 }))
      store.apply([put("a", entry(1, "y"))], commit(5, { a: 2 }))
      expect(store.status().writers).toEqual({ w: { a: 5 } })
    })

    it("does not count a commit whose batch rolled back", () => {
      const bad = { store: "a", op: "put", entries: [{ key: encodeKey(2), value: null }] } as unknown as MirrorMutation
      expect(() => store.apply([bad], commit(1, { a: 0 }))).toThrow()
      store.apply([put("a", entry(1, "x"))], commit(2, { a: 1 }))
      expect(store.status().writers).toEqual({})
    })

    it("keeps what it holds across a reopen", () => {
      store.apply([put("a", entry(1, "x"))], commit(1, { a: 0 }))
      const reopened = new MirrorStore(db)
      reopened.ensureSchema(plain("a", "b"), 1)
      expect(reopened.status().writers).toEqual({ w: { a: 1 } })
    })

    it("forgets the writers named", () => {
      store.apply([put("a", entry(1, "x"))], commit(1, { a: 0 }))
      store.apply([put("a", entry(1, "x"))], { writer: "v", seq: 1, prev: { a: 0 } })
      store.forgetWriters(["w"])
      expect(store.status().writers).toEqual({ v: { a: 1 } })
    })

    it("chains each store on its own, so a gap in one leaves the other held", () => {
      store.apply([put("a", entry(1, "x")), put("b", entry(1, "x"))], commit(1, { a: 0, b: 0 }))
      store.apply([put("b", entry(2, "y"))], commit(3, { b: 1 }))
      store.apply([put("a", entry(3, "z"))], commit(4, { a: 2 }))
      expect(store.status().writers).toEqual({ w: { a: 1, b: 3 } })
    })

    it("holds a backfilled store through the marks it covered, joining commits applied during the backfill", () => {
      store.beginBackfill("a")
      store.apply([put("a", entry(1, "x"))], commit(7, { a: 4 }))
      store.finishBackfill("a", { w: 4, v: 2 })
      expect(store.status().writers).toEqual({ w: { a: 7 }, v: { a: 2 } })
    })
  })

  it("reset empties every table and forgets backfills and writers for the new incarnation", () => {
    store.beginBackfill("a")
    store.backfillChunk("a", [entry(1, "x")])
    store.finishBackfill("a")
    store.apply([put("b", entry(1, "y"))], { writer: "w", seq: 1, prev: { b: 0 } })
    const before = store.status().incarnation
    store.reset("idb-2")
    expect({ before, status: store.status(), a: rows("a"), b: rows("b") }).toEqual({
      before: null,
      status: { backfilled: [], writers: {}, incarnation: "idb-2" },
      a: [],
      b: [],
    })
  })
})
