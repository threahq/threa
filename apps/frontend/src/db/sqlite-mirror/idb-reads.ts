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
