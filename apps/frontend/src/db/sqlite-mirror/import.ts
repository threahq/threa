import { getPerfCapture } from "@/lib/perf/capture"
import { countRows, readChunk, transactionDone } from "./idb-reads"
import { encodeKey } from "./key-codec"
import { SQLITE_INCARNATION_STORE, isSqliteMarksStore } from "./marks"
import type { MirrorEntry } from "./mirror-store"
import type { MirrorReply, MirrorRequest } from "./protocol"
import { reportStorageUpgrade } from "./storage-mode"
import { isMirroredStore } from "./stores"
import { encodeValue } from "./value-codec"

const IMPORT_CHUNK_ROWS = 500

type Ask = (request: MirrorRequest) => Promise<Extract<MirrorReply, { ok: true }>>

/** The installed database as it stands, without upgrading it; `null` when there is none. */
export function openInstalled(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    let absent = false
    // Aborting the upgrade that would create it leaves no database behind.
    request.onupgradeneeded = () => {
      absent = true
      request.transaction?.abort()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => (absent ? resolve(null) : reject(request.error))
  })
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function encodeRows(store: string, keys: readonly IDBValidKey[], values: readonly unknown[]): MirrorEntry[] {
  try {
    return keys.map((key, index) => ({ key: encodeKey(key), value: encodeValue(values[index]) }))
  } catch (error) {
    throw new Error(`Cannot represent a row of ${store}`, { cause: error })
  }
}

/**
 * Copies every row IndexedDB holds of `stores` into SQLite, replacing what
 * SQLite held of them, then runs `record`, after which SQLite is the primary
 * copy. The copied stores, and the bookkeeping older builds kept beside them,
 * are cleared from IndexedDB after that, in the background: nothing reads them
 * again. Progress drives the upgrade lock the app waits behind.
 */
export async function importIndexedDb(
  name: string,
  stores: readonly string[],
  ask: Ask,
  record: () => Promise<void>
): Promise<void> {
  const startedAt = performance.now()
  const idb = await openInstalled(name)
  try {
    const present = idb ? stores.filter((store) => idb.objectStoreNames.contains(store)) : []
    const progress = { copied: 0, total: null as number | null }
    reportStorageUpgrade({ ...progress })
    progress.total = idb ? await countRows(idb, present) : 0
    reportStorageUpgrade({ ...progress })
    await ask({ type: "backfillBegin", stores })
    for (const store of present) {
      let last: IDBValidKey | undefined
      for (;;) {
        const rows = await readChunk(idb!, store, last, IMPORT_CHUNK_ROWS)
        if (rows.keys.length === 0) break
        await ask({ type: "backfillChunk", store, entries: encodeRows(store, rows.keys, rows.values) })
        progress.copied += rows.keys.length
        reportStorageUpgrade({ ...progress })
        last = rows.keys[rows.keys.length - 1]
        await yieldToEventLoop()
      }
    }
    // Commits are not flushed one by one, and IndexedDB is cleared once SQLite is the primary copy.
    await ask({ type: "checkpoint" })
    await record()
    getPerfCapture().mark("sqlite.import", performance.now() - startedAt)
  } catch (error) {
    idb?.close()
    throw error
  } finally {
    reportStorageUpgrade(null)
  }
  if (idb) void clearImported(idb)
}

async function clearImported(idb: IDBDatabase): Promise<void> {
  // An upgrade by this tab's own open, or another tab's, must not wait for the clear.
  idb.onversionchange = () => idb.close()
  try {
    const cleared = [...idb.objectStoreNames].filter(
      (store) => isMirroredStore(store) || isSqliteMarksStore(store) || store === SQLITE_INCARNATION_STORE
    )
    if (cleared.length === 0) return
    const tx = idb.transaction(cleared, "readwrite")
    for (const store of cleared) tx.objectStore(store).clear()
    await transactionDone(tx)
  } catch (error) {
    console.error("SQLite storage could not clear the IndexedDB stores it imported", error)
  } finally {
    idb.close()
  }
}
