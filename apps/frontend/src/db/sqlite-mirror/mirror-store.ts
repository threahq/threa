import type { Database, PreparedStatement, SqlValue } from "@sqlite.org/sqlite-wasm"
import { indexKeys } from "./index-keys"
import { isKeyInRange, keyId, type EncodedRange } from "./key-codec"
import type { HeldCommits, WriterCommit } from "./marks"
import { decodeValue } from "./value-codec"

export interface MirrorEntry {
  key: Uint8Array
  value: string
}

export type MirrorMutation =
  | { store: string; op: "put"; entries: MirrorEntry[] }
  | { store: string; op: "delete"; keys: Uint8Array[] }
  | { store: string; op: "deleteRange"; range: EncodedRange }

export interface MirrorIndexSchema {
  name: string
  keyPath: string | string[]
  multiEntry: boolean
}

export interface MirrorStoreSchema {
  name: string
  indexes: MirrorIndexSchema[]
}

/** Where a query resumes: past (`open`) or at `key`, and within it past or at `primaryKey`. */
export interface MirrorQueryStart {
  key: Uint8Array
  primaryKey: Uint8Array | null
  open: boolean
}

export interface MirrorQuery {
  /** `null` reads the store in primary key order. */
  index: string | null
  range: EncodedRange
  reverse: boolean
  /** Only the lowest primary key of each index key, as IndexedDB's `nextunique` and `prevunique` yield. */
  unique: boolean
  values: boolean
  limit: number | null
  from: MirrorQueryStart | null
}

/** `key` is the index key, or the primary key when reading the store; `value` is set when values were asked for. */
export interface MirrorRow {
  key: Uint8Array
  primaryKey: Uint8Array
  value?: string
}

interface BackfillState {
  touchedKeys: Set<string>
  touchedRanges: EncodedRange[]
}

const META_TABLE = "_mirror_meta"
const WRITERS_TABLE = "_mirror_writers"
const VERSION_KEY = "idbVersion"
const SCHEMA_KEY = "schema"
const INCARNATION_KEY = "incarnation"
/** Per writer and store: commits applied before the one they follow, which may never arrive. */
const MAX_UNCHAINED_COMMITS = 1024
const STORE_NAME_PATTERN = /^[A-Za-z0-9_]+$/

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function storeTable(store: string): string {
  return quote(`s_${store}`)
}

function indexTable(store: string, index: string): string {
  return quote(`i_${store}__${index}`)
}

function sameIndex(a: MirrorIndexSchema, b: MirrorIndexSchema): boolean {
  return JSON.stringify([a.keyPath, a.multiEntry]) === JSON.stringify([b.keyPath, b.multiEntry])
}

function rangeConditions(column: string, range: EncodedRange, bind: SqlValue[]): string[] {
  const conditions: string[] = []
  if (range.lower) {
    conditions.push(`${column} ${range.lowerOpen ? ">" : ">="} ?`)
    bind.push(range.lower)
  }
  if (range.upper) {
    conditions.push(`${column} ${range.upperOpen ? "<" : "<="} ?`)
    bind.push(range.upper)
  }
  return conditions
}

function where(conditions: readonly string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
}

function writerStore(writer: string, store: string): string {
  return `${store}\u0000${writer}`
}

function splitWriterStore(id: string): { writer: string; store: string } {
  const at = id.indexOf("\u0000")
  return { store: id.slice(0, at), writer: id.slice(at + 1) }
}

export interface MirrorStatus {
  backfilled: string[]
  writers: HeldCommits
  /** The IndexedDB incarnation these tables copy; `null` before the first reset. */
  incarnation: string | null
}

export class MirrorStore {
  private readonly schema = new Map<string, MirrorStoreSchema>()
  private readonly backfilled = new Set<string>()
  private readonly backfilling = new Map<string, BackfillState>()
  private readonly statements = new Map<string, PreparedStatement>()
  /** By `writerStore`: the seq through which every commit of the writer to the store is held. */
  private readonly held = new Map<string, number>()
  /** By `writerStore`: applied commits by the seq they follow. */
  private readonly unchained = new Map<string, Map<number, number>>()

  constructor(private readonly db: Database) {}

