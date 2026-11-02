const MARKER_DATABASE = "threa-sqlite-primary"
const MARKER_STORE = "primary"

/**
 * Keeps a tab that writes IndexedDB itself and a tab serving read-write from
 * SQLite apart: one Web Lock, shared by every tab writing IndexedDB, exclusive
 * for the tab whose SQLite is the primary copy.
 */
export interface IdbGuard {
  /**
   * Holds the shared side for the rest of this tab's life. With `wait` unset,
   * `false` when a tab serves read-write now; with it set, waits for that tab to stop.
   */
  holdNative(wait: boolean): Promise<boolean>
  /** The exclusive side, granted only while no tab writes IndexedDB itself; held until released. */
  claimPrimary(): Promise<boolean>
  releasePrimary(): void
  /** Whether SQLite may hold writes IndexedDB lacks, durable across a browser kill. */
  primaryMarked(): Promise<boolean>
  /** Set before the first write only SQLite holds; cleared once its backlog reached IndexedDB. */
  markPrimary(primary: boolean): Promise<void>
}

function done(request: IDBRequest | IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (request instanceof IDBTransaction) {
      request.oncomplete = () => resolve()
      request.onabort = () => reject(request.error ?? new DOMException("Marker write aborted", "AbortError"))
    } else {
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }
  })
}

/** `null` when the marker database was never created: then no session ever went primary. */
function openMarkers(create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = create ? indexedDB.open(MARKER_DATABASE, 1) : indexedDB.open(MARKER_DATABASE)
    request.onupgradeneeded = () => {
      if (create) request.result.createObjectStore(MARKER_STORE)
      else request.transaction?.abort()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => (create ? reject(request.error) : resolve(null))
  })
}

export async function primaryMarked(idbName: string): Promise<boolean> {
  const markers = await openMarkers(false)
  if (!markers) return false
  try {
    const count = markers.transaction(MARKER_STORE).objectStore(MARKER_STORE).count(idbName)
    await done(count)
    return count.result > 0
  } finally {
    markers.close()
  }
}

export async function markPrimary(idbName: string, primary: boolean): Promise<void> {
  const markers = await openMarkers(true)
  if (!markers) throw new Error("The SQLite primary marker database could not open")
  try {
    const tx = markers.transaction(MARKER_STORE, "readwrite", { durability: "strict" })
    if (primary) tx.objectStore(MARKER_STORE).put(true, idbName)
    else tx.objectStore(MARKER_STORE).delete(idbName)
    await done(tx)
  } finally {
    markers.close()
  }
}

export function createBrowserGuard(idbName: string): IdbGuard {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Web Locks API is unavailable")
  const lock = `threa-idb-native:${idbName}`
  let native = false
  let releasePrimary = () => {}
  return {
    async holdNative(wait) {
      if (native) return true
      const held = await new Promise<boolean>((resolve) => {
        void navigator.locks.request(lock, { mode: "shared", ifAvailable: !wait }, (granted) => {
          resolve(granted !== null)
          return granted ? new Promise<never>(() => {}) : undefined
        })
      })
      native ||= held
      return held
    },
    claimPrimary: () =>
      new Promise((resolve) => {
        void navigator.locks.request(lock, { ifAvailable: true }, (granted) => {
          resolve(granted !== null)
          return granted ? new Promise<void>((release) => (releasePrimary = release)) : undefined
        })
      }),
    releasePrimary: () => releasePrimary(),
    primaryMarked: () => primaryMarked(idbName),
    markPrimary: (primary) => markPrimary(idbName, primary),
  }
}
