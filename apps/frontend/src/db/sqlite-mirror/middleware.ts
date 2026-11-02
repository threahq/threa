import type {
  DBCore,
  DBCoreCursor,
  DBCoreIndex,
  DBCoreKeyRange,
  DBCoreQueryRequest,
  DBCoreTable,
  DBCoreTransaction,
  Middleware,
} from "dexie"
import { getPerfCapture } from "@/lib/perf/capture"
import type { SqliteMirror } from "./client"
import { EmulatedTransaction } from "./emulated-transaction"
import { touchedOf } from "./idb-reads"
import { indexKeys } from "./index-keys"
import { decodeKey, encodeKey, encodeRange, keyId } from "./key-codec"
import { SQLITE_INCARNATION_STORE, sqliteMarksStore, writerBatch, type IdbWriter, type SqliteMark } from "./marks"
import { CURSOR_PAGE_ROWS, materializedCursor } from "./materialized-cursor"
import type { MirrorQueryStart, MirrorRow } from "./mirror-store"
import type { MirrorReadRequest, MirrorReadResults } from "./protocol"
import { isMirroredStore } from "./stores"
import { decodeValue, encodeValue } from "./value-codec"

/**
 * One successful mutation of a store, as it reached IndexedDB. Put values are
 * encoded when the mutation is issued, as IndexedDB clones them then; `null`
 * marks a value the mirror cannot represent.
 */
export type IdbWrite =
  | { store: string; op: "put"; keys: IDBValidKey[]; values: Array<string | null> }
  | { store: string; op: "delete"; keys: IDBValidKey[] }
  | { store: string; op: "deleteRange"; range: DBCoreKeyRange }

/** A readwrite transaction's writes. `mirror` is read at creation: put values are encoded only for a running one. */
interface BufferedWrites {
  mirror: SqliteMirror | null
  seq: number
  marked: Set<string>
  writes: IdbWrite[]
}

const SHADOW_INTERVAL_MS = 200

type ReadRequest<K extends MirrorReadRequest["type"]> = Extract<MirrorReadRequest, { type: K }>

type MutateRequest = Parameters<DBCoreTable["mutate"]>[0]
type MutateResponse = Awaited<ReturnType<DBCoreTable["mutate"]>>

const RANGE_TYPE_NEVER = 4
const NOTHING_MUTATED: MutateResponse = { numFailures: 0, failures: {}, results: [], lastResult: undefined }

function tryEncode(value: unknown): string | null {
  try {
    return encodeValue(value)
  } catch {
    return null
  }
}

function recordWrite(
  store: string,
  req: MutateRequest,
  encoded: Array<string | null>,
  res: MutateResponse,
  writes: IdbWrite[]
): void {
  if (req.type === "add" || req.type === "put") {
    const keys: IDBValidKey[] = []
    const values: Array<string | null> = []
    req.values.forEach((_, index) => {
      if (res.failures[index]) return
      keys.push(res.results?.[index])
      values.push(encoded[index] ?? null)
    })
    if (keys.length > 0) writes.push({ store, op: "put", keys, values })
  } else if (req.type === "delete") {
    writes.push({ store, op: "delete", keys: req.keys })
  } else {
    writes.push({ store, op: "deleteRange", range: req.range })
  }
}

function requestKey(key: unknown): Uint8Array {
  try {
    return encodeKey(key as IDBValidKey)
  } catch (error) {
    throw new DOMException(error instanceof Error ? error.message : String(error), "DataError")
  }
}

function indexName(index: DBCoreIndex): string | null {
  return index.isPrimaryKey ? null : index.name
}

function readQuery(req: DBCoreQueryRequest, store: string): ReadRequest<"query"> {
  const direction = req.direction ?? "next"
  return {
    type: "query",
    store,
    query: {
      index: indexName(req.query.index),
      range: encodeRange(req.query.range),
      reverse: direction.startsWith("prev"),
      unique: direction.endsWith("unique"),
      values: req.values === true,
      limit: req.limit === undefined || req.limit === Infinity ? null : req.limit,
      from: null,
    },
  }
}