  /**
   * Brings the tables in line with the schema: removed stores and indexes are
   * dropped, new or redefined indexes are rebuilt from the stored values.
   * Data survives an IndexedDB version change, but no store stays trusted:
   * upgrade functions rewrite rows inside the versionchange transaction,
   * which the mirror never sees.
   */
  ensureSchema(schema: MirrorStoreSchema[], idbVersion: number): void {
    for (const { name } of schema) {
      if (!STORE_NAME_PATTERN.test(name)) throw new Error(`Invalid store name for mirroring: ${name}`)
    }
    this.closeStatements()
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`)
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${WRITERS_TABLE} (writer TEXT NOT NULL, store TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (writer, store)) WITHOUT ROWID`
    )
    const storedVersion = this.db.selectValue(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [VERSION_KEY])
    const storedSchema = this.db.selectValue(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [SCHEMA_KEY])
    const previous = new Map(
      (storedSchema === undefined ? [] : (JSON.parse(String(storedSchema)) as MirrorStoreSchema[])).map((store) => [
        store.name,
        store,
      ])
    )
    const next = new Map(schema.map((store) => [store.name, store]))
    this.db.transaction(() => {
      for (const old of previous.values()) {
        if (!next.has(old.name)) this.dropStore(old)
      }
      for (const store of schema) this.reconcileStore(store, previous.get(store.name))
      if (storedVersion !== undefined && storedVersion !== String(idbVersion)) {
        this.db.exec(`DELETE FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)
        this.db.exec(`DELETE FROM ${WRITERS_TABLE}`)
      }
      this.db.exec({
        sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?), (?, ?)`,
        bind: [VERSION_KEY, String(idbVersion), SCHEMA_KEY, JSON.stringify(schema)],
      })
    })
    this.schema.clear()
    for (const store of schema) this.schema.set(store.name, store)
    this.loadState()
  }

  /** Empties every mirrored table and forgets all it knew, to copy the IndexedDB incarnation named. */
  reset(incarnation: string): void {
    this.db.transaction(() => {
      for (const { name, indexes } of this.schema.values()) {
        this.run(`DELETE FROM ${storeTable(name)}`)
        for (const index of indexes) this.run(`DELETE FROM ${indexTable(name, index.name)}`)
      }
      this.run(`DELETE FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)
      this.run(`DELETE FROM ${WRITERS_TABLE}`)
      this.run(`INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`, [INCARNATION_KEY, incarnation])
    })
    this.loadState()
  }

  status(): MirrorStatus {
    const [row] = this.all(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [INCARNATION_KEY])
    const writers: HeldCommits = {}
    for (const [id, seq] of this.held) {
      const { writer, store } = splitWriterStore(id)
      ;(writers[writer] ??= {})[store] = seq
    }
    return {
      backfilled: [...this.backfilled],
      writers,
      incarnation: row === undefined ? null : String(row[0]),
    }
  }

  forgetWriters(writers: readonly string[]): void {
    this.db.transaction(() => {
      for (const writer of writers) this.run(`DELETE FROM ${WRITERS_TABLE} WHERE writer = ?`, [writer])
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
    this.db.transaction(() => {
      for (const mutation of batch) this.applyMutation(mutation)
      for (const step of advanced) step.write()
    })
    for (const step of advanced) step.keep()
  }

  beginBackfill(store: string): void {
    const { indexes } = this.storeSchema(store)
    this.db.transaction(() => {
      this.run(`DELETE FROM ${storeTable(store)}`)
      for (const index of indexes) this.run(`DELETE FROM ${indexTable(store, index.name)}`)
      this.run(`DELETE FROM ${META_TABLE} WHERE key = ?`, [`backfilled:${store}`])
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
    this.db.transaction(() => {
      for (const entry of fresh) this.putRow(store, entry)
    })
  }

  /** `covered`: per writer, the mark it had on the store before the backfill read it, so the backfill holds its writes through it. */
  finishBackfill(store: string, covered: Record<string, number> = {}): void {
    if (!this.backfilling.has(store)) throw new Error(`Store ${store} is not backfilling`)
    const advanced = Object.entries(covered).map(([writer, seq]) => this.advance(writer, store, 0, seq, true))
    this.db.transaction(() => {
      this.run(`INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, '1')`, [`backfilled:${store}`])
      for (const step of advanced) step.write()
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
      write: () => {
        if (after !== before)
          this.run(`INSERT OR REPLACE INTO ${WRITERS_TABLE} (writer, store, seq) VALUES (?, ?, ?)`, [
            writer,
            store,
            after,
          ])
      },
      keep: () => {
        if (after !== before) this.held.set(id, after)
        if (links.size > 0) this.unchained.set(id, links)
        else this.unchained.delete(id)
      },
    }
  }

  private loadState(): void {
    this.backfilled.clear()
    this.backfilling.clear()
    this.held.clear()
    this.unchained.clear()
    for (const [key] of this.all(`SELECT key FROM ${META_TABLE} WHERE key LIKE 'backfilled:%'`)) {
      const store = String(key).slice("backfilled:".length)
      if (this.schema.has(store)) this.backfilled.add(store)
    }
    for (const [writer, store, seq] of this.all(`SELECT writer, store, seq FROM ${WRITERS_TABLE}`)) {
      this.held.set(writerStore(String(writer), String(store)), Number(seq))
    }
  }

  get(store: string, key: Uint8Array): string | undefined {
    this.storeSchema(store)
    const [row] = this.all(`SELECT v FROM ${storeTable(store)} WHERE k = ?`, [key])
    return row === undefined ? undefined : String(row[0])
  }

  getMany(store: string, keys: Uint8Array[]): Array<string | undefined> {
    return keys.map((key) => this.get(store, key))
  }

  /** Rows in IndexedDB's order: by key, then by primary key, both descending when reversed. */
  query(store: string, query: MirrorQuery): MirrorRow[] {
    const { index, range, reverse, values, limit, from } = query
    const direction = reverse ? "DESC" : "ASC"
    const after = reverse ? "<" : ">"
    const bind: SqlValue[] = []
    if (index === null) {
      this.storeSchema(store)
      const conditions = rangeConditions("k", range, bind)
      if (from) {
        conditions.push(`k ${after}${from.open ? "" : "="} ?`)
        bind.push(from.key)
      }
      const columns = values ? "k, v" : "k"
      const sql = `SELECT ${columns} FROM ${storeTable(store)}${where(conditions)} ORDER BY k ${direction} LIMIT ?`
      return this.all(sql, [...bind, limit ?? -1]).map((row) => {
        const key = row[0] as Uint8Array
        return values ? { key, primaryKey: key, value: String(row[1]) } : { key, primaryKey: key }
      })
    }
    const table = this.indexTableFor(store, index)
    // A unique read filters inside its grouping subquery, where the columns are unqualified.
    const column = query.unique ? "" : "i."
    const conditions = rangeConditions(`${column}ik`, range, bind)
    if (from && (query.unique || !from.primaryKey)) {
      conditions.push(`${column}ik ${after}${from.open ? "" : "="} ?`)
      bind.push(from.key)
    } else if (from?.primaryKey) {
      conditions.push(`(i.ik, i.k) ${after}${from.open ? "" : "="} (?, ?)`)
      bind.push(from.key, from.primaryKey)
    }
    const source = query.unique
      ? `(SELECT ik, MIN(k) AS k FROM ${table}${where(conditions)} GROUP BY ik) AS i`
      : `${table} AS i`
    const join = values ? ` JOIN ${storeTable(store)} AS s ON s.k = i.k` : ""
    const filter = query.unique ? "" : where(conditions)
    const order = query.unique ? `i.ik ${direction}` : `i.ik ${direction}, i.k ${direction}`
    const sql = `SELECT i.ik, i.k${values ? ", s.v" : ""} FROM ${source}${join}${filter} ORDER BY ${order} LIMIT ?`
    return this.all(sql, [...bind, limit ?? -1]).map((row) => {
      const result: MirrorRow = { key: row[0] as Uint8Array, primaryKey: row[1] as Uint8Array }
      if (values) result.value = String(row[2])
      return result
    })
  }

  count(store: string, index: string | null, range: EncodedRange): number {
    const bind: SqlValue[] = []
    const table = index === null ? (this.storeSchema(store), storeTable(store)) : this.indexTableFor(store, index)
    const column = index === null ? "k" : "ik"
    const [row] = this.all(`SELECT COUNT(*) FROM ${table}${where(rangeConditions(column, range, bind))}`, bind)
    return Number(row[0])
  }

  private storeSchema(store: string): MirrorStoreSchema {
    const schema = this.schema.get(store)
    if (!schema) throw new Error(`Unknown mirrored store: ${store}`)
    return schema
  }

  private indexTableFor(store: string, index: string): string {
    if (!this.storeSchema(store).indexes.some((candidate) => candidate.name === index)) {
      throw new Error(`Unknown mirrored index: ${store}.${index}`)
    }
    return indexTable(store, index)
  }

  private dropStore(store: MirrorStoreSchema): void {
    this.db.exec(`DROP TABLE IF EXISTS ${storeTable(store.name)}`)
    for (const index of store.indexes) this.db.exec(`DROP TABLE IF EXISTS ${indexTable(store.name, index.name)}`)
    this.db.exec({ sql: `DELETE FROM ${META_TABLE} WHERE key = ?`, bind: [`backfilled:${store.name}`] })
  }

  private reconcileStore(store: MirrorStoreSchema, previous: MirrorStoreSchema | undefined): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${storeTable(store.name)} (k BLOB PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`
    )
    for (const old of previous?.indexes ?? []) {
      if (!store.indexes.some((index) => index.name === old.name)) {
        this.db.exec(`DROP TABLE IF EXISTS ${indexTable(store.name, old.name)}`)
      }
    }
    for (const index of store.indexes) {
      const old = previous?.indexes.find((candidate) => candidate.name === index.name)
      if (old && sameIndex(old, index)) continue
      const table = indexTable(store.name, index.name)
      this.db.exec(`DROP TABLE IF EXISTS ${table}`)
      this.db.exec(`CREATE TABLE ${table} (ik BLOB NOT NULL, k BLOB NOT NULL, PRIMARY KEY (ik, k)) WITHOUT ROWID`)
      this.db.exec(`CREATE INDEX ${indexTable(store.name, `${index.name}__k`)} ON ${table} (k)`)
      this.db.exec({
        sql: `SELECT k, v FROM ${storeTable(store.name)}`,
        rowMode: "array",
        callback: (row) => {
          const [k, v] = row as [Uint8Array, string]
          for (const ik of indexKeys(decodeValue(v), index.keyPath, index.multiEntry)) {
            this.run(`INSERT OR IGNORE INTO ${table} (ik, k) VALUES (?, ?)`, [ik, k])
          }
        },
      })
    }
  }

  private putRow(store: string, entry: MirrorEntry): void {
    const { indexes } = this.storeSchema(store)
    for (const index of indexes) this.run(`DELETE FROM ${indexTable(store, index.name)} WHERE k = ?`, [entry.key])
    this.run(`INSERT OR REPLACE INTO ${storeTable(store)} (k, v) VALUES (?, ?)`, [entry.key, entry.value])
    if (indexes.length === 0) return
    const value = decodeValue(entry.value)
    for (const index of indexes) {
      const sql = `INSERT OR IGNORE INTO ${indexTable(store, index.name)} (ik, k) VALUES (?, ?)`
      for (const ik of indexKeys(value, index.keyPath, index.multiEntry)) this.run(sql, [ik, entry.key])
    }
  }

  private applyMutation(mutation: MirrorMutation): void {
    const { store } = mutation
    const { indexes } = this.storeSchema(store)
    const state = this.backfilling.get(store)
    if (mutation.op === "put") {
      for (const entry of mutation.entries) {
        this.putRow(store, entry)
        state?.touchedKeys.add(keyId(entry.key))
      }
    } else if (mutation.op === "delete") {
      for (const key of mutation.keys) {
        for (const index of indexes) this.run(`DELETE FROM ${indexTable(store, index.name)} WHERE k = ?`, [key])
        this.run(`DELETE FROM ${storeTable(store)} WHERE k = ?`, [key])
        state?.touchedKeys.add(keyId(key))
      }
    } else {
      const bind: SqlValue[] = []
      const filter = where(rangeConditions("k", mutation.range, bind))
      for (const index of indexes) {
        const table = indexTable(store, index.name)
        this.run(`DELETE FROM ${table} WHERE k IN (SELECT k FROM ${storeTable(store)}${filter})`, bind)
      }
      this.run(`DELETE FROM ${storeTable(store)}${filter}`, bind)
      state?.touchedRanges.push(mutation.range)
    }
  }

  private statement(sql: string): PreparedStatement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private all(sql: string, bind: SqlValue[] = []): SqlValue[][] {
    const statement = this.statement(sql)
    try {
      if (bind.length > 0) statement.bind(bind)
      const rows: SqlValue[][] = []
      while (statement.step()) rows.push(statement.get([]))
      return rows
    } finally {
      statement.reset(true)
    }
  }

  private run(sql: string, bind: SqlValue[] = []): void {
    this.all(sql, bind)
  }

  private closeStatements(): void {
    for (const statement of this.statements.values()) statement.finalize()
    this.statements.clear()
  }
}
