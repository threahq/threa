import { decodeKey, type EncodedRange } from "./key-codec"
import type { MirrorMutation } from "./mirror-store"
import type { BacklogBatch } from "./protocol"
import { decodeValue } from "./value-codec"

function toIdbRange(range: EncodedRange): IDBKeyRange | null {
  const lower = range.lower ? decodeKey(range.lower) : undefined
  const upper = range.upper ? decodeKey(range.upper) : undefined
  if (lower === undefined) return upper === undefined ? null : IDBKeyRange.upperBound(upper, range.upperOpen)
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, range.lowerOpen)
  return IDBKeyRange.bound(lower, upper, range.lowerOpen, range.upperOpen)
}

function replay(tx: IDBTransaction, mutation: MirrorMutation): void {
  const store = tx.objectStore(mutation.store)
  if (mutation.op === "put") {
    const outbound = store.keyPath === null
    for (const entry of mutation.entries) {
      const value = decodeValue(entry.value)
      if (outbound) store.put(value, decodeKey(entry.key))
      else store.put(value)
    }
  } else if (mutation.op === "delete") {
    for (const key of mutation.keys) store.delete(decodeKey(key))
  } else {
    const range = toIdbRange(mutation.range)
    if (range) store.delete(range)
    else store.clear()
  }
}

/** Replays committed read-write transactions into IndexedDB, in order, in one transaction that resolves on `complete`. */
export function replayBacklog(idb: IDBDatabase, batches: readonly BacklogBatch[]): Promise<void> {
  const stores = [...new Set(batches.flatMap(({ batch }) => batch.map((mutation) => mutation.store)))]
  if (stores.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(stores, "readwrite", { durability: "relaxed" })
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new DOMException("Backlog replay aborted", "AbortError"))
    try {
      for (const { batch } of batches) for (const mutation of batch) replay(tx, mutation)
    } catch (error) {
      tx.abort()
      reject(error)
    }
  })
}

/**
 * Opens the IndexedDB as it stands, at its installed version, so a backlog
 * written under that schema lands before any upgrade runs. Refuses to create
 * one: a backlog with no database to land in has nowhere safe to go.
 */
export function openInstalledIdb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => {
      request.transaction?.abort()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(new Error(`IndexedDB ${name} is missing, so the SQLite backlog cannot land`, { cause: request.error }))
  })
}