function abortTransaction(tx: DBCoreTransaction): void {
  try {
    ;(tx as unknown as IDBTransaction).abort()
  } catch {
    // Already finished: then the mark committed or nothing did.
  }
}

function finished(tx: DBCoreTransaction): Promise<void> {
  return new Promise((resolve) => {
    const target = tx as unknown as IDBTransaction
    target.addEventListener("complete", () => resolve(), { once: true })
    target.addEventListener("abort", () => resolve(), { once: true })
  })
}

/** Readwrite transactions still running, so a read started meanwhile can wait for their commit like IndexedDB's would. */
class RunningWriters {
  private readonly running = new Set<{ stores: readonly string[]; done: Promise<void> }>()

  track(tx: DBCoreTransaction, stores: readonly string[]): void {
    const entry = { stores, done: finished(tx) }
    this.running.add(entry)
    void entry.done.then(() => this.running.delete(entry))
  }

  overlapping(stores: readonly string[]): Promise<void>[] {
    const blockers: Promise<void>[] = []
    for (const entry of this.running) {
      if (entry.stores.some((store) => stores.includes(store))) blockers.push(entry.done)
    }
    return blockers
  }
}

/**
 * Runs below every other DBCore middleware, so it sees exactly what reaches
 * IndexedDB, and its commit listener runs before Dexie resolves the write:
 * a read issued after an awaited write is queued behind the write's apply.
 *
 * Each readwrite transaction over mirrored stores also takes their marks
 * stores and marks each mirrored store it writes, so no write commits unmarked. Once
 * it commits, its writes go to the running mirror or, with none, are announced
 * to whichever tab owns one. In `read-only`
 * mode a readonly transaction over stores the mirror trusts gets an emulated
 * transaction whose reads SQLite serves; a read SQLite cannot serve is served
 * again from IndexedDB, in a native readonly transaction of its own. In
 * `shadow` mode a sample of native readonly reads is repeated on SQLite and
 * compared, never changing the result. In `read-write` mode every transaction
 * over mirrored stores is emulated, its writes included, and takes no marks:
 * it never reaches IndexedDB.
 */
