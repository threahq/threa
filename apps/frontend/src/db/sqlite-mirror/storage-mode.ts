import type { SqliteMirrorMode } from "./client"
import { transactionDone } from "./idb-reads"

export type SqliteStorageMode = "off" | SqliteMirrorMode

const MODE_DATABASE = "threa-sqlite-mode"
const MODE_STORE = "mode"
const RELOAD_CHANNEL = "threa-sqlite-storage-reload"
const SWITCH_RELOAD_KEY = "threa:sqliteSwitchReload"
const MODE_RELOAD_PREFIX = "threa:sqliteModeReload:"
export const REQUESTED_PREFIX = "threa:sqliteStorage:"

export function parseMode(stored: string | null): SqliteStorageMode {
  return stored === "shadow" || stored === "read-only" || stored === "read-write" ? stored : "off"
}

/** The mode the flag asked for this database; anything unrecognised reads as off. */
export function readSqliteStorageMode(idbName: string): SqliteStorageMode {
  if (typeof localStorage === "undefined") return "off"
  return parseMode(localStorage.getItem(`${REQUESTED_PREFIX}${idbName}`))
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
    const tx = modes.transaction(MODE_STORE)
    const read = tx.objectStore(MODE_STORE).get(idbName)
    await transactionDone(tx)
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
    await transactionDone(tx)
  } finally {
    modes.close()
  }
}

/** Every tab of a database holds the shared side for its life; a boot changing the mode holds the exclusive side, so no other tab runs meanwhile. */
export interface ModeLock {
  /** The exclusive side, resolving to its release, or `null` when another tab still runs after `waitMs`, or at once for 0. */
  exclusive(waitMs: number): Promise<(() => void) | null>
  /** The shared side, held for the rest of this tab's life. */
  shared(): Promise<void>
  /** Runs `run` holding the shared side if no tab holds or awaits the exclusive one, else without it; never waits. */
  ifShared<T>(run: (held: boolean) => Promise<T>): Promise<T>
}

export function browserModeLock(idbName: string): ModeLock {
  const name = `threa-sqlite-mode:${idbName}`
  return {
    exclusive: (waitMs) =>
      new Promise((resolve) => {
        const hold = (lock: Lock | null) => {
          if (!lock) return resolve(null)
          return new Promise<void>((release) => resolve(release))
        }
        const options = waitMs > 0 ? { signal: AbortSignal.timeout(waitMs) } : { ifAvailable: true }
        navigator.locks.request(name, options, hold).catch(() => resolve(null))
      }),
    shared: () =>
      new Promise((resolve) => {
        void navigator.locks.request(name, { mode: "shared" }, () => {
          resolve()
          return new Promise<never>(() => {})
        })
      }),
    ifShared: (run) =>
      navigator.locks.request(name, { mode: "shared", ifAvailable: true }, (lock) => run(lock !== null)),
  }
}

/** Every tab of this origin boots again, under the modes recorded meanwhile. */
export function reloadEveryTab(): void {
  const channel = new BroadcastChannel(RELOAD_CHANNEL)
  channel.postMessage("reload")
  channel.close()
  reloadToSwitch()
}

/** Marks the next boot as one that may wait for the other tabs, all reloading too, to close. */
function reloadToSwitch(): void {
  sessionStorage.setItem(SWITCH_RELOAD_KEY, "1")
  window.location.reload()
}

/** Whether this tab reloaded for a mode switch; only the first boot after it asks. */
export function takeSwitchReload(): boolean {
  if (typeof sessionStorage === "undefined") return false
  const took = sessionStorage.getItem(SWITCH_RELOAD_KEY) !== null
  sessionStorage.removeItem(SWITCH_RELOAD_KEY)
  return took
}

/**
 * Why a tab reloads every tab for a mode it does not run: a switch a plain boot
 * could not take, or read-write once SQLite holds every store. Each fires once
 * per tab session until the requested mode runs, so a failing switch cannot loop.
 */
export type ModeReload = "switch" | "enter"

export function takeModeReload(idbName: string, reason: ModeReload): boolean {
  const key = `${MODE_RELOAD_PREFIX}${reason}:${idbName}`
  if (sessionStorage.getItem(key) !== null) return false
  sessionStorage.setItem(key, "1")
  return true
}

export function ranRequestedMode(idbName: string): void {
  for (const reason of ["switch", "enter"] satisfies ModeReload[]) {
    sessionStorage.removeItem(`${MODE_RELOAD_PREFIX}${reason}:${idbName}`)
  }
}

let listening = false

export function reloadWhenAsked(): void {
  if (listening) return
  listening = true
  new BroadcastChannel(RELOAD_CHANNEL).onmessage = reloadToSwitch
}
