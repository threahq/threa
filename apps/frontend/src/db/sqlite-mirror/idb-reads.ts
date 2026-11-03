import type { DBCoreKeyRange } from "dexie"
import type { IdbWrite } from "./middleware"

/** What a committed write touched: the keys or key range IndexedDB must be asked about again. */
export type Touched = { store: string; keys: IDBValidKey[] } | { store: string; range: DBCoreKeyRange }

export function touchedOf(write: IdbWrite): Touched {
  return write.op === "deleteRange"
    ? { store: write.store, range: write.range }
    : { store: write.store, keys: write.keys }
}

export type TouchedRows = Touched & { found: { keys: IDBValidKey[]; values: unknown[] } }

const NEVER = Symbol("never")

function toIdbRange(range: DBCoreKeyRange): IDBKeyRange | null | typeof NEVER {
  if (range.type === 3) return null
  if (range.type === 4) return NEVER
  if (range.type === 1) return IDBKeyRange.only(range.lower)
  const { lower, upper, lowerOpen = false, upperOpen = false } = range
  if (lower === undefined) return upper === undefined ? null : IDBKeyRange.upperBound(upper, upperOpen)
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, lowerOpen)
  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen)
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"))
  })
}

/** Reads one primary-key-ordered chunk of a store, straight from IndexedDB. */
export async function readChunk(
  idb: IDBDatabase,
  store: string,
  after: IDBValidKey | undefined,
  limit: number
): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  const tx = idb.transaction(store, "readonly")
  const source = tx.objectStore(store)
  const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true)
  const keys = source.getAllKeys(range, limit)
  const values = source.getAll(range, limit)
  await transactionDone(tx)
  return { keys: keys.result, values: values.result }
}

export async function countRows(idb: IDBDatabase, stores: string[]): Promise<number> {
  if (stores.length === 0) return 0
  const tx = idb.transaction(stores, "readonly")
  const counts = stores.map((store) => tx.objectStore(store).count())
  await transactionDone(tx)
  return counts.reduce((sum, count) => sum + count.result, 0)
}

/**
 * Reads what IndexedDB holds now for each touched key or range (a missing key
 * reads as `undefined`) and hands the rows to `onRead` before the transaction
 * ends. A readwrite transaction overlapping these stores cannot commit until
 * this one finishes, so whatever `onRead` sends is ordered before that commit.
 */
export async function readTouched(
  idb: IDBDatabase,
  touched: readonly Touched[],
  onRead: (rows: TouchedRows[]) => void
): Promise<void> {
  const stores = [...new Set(touched.map((t) => t.store))]
  // A commit whose every write failed touched nothing, and IndexedDB refuses a transaction over no store.
  if (stores.length === 0) return onRead([])
  const tx = idb.transaction(stores, "readonly")
  const done = transactionDone(tx)
  const rows: TouchedRows[] = []
  let outstanding = 0
  const read = <T>(request: IDBRequest<T>, store: (result: T) => void) => {
    outstanding++
    request.onsuccess = () => {
      store(request.result)
      if (--outstanding === 0) onRead(rows)
    }
  }
  for (const entry of touched) {
    const source = tx.objectStore(entry.store)
    if ("keys" in entry) {
      const found = { keys: entry.keys, values: new Array<unknown>(entry.keys.length) }
      rows.push({ ...entry, found })
      entry.keys.forEach((key, index) => read(source.get(key), (value) => (found.values[index] = value)))
    } else {
      const range = toIdbRange(entry.range)
      if (range === NEVER) continue
      const found: TouchedRows["found"] = { keys: [], values: [] }
      rows.push({ ...entry, found })
      read(source.getAllKeys(range), (keys) => (found.keys = keys))
      read(source.getAll(range), (values) => (found.values = values))
    }
  }
  if (outstanding === 0) onRead(rows)
  return done
}
