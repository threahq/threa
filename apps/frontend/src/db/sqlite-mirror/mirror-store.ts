import type { Database } from "@sqlite.org/sqlite-wasm"
import { isKeyInRange, type EncodedRange } from "./key-codec"
import type { HeldCommits, WriterCommit } from "./marks"

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
const WRITERS_TABLE = "_mirror_writers"
const VERSION_KEY = "idbVersion"
const INCARNATION_KEY = "incarnation"
/** Per writer and store: commits applied before the one they follow, which may never arrive. */
const MAX_UNCHAINED_COMMITS = 1024
const STORE_NAME_PATTERN = /^[A-Za-z0-9_]+$/

function tableName(store: string): string {
  return `"s_${store}"`
}

function writerStore(writer: string, store: string): string {
  return `${store}\u0000${writer}`
}

function splitWriterStore(id: string): { writer: string; store: string } {
  const at = id.indexOf("\u0000")
  return { store: id.slice(0, at), writer: id.slice(at + 1) }
}

function keyId(key: Uint8Array): string {
  return key.join(",")
}

export interface MirrorStatus {
  backfilled: string[]
  writers: HeldCommits
  /** The IndexedDB incarnation these tables copy; `null` before the first reset. */
  incarnation: string | null
}

export class MirrorStore {
  private readonly stores = new Set<string>()
  private readonly backfilled = new Set<string>()
  private readonly backfilling = new Map<string, BackfillState>()
  /** By `writerStore`: the seq through which every commit of the writer to the store is held. */
  private readonly held = new Map<string, number>()
  /** By `writerStore`: applied commits by the seq they follow. */
  private readonly unchained = new Map<string, Map<number, number>>()

  constructor(private readonly db: Database) {}

  ensureSchema(stores: string[], idbVersion: number): void {
    for (const store of stores) {
      if (!STORE_NAME_PATTERN.test(store)) throw new Error(`Invalid store name for mirroring: ${store}`)
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`)
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${WRITERS_TABLE} (writer TEXT NOT NULL, store TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (writer, store)) WITHOUT ROWID`
    )
    const stored = this.db.selectValue(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [VERSION_KEY])
    if (stored !== undefined && stored !== String(idbVersion)) this.clearMirror()
    this.db.transaction((db) => {
      db.exec({
        sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
        bind: [VERSION_KEY, String(idbVersion)],
      })
    })
    this.stores.clear()
    for (const store of stores) this.stores.add(store)
    this.createTables()
    this.loadState()
  }

  /** Empties every mirrored table and forgets all it knew, to copy the IndexedDB incarnation named. */
  reset(incarnation: string): void {
    this.clearMirror()
    this.db.exec({
      sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
      bind: [INCARNATION_KEY, incarnation],
    })
    this.createTables()
    this.loadState()
  }

  status(): MirrorStatus {
    const incarnation = this.db.selectValue(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [INCARNATION_KEY])
    const writers: HeldCommits = {}
    for (const [id, seq] of this.held) {
      const { writer, store } = splitWriterStore(id)
      ;(writers[writer] ??= {})[store] = seq
    }
    return {
      backfilled: [...this.backfilled],
      writers,
      incarnation: incarnation === undefined ? null : String(incarnation),
    }
  }

  forgetWriters(writers: readonly string[]): void {
    this.db.transaction((db) => {
      for (const writer of writers) db.exec({ sql: `DELETE FROM ${WRITERS_TABLE} WHERE writer = ?`, bind: [writer] })
    })
    const forgotten = new Set(writers)
    for (const map of [this.held, this.unchained]) {
      for (const id of map.keys()) if (forgotten.has(splitWriterStore(id).writer)) map.delete(id)
    }
  }

  /** `commit` is given only when the batch holds every write of that commit, so SQLite holds it once applied. */
  apply(batch: MirrorMutation[], commit?: WriterCommit): void {
    const advanced = commit
      ? Object.entries(commit.prev).map(([store, prev]) => this.advance(commit.writer, store, prev, commit.seq))
      : []
    this.db.transaction((db) => {
      for (const mutation of batch) this.applyMutation(db, mutation)
      for (const step of advanced) step.write(db)
    })
    for (const step of advanced) step.keep()
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

  /** `covered`: per writer, the mark it had on the store before the backfill read it, so the backfill holds its writes through it. */
  finishBackfill(store: string, covered: Record<string, number> = {}): void {
    if (!this.backfilling.has(store)) throw new Error(`Store ${store} is not backfilling`)
    const advanced = Object.entries(covered).map(([writer, seq]) => this.advance(writer, store, 0, seq, true))
    this.db.transaction((db) => {
      db.exec({
        sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, '1')`,
        bind: [`backfilled:${store}`],
      })
      for (const step of advanced) step.write(db)
    })
    for (const step of advanced) step.keep()
    this.backfilling.delete(store)
    this.backfilled.add(store)
  }

  /**
   * Holds commit `seq` of `writer` to `store`, which follows `prev`; with
   * `through`, every commit up to `seq` instead. Computed before the SQLite
   * transaction, written in it, and kept only once it commits.
   */
  private advance(writer: string, store: string, prev: number, seq: number, through = false) {
    const id = writerStore(writer, store)
    const before = this.held.get(id) ?? 0
    const links = new Map(this.unchained.get(id))
    const from = through ? before : prev
    if (seq > before && from < seq) links.set(from, Math.max(seq, links.get(from) ?? 0))
    let after = before
    for (let next = links.get(after); next !== undefined && next > after; next = links.get(after)) {
      links.delete(after)
      after = next
    }
    for (const link of links.keys()) if (link < after) links.delete(link)
    while (links.size > MAX_UNCHAINED_COMMITS) links.delete(links.keys().next().value!)
    return {
      write: (db: Database) => {
        if (after === before) return
        db.exec({
          sql: `INSERT OR REPLACE INTO ${WRITERS_TABLE} (writer, store, seq) VALUES (?, ?, ?)`,
          bind: [writer, store, after],
        })
      },
      keep: () => {
        if (after !== before) this.held.set(id, after)
        if (links.size > 0) this.unchained.set(id, links)
        else this.unchained.delete(id)
      },
    }
  }

  private createTables(): void {
    this.db.transaction((db) => {
      for (const store of this.stores) {
        db.exec(`CREATE TABLE IF NOT EXISTS ${tableName(store)} (k BLOB PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`)
      }
    })
  }

  private loadState(): void {
    this.backfilled.clear()
    this.backfilling.clear()
    this.held.clear()
    this.unchained.clear()
    for (const row of this.db.selectValues(`SELECT key FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)) {
      const store = String(row).slice("backfilled:".length)
      if (this.stores.has(store)) this.backfilled.add(store)
    }
    for (const [writer, store, seq] of this.db.selectArrays(`SELECT writer, store, seq FROM ${WRITERS_TABLE}`)) {
      this.held.set(writerStore(String(writer), String(store)), Number(seq))
    }
  }

  private clearMirror(): void {
    const tables = this.db.selectValues(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 's\\_%' ESCAPE '\\'`
    )
    this.db.transaction((db) => {
      for (const name of tables) db.exec(`DROP TABLE "${String(name)}"`)
      db.exec(`DELETE FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)
      db.exec(`DELETE FROM ${WRITERS_TABLE}`)
    })
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
}
