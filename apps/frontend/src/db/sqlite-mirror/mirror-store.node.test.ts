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
  store.ensureSchema(plain("a", "b"))
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

function apply(batch: MirrorMutation[]): void {
  db.transaction(() => {
    for (const mutation of batch) store.write(mutation)
  })
}

describe("MirrorStore", () => {
  it("applies put, delete and deleteRange in key order", () => {
    apply([put("a", entry(3, "c"), entry(1, "a"), entry(2, "b"), entry(4, "d"), entry(5, "e"))])
    apply([put("a", entry(1, "a2")), del("a", 2)])
    apply([delRange("a", 4, 5, true), put("b", entry("k", "other"))])
    expect({ a: rows("a"), b: rows("b") }).toEqual({ a: ["a2", "c", "d"], b: ["other"] })
  })

  it("deletes everything for an unbounded range", () => {
    apply([
      put("a", entry(1, "x"), entry(2, "y")),
      { store: "a", op: "deleteRange", range: { lowerOpen: false, upperOpen: false } },
    ])
    expect(rows("a")).toEqual([])
  })

  it("rolls the whole batch back when one statement fails", () => {
    const bad = { store: "a", op: "put", entries: [{ key: encodeKey(2), value: null }] } as unknown as MirrorMutation
    expect(() => apply([put("a", entry(1, "ok")), bad])).toThrow()
    expect(rows("a")).toEqual([])
  })

  it("rejects mutations for unknown stores", () => {
    expect(() => apply([put("nope", entry(1, "x"))])).toThrow(/Unknown mirrored store/)
  })

  it("empties the stores a backfill begins on and fills them from its chunks, leaving other stores alone", () => {
    apply([put("a", entry(1, "stale")), put("b", entry(1, "b1"))])
    store.beginBackfill(["a"])
    store.backfillChunk("a", [entry(2, "two"), entry(3, "three")])
    expect({ a: rows("a"), b: rows("b") }).toEqual({ a: ["two", "three"], b: ["b1"] })
  })

  it("keeps data across a reopen with a new schema, and drops removed stores", () => {
    apply([put("a", entry(1, "x")), put("b", entry(1, "y"))])
    const upgraded = new MirrorStore(db)
    upgraded.ensureSchema(plain("a", "c"))
    const tables = db.selectValues(`SELECT name FROM sqlite_master WHERE name LIKE 's\\_%' ESCAPE '\\' ORDER BY name`)
    expect({ tables, a: rows("a") }).toEqual({ tables: ["s_a", "s_c"], a: ["x"] })
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
      store.ensureSchema(schema("tags", true))
      apply([put("a", entry(1, value({ tags: ["x", "y", "x"] })), entry(2, value({ tags: "y" })), entry(3, value({})))])
      apply([put("a", entry(1, value({ tags: ["z"] })))])
      apply([del("a", 3), delRange("a", 2, 2)])
      expect(indexRows()).toEqual(expected(["z", 1]))
    })

    it("is rebuilt from stored values when its definition changes", () => {
      store.ensureSchema(schema("n"))
      apply([put("a", entry(1, value({ n: 5, m: "q" }))), put("a", entry(2, value({ m: "p" })))])
      store.ensureSchema(schema("m"))
      expect(indexRows()).toEqual(expected(["p", 2], ["q", 1]))
    })

    it("is emptied with its store by a backfill and indexes the rows the backfill copies", () => {
      store.ensureSchema(schema("n"))
      apply([put("a", entry(1, value({ n: 5 })))])
      store.beginBackfill(["a"])
      store.backfillChunk("a", [entry(2, value({ n: 7 }))])
      expect(indexRows()).toEqual(expected([7, 2]))
    })
  })
})
