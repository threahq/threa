import type { Database, PreparedStatement, SqlValue } from "@sqlite.org/sqlite-wasm"
import { indexKeys } from "./index-keys"
import type { EncodedRange } from "./key-codec"
import { decodeValue } from "./value-codec"

export interface MirrorEntry {
  key: Uint8Array
  value: string
}

export type MirrorMutation =
  | { store: string; op: "put"; entries: MirrorEntry[] }
  | { store: string; op: "delete"; keys: Uint8Array[] }
  | { store: string; op: "deleteRange"; range: EncodedRange }

/** A write of a read-write transaction: an `add` fails, per entry, on a key the store already holds. */
export type MirrorWrite = MirrorMutation | { store: string; op: "add"; entries: MirrorEntry[] }

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

/** A read-write commit, named by the tab that asked for it and its transaction there. */
export interface CommitLedger {
  tab: string
  tx: number
}

const META_TABLE = "_mirror_meta"
const COMMITS_TABLE = "_mirror_commits"
const COMMIT_FLOORS_TABLE = "_mirror_commit_floors"
const SCHEMA_KEY = "schema"
/** Rows per progress report of a long request. */
const ROWS_PER_STEP = 500
/** Ledger rows kept; a pruned row's tab keeps its highest pruned transaction, so asking about it answers unknown. */
const KEPT_COMMITS = 1000
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

export class MirrorStore {
  private readonly schema = new Map<string, MirrorStoreSchema>()
  private readonly statements = new Map<string, PreparedStatement>()

  constructor(private readonly db: Database) {}

  /**
   * Brings the tables in line with the schema: removed stores and indexes are
   * dropped, new or redefined indexes are rebuilt from the stored values.
   */
  ensureSchema(schema: MirrorStoreSchema[], progress: () => void = () => {}): void {
    for (const { name } of schema) {
      if (!STORE_NAME_PATTERN.test(name)) throw new Error(`Invalid store name for mirroring: ${name}`)
    }
    this.closeStatements()
    const serialized = JSON.stringify(schema)
    // One commit: on OPFS every commit is flushed, and a first boot creates every table.
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`)
      // Left by the removed copy-back into IndexedDB.
      this.db.exec(`DROP TABLE IF EXISTS _idb_backlog`)
      this.db.exec(`DROP TABLE IF EXISTS _mirror_writers`)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${COMMITS_TABLE} (seq INTEGER PRIMARY KEY, tab TEXT NOT NULL, tx INTEGER NOT NULL, UNIQUE (tab, tx))`
      )
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${COMMIT_FLOORS_TABLE} (tab TEXT PRIMARY KEY, tx INTEGER NOT NULL) WITHOUT ROWID`
      )
      const storedSchema = this.db.selectValue(`SELECT value FROM ${META_TABLE} WHERE key = ?`, [SCHEMA_KEY])
      if (storedSchema === serialized) return
      const previous = new Map(
        (storedSchema === undefined ? [] : (JSON.parse(String(storedSchema)) as MirrorStoreSchema[])).map((store) => [
          store.name,
          store,
        ])
      )
      const next = new Map(schema.map((store) => [store.name, store]))
      for (const old of previous.values()) {
        if (!next.has(old.name)) this.dropStore(old)
      }
      for (const store of schema) this.reconcileStore(store, previous.get(store.name), progress)
      this.db.exec({
        sql: `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
        bind: [SCHEMA_KEY, serialized],
      })
    })
    this.schema.clear()
    for (const store of schema) this.schema.set(store.name, store)
  }

  /**
   * Applies one write inside the caller's transaction. An `add` entry whose key
   * the store holds, or an earlier entry of the same write added, is skipped
   * and reported.
   */
  write(write: MirrorWrite): { failures: number[] } {
    if (write.op !== "add") {
      this.applyMutation(write)
      return { failures: [] }
    }
    const failures: number[] = []
    write.entries.forEach((entry, index) => {
      if (this.all(`SELECT 1 FROM ${storeTable(write.store)} WHERE k = ?`, [entry.key]).length > 0) {
        failures.push(index)
        return
      }
      this.putRow(write.store, entry)
    })
    return { failures }
  }

  /** Inside the committing transaction, so the ledger row lands exactly when its writes do. */
  recordCommit({ tab, tx }: CommitLedger): void {
    this.run(`INSERT INTO ${COMMITS_TABLE} (tab, tx) VALUES (?, ?)`, [tab, tx])
    const pruned = `seq <= (SELECT MAX(seq) FROM ${COMMITS_TABLE}) - ?`
    this.run(
      `INSERT INTO ${COMMIT_FLOORS_TABLE} (tab, tx) SELECT tab, MAX(tx) FROM ${COMMITS_TABLE} WHERE ${pruned} GROUP BY tab
       ON CONFLICT (tab) DO UPDATE SET tx = MAX(tx, excluded.tx)`,
      [KEPT_COMMITS]
    )
    this.run(`DELETE FROM ${COMMITS_TABLE} WHERE ${pruned}`, [KEPT_COMMITS])
  }

  /** `null` once its row was pruned: whether it landed is no longer known. */
  committed({ tab, tx }: CommitLedger): boolean | null {
    if (this.all(`SELECT 1 FROM ${COMMITS_TABLE} WHERE tab = ? AND tx = ?`, [tab, tx]).length > 0) return true
    const floor = this.all(`SELECT tx FROM ${COMMIT_FLOORS_TABLE} WHERE tab = ?`, [tab])[0]?.[0]
    return floor !== undefined && Number(floor) >= tx ? null : false
  }

  /** Empties `stores` in one commit, writing only the tables that hold rows: on OPFS every page a commit writes is flushed. */
  beginBackfill(stores: readonly string[]): void {
    const tables = stores
      .flatMap((store) => [storeTable(store), ...this.storeSchema(store).indexes.map((i) => indexTable(store, i.name))])
      .filter((table) => this.all(`SELECT 1 FROM ${table} LIMIT 1`).length > 0)
    if (tables.length === 0) return
    this.db.transaction(() => {
      for (const table of tables) this.run(`DELETE FROM ${table}`)
    })
  }

  backfillChunk(store: string, entries: MirrorEntry[]): void {
    this.db.transaction(() => {
      for (const entry of entries) this.putRow(store, entry)
    })
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
  }

  private reconcileStore(
    store: MirrorStoreSchema,
    previous: MirrorStoreSchema | undefined,
    progress: () => void
  ): void {
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
      let rows = 0
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
          if (++rows % ROWS_PER_STEP === 0) progress()
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
    if (mutation.op === "put") {
      for (const entry of mutation.entries) this.putRow(store, entry)
    } else if (mutation.op === "delete") {
      for (const key of mutation.keys) {
        for (const index of indexes) this.run(`DELETE FROM ${indexTable(store, index.name)} WHERE k = ?`, [key])
        this.run(`DELETE FROM ${storeTable(store)} WHERE k = ?`, [key])
      }
    } else {
      const bind: SqlValue[] = []
      const filter = where(rangeConditions("k", mutation.range, bind))
      for (const index of indexes) {
        const table = indexTable(store, index.name)
        this.run(`DELETE FROM ${table} WHERE k IN (SELECT k FROM ${storeTable(store)}${filter})`, bind)
      }
      this.run(`DELETE FROM ${storeTable(store)}${filter}`, bind)
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