export function createSqliteMirrorMiddleware(
  currentMirror: () => SqliteMirror | null,
  writer: IdbWriter
): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "sqliteMirror",
    level: -10,
    create(down) {
      const buffers = new WeakMap<DBCoreTransaction, BufferedWrites>()
      const fallbacks = new WeakMap<EmulatedTransaction, { trans: DBCoreTransaction; finished: boolean }>()
      const writers = new RunningWriters()
      const warnedStores = new Set<string>()
      let lastShadowAt = -Infinity
      const names = new Set(down.schema.tables.map((table) => table.name))
      // Absent only from the cores Dexie builds for an upgrade, whose writes run in the versionchange transaction.
      const marking = names.has(SQLITE_INCARNATION_STORE)
      const marksOf = (store: string): DBCoreTable | null => {
        if (!marking || !isMirroredStore(store)) return null
        const name = sqliteMarksStore(store)
        // A write to a mirrored store must never commit unmarked.
        if (!names.has(name)) throw new Error(`Mirrored store ${store} has no marks store ${name}`)
        return down.table(name)
      }

      function bufferWrites(tx: DBCoreTransaction, mirror: SqliteMirror | null): void {
        const buffer: BufferedWrites = { mirror, seq: writer.nextSeq(), marked: new Set(), writes: [] }
        buffers.set(tx, buffer)
        ;(tx as unknown as IDBTransaction).addEventListener(
          "complete",
          () => {
            if (buffer.marked.size === 0) return
            const commit = writer.committed(buffer.seq, buffer.marked)
            if (mirror) mirror.commit(commit, buffer.writes)
            else writer.announce(writerBatch(commit, buffer.writes.map(touchedOf)))
          },
          { once: true }
        )
      }

      /**
       * From the first read SQLite cannot serve, the rest of the emulated
       * transaction's reads share one native transaction over all its stores,
       * so they see one IndexedDB state. A new one opens only if that one
       * finished while the emulated transaction was still active.
       */
      function nativeTransaction(tx: EmulatedTransaction): DBCoreTransaction {
        const open = fallbacks.get(tx)
        if (open && !open.finished) return open.trans
        const fallback = { trans: down.transaction([...tx.storeNames], "readonly"), finished: false }
        fallbacks.set(tx, fallback)
        const done = finished(fallback.trans).then(() => void (fallback.finished = true))
        tx.hold(done)
        return fallback.trans
      }

      function emulated<T>(
        tx: EmulatedTransaction,
        request: () => MirrorReadRequest,
        decode: (result: never) => T,
        native: (trans: DBCoreTransaction) => Promise<T>
      ): Promise<T> {
        const id = tx.id
        // Under read-write storage IndexedDB is a backup that may lag, never an answer.
        if (id !== undefined)
          return tx.run(() => tx.mirror.read({ ...request(), tx: id }).then((r) => decode(r as never)))
        return tx.run(() => {
          if (fallbacks.has(tx)) return native(nativeTransaction(tx))
          const read = request()
          return tx.mirror
            .read(read)
            .then((result) => decode(result as never))
            .catch((error: unknown) => {
              tx.mirror.fellBack(read.store, error)
              return native(nativeTransaction(tx))
            })
        })
      }

      function shadow<T, K extends MirrorReadRequest["type"]>(
        trans: DBCoreTransaction,
        idbRead: Promise<T>,
        request: () => ReadRequest<K>,
        digestIdb: (result: T) => string,
        digestSqlite: (result: MirrorReadResults[K]) => string
      ): Promise<T> {
        const mirror = currentMirror()
        if (mirror?.mode !== "shadow" || (trans as unknown as IDBTransaction).mode !== "readonly") return idbRead
        const startedAt = performance.now()
        if (startedAt - lastShadowAt < SHADOW_INTERVAL_MS) return idbRead
        lastShadowAt = startedAt
        const capture = getPerfCapture()
        let read: ReadRequest<K>
        try {
          read = request()
        } catch {
          return idbRead
        }
        if (!mirror.trusts(read.store)) {
          capture.count("sqlite.readSkipped")
          return idbRead
        }
        const changesAtStart = mirror.changes(read.store)
        const raced = () =>
          writers.overlapping([read.store]).length > 0 || mirror.changes(read.store) !== changesAtStart
        const sqlite = Promise.all(writers.overlapping([read.store]))
          .then(async () => {
            const sentAt = performance.now()
            const result = (await mirror.read(read)) as MirrorReadResults[K]
            return { digest: digestSqlite(result), ms: performance.now() - sentAt }
          })
          .catch((error: unknown) => {
            mirror.fellBack(read.store, error)
            return null
          })
        return idbRead.then((result) => {
          const idbMs = performance.now() - startedAt
          const expected = digestIdb(result)
          const racedBeforeIdbAnswered = raced()
          void sqlite.then((answer) => {
            if (!answer || racedBeforeIdbAnswered || raced()) return
            capture.mark("sqlite.readMs", answer.ms)
            capture.mark("idb.readMsShadow", idbMs)
            if (answer.digest === expected) return
            capture.count("sqlite.readMismatch")
            if (warnedStores.has(read.store)) return
            warnedStores.add(read.store)
            console.warn(`SQLite mirror read of ${read.store} differs from IndexedDB`, read)
          })
          return result
        })
      }

      /** IndexedDB's outcome for each entry: an `add` over an existing key fails alone, the rest still apply. */
      function emulatedMutate(
        tx: EmulatedTransaction,
        table: DBCoreTable,
        req: MutateRequest
      ): Promise<MutateResponse> {
        const store = table.name
        const id = tx.id
        if (id === undefined) {
          return Promise.reject(new DOMException("The transaction is read-only.", "ReadOnlyError"))
        }
        return tx.run(async () => {
          if (req.type === "deleteRange") {
            if (req.range.type === RANGE_TYPE_NEVER) return NOTHING_MUTATED
            await tx.mirror.write(id, { store, op: "deleteRange", range: encodeRange(req.range) })
            return NOTHING_MUTATED
          }
          if (req.type === "delete") {
            if (req.keys.length === 0) return NOTHING_MUTATED
            await tx.mirror.write(id, { store, op: "delete", keys: req.keys.map(requestKey) })
            return { numFailures: 0, failures: {}, results: req.keys, lastResult: undefined }
          }
          if (req.values.length === 0) return NOTHING_MUTATED
          const { keyPath } = table.schema.primaryKey
          if (!keyPath) throw new Error(`Read-write SQLite storage cannot key rows of ${store}`)
          const entries = req.values.map((value) => {
            const [key] = indexKeys(value, keyPath, false)
            if (!key) throw new DOMException(`A row of ${store} has no valid key at its key path.`, "DataError")
            const encoded = tryEncode(value)
            if (encoded === null) throw new DOMException(`A row of ${store} cannot be stored.`, "DataCloneError")
            return { key, value: encoded }
          })
          const failed = new Set(await tx.mirror.write(id, { store, op: req.type, entries }))
          const failures: Record<number, Error> = {}
          for (const index of failed) {
            failures[index] = new DOMException("Key already exists in the object store.", "ConstraintError")
          }
          const results = entries.map((entry, index) => (failed.has(index) ? undefined : decodeKey(entry.key)))
          return { numFailures: failed.size, failures, results, lastResult: results[results.length - 1] }
        })
      }

      function mirroredTable(table: DBCoreTable, marks: DBCoreTable | null): DBCoreTable {
        const store = table.name
        const getRequest = (key: unknown): ReadRequest<"get"> => ({
          type: "get",
          store,
          key: requestKey(key),
        })
        const digestValue = (value: unknown) => (value === undefined ? "" : (tryEncode(value) ?? "unmirrorable"))
        return {
          ...table,
          mutate: (req) => {
            if (req.trans instanceof EmulatedTransaction) return emulatedMutate(req.trans, table, req)
            const buffer = buffers.get(req.trans)
            if (!buffer || !marks) return table.mutate(req)
            if (!buffer.marked.has(store)) {
              buffer.marked.add(store)
              // Issued before the write it covers; without it the write must not commit.
              const mark: SqliteMark = { store, writer: writer.id, seq: buffer.seq }
              marks.mutate({ type: "put", trans: req.trans, values: [mark] }).then(
                (res) => res.numFailures > 0 && abortTransaction(req.trans),
                () => abortTransaction(req.trans)
              )
            }
            const encoded = buffer.mirror && (req.type === "add" || req.type === "put") ? req.values.map(tryEncode) : []
            return table.mutate(req).then((res) => {
              recordWrite(store, req, encoded, res, buffer.writes)
              return res
            })
          },
          get: (req) => {
            if (req.trans instanceof EmulatedTransaction) {
              return emulated(
                req.trans,
                () => getRequest(req.key),
                (value: string | undefined) => (value === undefined ? undefined : decodeValue(value)),
                (trans) => table.get({ ...req, trans })
              )
            }
            return shadow(
              req.trans,
              table.get(req),
              () => getRequest(req.key),
              digestValue,
              (value) => value ?? ""
            )
          },
          getMany: (req) => {
            const present = req.keys.flatMap((key, index) => (key == null ? [] : [index]))
            const read = (): ReadRequest<"getMany"> => ({
              type: "getMany",
              store,
              keys: present.map((index) => requestKey(req.keys[index])),
            })
            if (req.trans instanceof EmulatedTransaction) {
              return emulated(
                req.trans,
                read,
                (found: Array<string | undefined>) => {
                  const result: unknown[] = new Array(req.keys.length)
                  present.forEach((position, index) => {
                    const value = found[index]
                    result[position] = value === undefined ? undefined : decodeValue(value)
                  })
                  return result
                },
                (trans) => table.getMany({ ...req, trans })
              )
            }
            return shadow(
              req.trans,
              table.getMany(req),
              read,
              (values) => JSON.stringify(present.map((position) => digestValue(values[position]))),
              (found) => JSON.stringify(found.map((value) => value ?? ""))
            )
          },
          query: (req) => {
            const values = req.values === true
            if (req.trans instanceof EmulatedTransaction) {
              return emulated(
                req.trans,
                () => readQuery(req, store),
                (rows: MirrorRow[]) => ({
                  result: rows.map((row) => (values ? decodeValue(row.value as string) : decodeKey(row.primaryKey))),
                }),
                (trans) => table.query({ ...req, trans })
              )
            }
            return shadow(
              req.trans,
              table.query(req),
              () => readQuery(req, store),
              ({ result }) =>
                JSON.stringify(values ? result.map(digestValue) : result.map((key) => keyId(requestKey(key)))),
              (rows) => JSON.stringify(rows.map((row) => (values ? (row.value as string) : keyId(row.primaryKey))))
            )
          },
          count: (req) => {
            const read = (): ReadRequest<"count"> => ({
              type: "count",
              store,
              index: indexName(req.query.index),
              range: encodeRange(req.query.range),
            })
            if (req.trans instanceof EmulatedTransaction) {
              return emulated(
                req.trans,
                read,
                (count: number) => count,
                (trans) => table.count({ ...req, trans })
              )
            }
            return shadow(req.trans, table.count(req), read, String, String)
          },
          openCursor: (req) => {
            const tx = req.trans
            if (!(tx instanceof EmulatedTransaction)) return table.openCursor(req)
            const index = indexName(req.query.index)
            const unique = index !== null && req.unique === true
            const byPrimaryKey = index !== null && !unique
            const range = encodeRange(req.query.range)
            const page = (from: MirrorQueryStart | null): ReadRequest<"query"> => ({
              type: "query",
              store,
              query: {
                index,
                range,
                reverse: req.reverse === true,
                unique,
                values: req.values === true,
                limit: CURSOR_PAGE_ROWS,
                from,
              },
            })
            return emulated(
              tx,
              () => page(null),
              (firstPage: MirrorRow[]) =>
                materializedCursor({
                  trans: tx as unknown as DBCoreTransaction,
                  reverse: req.reverse === true,
                  byPrimaryKey,
                  firstPage,
                  fetchPage: (from) =>
                    emulated<MirrorRow[] | DBCoreCursor | null>(
                      tx,
                      () => page(from),
                      (rows: MirrorRow[]) => rows,
                      (trans) => table.openCursor({ ...req, trans })
                    ),
                }),
              (trans) => table.openCursor({ ...req, trans })
            )
          },
        }
      }

      return {
        ...down,
        transaction(stores, mode, options) {
          const mirror = currentMirror()
          if (mirror?.readWrite) {
            const mirrored = stores.filter(isMirrored)
            if (mirrored.length === stores.length) {
              return new EmulatedTransaction(mirror, stores, mode) as unknown as DBCoreTransaction
            }
            if (mirrored.length > 0) {
              throw new Error(
                `A transaction over ${stores.join(", ")} mixes stores SQLite serves with IndexedDB-only ones`
              )
            }
            return down.transaction(stores, mode, options)
          }
          if (mirror && mode === "readonly" && mirror.servesReads(stores)) {
            return new EmulatedTransaction(
              mirror,
              stores,
              "readonly",
              writers.overlapping(stores)
            ) as unknown as DBCoreTransaction
          }
          const marked = mode === "readwrite" ? stores.filter((store) => marksOf(store) !== null) : []
          const scope = marked.length > 0 ? [...stores, ...marked.map(sqliteMarksStore)] : stores
          const tx = down.transaction(scope, mode, options)
          if (marked.length > 0) bufferWrites(tx, mirror)
          if (mirror && mode === "readwrite") writers.track(tx, stores)
          return tx
        },
        table(name) {
          const table = down.table(name)
          return isMirroredStore(name) ? mirroredTable(table, marksOf(name)) : table
        },
      }
    },
  }
}
