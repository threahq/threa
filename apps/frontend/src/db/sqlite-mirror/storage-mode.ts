import type { SqliteMirrorMode } from "./client"

export type SqliteStorageMode = "off" | SqliteMirrorMode

const MODE_DATABASE = "threa-sqlite-mode"
const MODE_STORE = "mode"
const RELOAD_CHANNEL = "threa-sqlite-storage-reload"

function done(request: IDBRequest | IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (request instanceof IDBTransaction) {
      request.oncomplete = () => resolve()
      request.onabort = () => reject(request.error ?? new DOMException("Mode write aborted", "AbortError"))
    } else {
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }
  })
}

function openModes(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODE_DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(MODE_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * The mode every tab of a database runs, durable across a browser kill: a tab
 * never runs another, so read-write's SQLite is the primary copy exactly while
 * this says so. Changes only at a boot holding every other tab out.
 */
export async function readRecordedMode(idbName: string): Promise<SqliteStorageMode> {
  const modes = await openModes()
  try {
    const read = modes.transaction(MODE_STORE).objectStore(MODE_STORE).get(idbName)
    await done(read)
    const mode: unknown = read.result
    return mode === "shadow" || mode === "read-only" || mode === "read-write" ? mode : "off"
  } finally {
    modes.close()
  }
}

export async function recordMode(idbName: string, mode: SqliteStorageMode): Promise<void> {
  const modes = await openModes()
  try {
    const tx = modes.transaction(MODE_STORE, "readwrite", { durability: "strict" })
    if (mode === "off") tx.objectStore(MODE_STORE).delete(idbName)
    else tx.objectStore(MODE_STORE).put(mode, idbName)
    await done(tx)
  } finally {
    modes.close()
  }
}

/** Every tab of a database holds the shared side for its life; a boot changing the mode holds the exclusive side, so no other tab runs meanwhile. */
export interface ModeLock {
  /** The exclusive side, resolving to its release, or `null` when another tab still runs after `waitMs`. */
  exclusive(waitMs: number): Promise<(() => void) | null>
  /** The shared side, held for the rest of this tab's life. */
  shared(): Promise<void>
}

export function browserModeLock(idbName: string): ModeLock {
  const name = `threa-sqlite-mode:${idbName}`
  return {
    exclusive: (waitMs) =>
      new Promise((resolve) => {
        navigator.locks
          .request(
            name,
            { signal: AbortSignal.timeout(waitMs) },
            () => new Promise<void>((release) => resolve(release))
          )
          .catch(() => resolve(null))
      }),
    shared: () =>
      new Promise((resolve) => {
        void navigator.locks.request(name, { mode: "shared" }, () => {
          resolve()
          return new Promise<never>(() => {})
        })
      }),
  }
}

/** Every tab of this origin boots again, under the modes recorded meanwhile. */
export function reloadEveryTab(): void {
  const channel = new BroadcastChannel(RELOAD_CHANNEL)
  channel.postMessage("reload")
  channel.close()
  window.location.reload()
}

let listening = false

export function reloadWhenAsked(): void {
  if (listening) return
  listening = true
  new BroadcastChannel(RELOAD_CHANNEL).onmessage = () => window.location.reload()
}
