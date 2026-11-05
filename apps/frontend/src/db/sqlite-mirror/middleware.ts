import type { DBCore, DBCoreIndex, DBCoreQueryRequest, DBCoreTable, DBCoreTransaction, Middleware } from "dexie"
import type { SqliteMirror } from "./client"
import { EmulatedTransaction } from "./emulated-transaction"
import { indexKeys } from "./index-keys"
import { decodeKey, encodeKey, encodeRange } from "./key-codec"
import { CURSOR_PAGE_ROWS, materializedCursor } from "./materialized-cursor"
import type { MirrorQueryStart, MirrorRow } from "./mirror-store"
import type { MirrorReadRequest } from "./protocol"
import { isMirroredStore } from "./stores"
import { decodeValue, encodeValue } from "./value-codec"

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

/**
 * Runs below every other DBCore middleware, so it sees exactly what would
 * reach IndexedDB. While SQLite serves, every transaction over mirrored
 * stores is emulated, its writes included, and never reaches IndexedDB;
 * stores SQLite never holds stay on IndexedDB. Otherwise every request goes
 * to IndexedDB as it is.
 */
export function createSqliteMirrorMiddleware(currentMirror: () => SqliteMirror | null): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "sqliteMirror",
    level: -10,
    create(down) {
      function emulated<T>(tx: EmulatedTransaction, request: () => MirrorReadRequest, decode: (result: never) => T) {
        return tx.run(() => tx.mirror.read({ ...request(), tx: tx.id }).then((r) => decode(r as never)))
      }

      /** IndexedDB's outcome for each entry: an `add` over an existing key fails alone, the rest still apply. */
      function emulatedMutate(
        tx: EmulatedTransaction,
        table: DBCoreTable,
        req: MutateRequest
      ): Promise<MutateResponse> {
        const store = table.name
        const id = tx.id
        if (tx.mode === "readonly") {
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
          if (!keyPath) throw new Error(`SQLite storage cannot key rows of ${store}`)
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

      function mirroredTable(table: DBCoreTable): DBCoreTable {
        const store = table.name
        return {
          ...table,
          mutate: (req) =>
            req.trans instanceof EmulatedTransaction ? emulatedMutate(req.trans, table, req) : table.mutate(req),
          get: (req) => {
            if (!(req.trans instanceof EmulatedTransaction)) return table.get(req)
            return emulated(
              req.trans,
              (): ReadRequest<"get"> => ({ type: "get", store, key: requestKey(req.key) }),
              (value: string | undefined) => (value === undefined ? undefined : decodeValue(value))
            )
          },
          getMany: (req) => {
            if (!(req.trans instanceof EmulatedTransaction)) return table.getMany(req)
            const present = req.keys.flatMap((key, index) => (key == null ? [] : [index]))
            return emulated(
              req.trans,
              (): ReadRequest<"getMany"> => ({
                type: "getMany",
                store,
                keys: present.map((index) => requestKey(req.keys[index])),
              }),
              (found: Array<string | undefined>) => {
                const result: unknown[] = new Array(req.keys.length)
                present.forEach((position, index) => {
                  const value = found[index]
                  result[position] = value === undefined ? undefined : decodeValue(value)
                })
                return result
              }
            )
          },
          query: (req) => {
            if (!(req.trans instanceof EmulatedTransaction)) return table.query(req)
            const values = req.values === true
            return emulated(
              req.trans,
              () => readQuery(req, store),
              (rows: MirrorRow[]) => ({
                result: rows.map((row) => (values ? decodeValue(row.value as string) : decodeKey(row.primaryKey))),
              })
            )
          },
          count: (req) => {
            if (!(req.trans instanceof EmulatedTransaction)) return table.count(req)
            return emulated(
              req.trans,
              (): ReadRequest<"count"> => ({
                type: "count",
                store,
                index: indexName(req.query.index),
                range: encodeRange(req.query.range),
              }),
              (count: number) => count
            )
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
                    emulated(
                      tx,
                      () => page(from),
                      (rows: MirrorRow[]) => rows
                    ),
                })
            )
          },
        }
      }

      return {
        ...down,
        transaction(stores, mode, options) {
          const mirror = currentMirror()
          if (!mirror?.readWrite) return down.transaction(stores, mode, options)
          const mirrored = stores.filter(isMirroredStore)
          if (mirrored.length === stores.length) {
            return new EmulatedTransaction(mirror, stores, mode) as unknown as DBCoreTransaction
          }
          if (mirrored.length > 0) {
            throw new Error(
              `A transaction over ${stores.join(", ")} mixes stores SQLite serves with IndexedDB-only ones`
            )
          }
          return down.transaction(stores, mode, options)
        },
        table(name) {
          const table = down.table(name)
          return isMirroredStore(name) ? mirroredTable(table) : table
        },
      }
    },
  }
}
