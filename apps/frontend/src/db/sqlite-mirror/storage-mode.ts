import { transactionDone } from "./idb-reads"

/** Recorded per database by every build that ran SQLite storage; this build records only read-write. */
export type SqliteStorageMode = "off" | "shadow" | "read-only" | "read-write"

const MODE_DATABASE = "threa-sqlite-mode"
const MODE_STORE = "mode"
const PRIMARY_PREFIX = "threa:sqlitePrimary:"
/** Builds that ran SQLite behind the flag read it when their recorded mode is unreadable. */
const FLAG_BUILD_PRIMARY_PREFIX = "threa:sqliteMayBeReadWrite:"
/** The mode builds that ran it behind the `sqliteStorage` flag ask for; read-write keeps one of them from leaving it. */
const REQUESTED_PREFIX = "threa:sqliteStorage:"

function openModes(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODE_DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(MODE_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Durable across a browser kill; SQLite holds a database's primary copy once this says read-write. */
export async function readRecordedMode(idbName: string): Promise<SqliteStorageMode> {
  const modes = await openModes()
  try {
    const tx = modes.transaction(MODE_STORE)
    const read = tx.objectStore(MODE_STORE).get(idbName)
    await transactionDone(tx)
    const mode: unknown = read.result
    return mode === "shadow" || mode === "read-only" || mode === "read-write" ? mode : "off"
  } finally {
    modes.close()
  }
}

/**
 * Set only once read-write is recorded, and never cleared, so a boot knows without reading IndexedDB that SQLite is
 * the primary copy. Builds that ran SQLite behind the flag set `threa:sqliteMayBeReadWrite:` before recording a mode,
 * so theirs proves nothing; their recorded mode decides instead.
 */
export function isSqlitePrimary(idbName: string): boolean {
  return localStorage.getItem(`${PRIMARY_PREFIX}${idbName}`) !== null
}

/** Earlier builds set this before recording read-write, so it holds only when the recorded mode cannot be read. */
export function mayBeSqlitePrimary(idbName: string): boolean {
  return localStorage.getItem(`${FLAG_BUILD_PRIMARY_PREFIX}${idbName}`) !== null
}

/** The recorded mode stays the durable truth: a marker this fails to set is set again by the boot that reads it. */
export function markSqlitePrimary(idbName: string): void {
  try {
    localStorage.setItem(`${PRIMARY_PREFIX}${idbName}`, "1")
    localStorage.setItem(`${FLAG_BUILD_PRIMARY_PREFIX}${idbName}`, "1")
    localStorage.setItem(`${REQUESTED_PREFIX}${idbName}`, "read-write")
  } catch (error) {
    console.error(`Could not mark SQLite as the primary copy of ${idbName}`, error)
  }
}

/** SQLite becomes the primary copy of `idbName`, for this build and every older one. */
export async function recordReadWrite(idbName: string): Promise<void> {
  const modes = await openModes()
  try {
    const tx = modes.transaction(MODE_STORE, "readwrite", { durability: "strict" })
    tx.objectStore(MODE_STORE).put("read-write", idbName)
    await transactionDone(tx)
  } finally {
    modes.close()
  }
  markSqlitePrimary(idbName)
}

/** Every tab of a database holds the shared side for its life; the boot copying IndexedDB into SQLite holds the exclusive side. */
export interface ModeLock {
  /** The exclusive side, resolving to its release, or `null` at once when another tab holds either side. */
  exclusive(): Promise<(() => void) | null>
  /** The shared side, held for the rest of this tab's life. */
  shared(): Promise<void>
}

export function browserModeLock(idbName: string): ModeLock {
  const name = `threa-sqlite-mode:${idbName}`
  return {
    exclusive: () =>
      new Promise((resolve) => {
        navigator.locks
          .request(name, { ifAvailable: true }, (lock) => {
            if (!lock) return resolve(null)
            return new Promise<void>((release) => resolve(release))
          })
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

/** Rows copied into SQLite so far, of `total`; `null` until the rows are counted. */
export interface StorageUpgradeProgress {
  copied: number
  total: number | null
}

let upgrade: StorageUpgradeProgress | null = null
const upgradeListeners = new Set<() => void>()

/** A device's first boot on SQLite storage copies IndexedDB into it; the app waits behind a lock meanwhile. */
export function storageUpgrade(): StorageUpgradeProgress | null {
  return upgrade
}

export function reportStorageUpgrade(progress: StorageUpgradeProgress | null): void {
  upgrade = progress
  for (const listener of upgradeListeners) listener()
}

export function onStorageUpgrade(listener: () => void): () => void {
  upgradeListeners.add(listener)
  return () => upgradeListeners.delete(listener)
}

export function resetStorageUpgradeForTests(): void {
  upgrade = null
}
