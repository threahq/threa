import { decodeKey, type EncodedRange } from "./key-codec"
import type { MirrorMutation } from "./mirror-store"
import type { BacklogBatch, MirrorRequest } from "./protocol"
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

const BACKLOG_CHUNK_BATCHES = 100

/** Replays committed read-write transactions into IndexedDB, in order, in one transaction that resolves once on disk. */
function replayBacklog(idb: IDBDatabase, batches: readonly BacklogBatch[]): Promise<void> {
  const stores = [...new Set(batches.flatMap(({ batch }) => batch.map((mutation) => mutation.store)))]
  if (stores.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(stores, "readwrite", { durability: "strict" })
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
 * Lands SQLite's backlog in IndexedDB, oldest first, until the worker answers
 * it is empty; a batch leaves SQLite only once IndexedDB committed it. Raw
 * writes without marks: these rows came from SQLite, so a mark would only send
 * it to copy them again. Given a name, it lands in that database as installed.
 */
export async function drainBacklog(
  ask: (request: MirrorRequest) => Promise<{ batches?: BacklogBatch[] }>,
  into: IDBDatabase | string
): Promise<void> {
  const idb = typeof into === "string" ? await openInstalledIdb(into) : into
  try {
    for (;;) {
      const { batches = [] } = await ask({ type: "backlog", limit: BACKLOG_CHUNK_BATCHES })
      if (batches.length === 0) return
      await replayBacklog(idb, batches)
      await ask({ type: "backlogDone", through: batches[batches.length - 1].seq })
    }
  } finally {
    if (idb !== into) idb.close()
  }
}

/**
 * Opens the IndexedDB as it stands, at its installed version, so a backlog
 * written under that schema lands before any upgrade runs. Refuses to create
 * one: a backlog with no database to land in has nowhere safe to go.
 */
function openInstalledIdb(name: string): Promise<IDBDatabase> {
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
