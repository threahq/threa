import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { encodeKey, encodeRange } from "./key-codec"
import { MirrorStore, type MirrorEntry, type MirrorMutation } from "./mirror-store"

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>

let sqlite3: Sqlite3
let db: Database
let store: MirrorStore

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:")
  store = new MirrorStore(db)
  store.ensureSchema(["a", "b"], 1)
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
      expect({ rows: rows("a"), done: store.isBackfilled("a") }).toEqual({ rows: ["live", "old"], done: true })
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
      expect({ a: rows("a"), done: store.isBackfilled("a"), b: rows("b") }).toEqual({ a: [], done: false, b: ["b1"] })
    })

    it("persists backfill completion across a reopen with the same version", () => {
      store.beginBackfill("a")
      store.finishBackfill("a")
      const reopened = new MirrorStore(db)
      reopened.ensureSchema(["a", "b"], 1)
      expect({ a: reopened.isBackfilled("a"), b: reopened.isBackfilled("b") }).toEqual({ a: true, b: false })
    })
  })

  it("wipes data and backfill state when the IndexedDB version changes", () => {
    store.apply([put("a", entry(1, "x"))])
    store.beginBackfill("a")
    store.finishBackfill("a")
    store.apply([put("a", entry(1, "x"))])
    const upgraded = new MirrorStore(db)
    upgraded.ensureSchema(["a", "c"], 2)
    const tables = db.selectValues(`SELECT name FROM sqlite_master WHERE name LIKE 's\\_%' ESCAPE '\\' ORDER BY name`)
    expect({ tables, a: rows("a"), done: upgraded.isBackfilled("a") }).toEqual({
      tables: ["s_a", "s_c"],
      a: [],
      done: false,
    })
  })

  it("wipe drops every table", () => {
    store.apply([put("a", entry(1, "x"))])
    store.wipe()
    expect(db.selectValues(`SELECT name FROM sqlite_master WHERE type = 'table'`)).toEqual([])
  })
})
