import type { SqliteMirrorMode } from "./client"
import { transactionDone } from "./idb-reads"

export type SqliteStorageMode = "off" | SqliteMirrorMode

const MODE_DATABASE = "threa-sqlite-mode"
const MODE_STORE = "mode"
const RELOAD_CHANNEL = "threa-sqlite-storage-reload"
const SWITCH_RELOAD_KEY = "threa:sqliteSwitchReload"
const MAY_BE_READ_WRITE_PREFIX = "threa:sqliteMayBeReadWrite:"
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

/** Set before read-write is recorded and cleared only once another mode is, so a boot that cannot read the mode knows whether it may be read-write. */
export function mayBeReadWrite(idbName: string): boolean {
  return localStorage.getItem(`${MAY_BE_READ_WRITE_PREFIX}${idbName}`) !== null
}

export async function recordMode(idbName: string, mode: SqliteStorageMode): Promise<void> {
  const marker = `${MAY_BE_READ_WRITE_PREFIX}${idbName}`
  if (mode === "read-write") localStorage.setItem(marker, "1")
  const modes = await openModes()
  try {
    const tx = modes.transaction(MODE_STORE, "readwrite", { durability: "strict" })
    if (mode === "off") tx.objectStore(MODE_STORE).delete(idbName)
    else tx.objectStore(MODE_STORE).put(mode, idbName)
    await transactionDone(tx)
  } finally {
    modes.close()
  }
  if (mode !== "read-write") localStorage.removeItem(marker)
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
    // `await` flattens the callback's promise: TypeScript 5.9's DOM typings, which the deploy build uses, return Promise<Promise<T>>.
    ifShared: async (run) =>
      await navigator.locks.request(name, { mode: "shared", ifAvailable: true }, (lock) => run(lock !== null)),
  }
}

const restartPending = new Set<string>()
let restartDismissed = false
const restartListeners = new Set<() => void>()

/**
 * The flag asks for a mode this session cannot switch to while other tabs run
 * it, or while it holds no worker: the user restarts every tab to switch, as
 * for an app update. Nothing reloads on its own.
 */
export function requestStorageRestart(idbName: string): void {
  if (restartPending.has(idbName)) return
  restartPending.add(idbName)
  for (const listener of restartListeners) listener()
}

/** Whether any database of this page waits for a restart the user has not waved off this session. */
export function isStorageRestartPending(): boolean {
  return restartPending.size > 0 && !restartDismissed
}

export function dismissStorageRestart(): void {
  restartDismissed = true
  for (const listener of restartListeners) listener()
}

export function onStorageRestartPending(listener: () => void): () => void {
  restartListeners.add(listener)
  return () => restartListeners.delete(listener)
}

export function resetStorageRestartForTests(): void {
  restartPending.clear()
  restartDismissed = false
}

/** Every tab of this origin boots again, under the modes recorded meanwhile; only the user asks for it. */
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

let listening = false

export function reloadWhenAsked(): void {
  if (listening) return
  listening = true
  new BroadcastChannel(RELOAD_CHANNEL).onmessage = reloadToSwitch
}
