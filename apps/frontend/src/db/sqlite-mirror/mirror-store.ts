import type { Database } from "@sqlite.org/sqlite-wasm"
import { isKeyInRange, type EncodedRange } from "./key-codec"

export interface MirrorEntry {
  key: Uint8Array
  value: string
}

export type MirrorMutation =
  | { store: string; op: "put"; entries: MirrorEntry[] }
  | { store: string; op: "delete"; keys: Uint8Array[] }
  | { store: string; op: "deleteRange"; range: EncodedRange }

interface BackfillState {
  touchedKeys: Set<string>
  touchedRanges: EncodedRange[]
}

const META_TABLE = "_mirror_meta"
const VERSION_KEY = "idbVersion"
const STORE_NAME_PATTERN = /^[A-Za-z0-9_]+$/

function tableName(store: string): string {
  return `"s_${store}"`
}

function keyId(key: Uint8Array): string {
  return key.join(",")
}

export class MirrorStore {
  private readonly stores = new Set<string>()
  private readonly backfilled = new Set<string>()
  private readonly backfilling = new Map<string, BackfillState>()

  constructor(private readonly db: Database) {}

  ensureSchema(stores: string[], idbVersion: number): void {
    for (const store of stores) {
      if (!STORE_NAME_PATTERN.test(store)) throw new Error(`Invalid store name for mirroring: ${store}`)
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`)
    const stored = this.db.selectValue(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [VERSION_KEY])
    if (stored !== undefined && stored !== String(idbVersion)) {
      this.dropMirrorTables()
      this.db.exec(`DELETE FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)
    }
    this.db.transaction((db) => {
      db.exec({
        sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
        bind: [VERSION_KEY, String(idbVersion)],
      })
      for (const store of stores) {
        db.exec(`CREATE TABLE IF NOT EXISTS ${tableName(store)} (k BLOB PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`)
      }
    })
    this.stores.clear()
    this.backfilled.clear()
    this.backfilling.clear()
    for (const store of stores) this.stores.add(store)
    const rows = this.db.selectValues(`SELECT key FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)
    for (const row of rows) {
      const store = String(row).slice("backfilled:".length)
      if (this.stores.has(store)) this.backfilled.add(store)
    }
  }

  apply(batch: MirrorMutation[]): void {
    this.db.transaction((db) => {
      for (const mutation of batch) this.applyMutation(db, mutation)
    })
  }

  beginBackfill(store: string): void {
    this.assertStore(store)
    this.db.transaction((db) => {
      db.exec(`DELETE FROM ${tableName(store)}`)
      db.exec({ sql: `DELETE FROM ${META_TABLE} WHERE key = ?`, bind: [`backfilled:${store}`] })
    })
    this.backfilled.delete(store)
    this.backfilling.set(store, { touchedKeys: new Set(), touchedRanges: [] })
  }

  backfillChunk(store: string, entries: MirrorEntry[]): void {
    const state = this.backfilling.get(store)
    if (!state) throw new Error(`Store ${store} is not backfilling`)
    const fresh = entries.filter(
      (entry) =>
        !state.touchedKeys.has(keyId(entry.key)) && !state.touchedRanges.some((r) => isKeyInRange(entry.key, r))
    )
    this.db.transaction((db) => {
      for (const entry of fresh) {
        db.exec({
          sql: `INSERT OR IGNORE INTO ${tableName(store)} (k, v) VALUES (?, ?)`,
          bind: [entry.key, entry.value],
        })
      }
    })
  }

  finishBackfill(store: string): void {
    if (!this.backfilling.has(store)) throw new Error(`Store ${store} is not backfilling`)
    this.db.exec({
      sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, '1')`,
      bind: [`backfilled:${store}`],
    })
    this.backfilling.delete(store)
    this.backfilled.add(store)
  }

  backfilledStores(): string[] {
    return [...this.backfilled]
  }

  private assertStore(store: string): void {
    if (!this.stores.has(store)) throw new Error(`Unknown mirrored store: ${store}`)
  }

  private applyMutation(db: Database, mutation: MirrorMutation): void {
    const { store } = mutation
    this.assertStore(store)
    const state = this.backfilling.get(store)
    if (mutation.op === "put") {
      for (const entry of mutation.entries) {
        db.exec({
          sql: `INSERT OR REPLACE INTO ${tableName(store)} (k, v) VALUES (?, ?)`,
          bind: [entry.key, entry.value],
        })
        state?.touchedKeys.add(keyId(entry.key))
      }
    } else if (mutation.op === "delete") {
      for (const key of mutation.keys) {
        db.exec({ sql: `DELETE FROM ${tableName(store)} WHERE k = ?`, bind: [key] })
        state?.touchedKeys.add(keyId(key))
      }
    } else {
      const { range } = mutation
      const conditions: string[] = []
      const bind: Uint8Array[] = []
      if (range.lower) {
        conditions.push(`k ${range.lowerOpen ? ">" : ">="} ?`)
        bind.push(range.lower)
      }
      if (range.upper) {
        conditions.push(`k ${range.upperOpen ? "<" : "<="} ?`)
        bind.push(range.upper)
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
      db.exec({ sql: `DELETE FROM ${tableName(store)}${where}`, bind })
      state?.touchedRanges.push(range)
    }
  }

  private dropMirrorTables(): void {
    const tables = this.db.selectValues(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 's\\_%' ESCAPE '\\'`
    )
    this.db.transaction((db) => {
      for (const name of tables) db.exec(`DROP TABLE "${String(name)}"`)
    })
  }
}
