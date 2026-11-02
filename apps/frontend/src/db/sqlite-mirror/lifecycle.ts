import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { createBrowserMirror, type SqliteMirror, type SqliteMirrorMode } from "./client"
import { createBrowserGuard, type IdbGuard } from "./idb-guard"

export const SQLITE_STORAGE_KEY = "threa:sqliteStorage"

export type SqliteStorageMode = "off" | SqliteMirrorMode

/** The mode persisted for this boot; anything unrecognised reads as off. */
export function readSqliteStorageMode(): SqliteStorageMode {
  if (typeof localStorage === "undefined") return "off"
  const stored = localStorage.getItem(SQLITE_STORAGE_KEY)
  return stored === "shadow" || stored === "read-only" || stored === "read-write" ? stored : "off"
}

/** Persist the flag's value for the next boot; the running mirror is untouched unless the mode is off. */
export function persistSqliteStorageMode(mode: SqliteStorageMode): void {
  if (mode === "off") localStorage.removeItem(SQLITE_STORAGE_KEY)
  else localStorage.setItem(SQLITE_STORAGE_KEY, mode)
}

type CreateMirror = (database: ThreaDatabase, mode: SqliteMirrorMode, guard?: IdbGuard) => SqliteMirror

export function startSqliteMirror(
  database: ThreaDatabase,
  mode: SqliteMirrorMode,
  createMirror: CreateMirror = createBrowserMirror,
  guard?: IdbGuard
): void {
  if (database.sqliteMirror) return
  try {
    const mirror = createMirror(database, mode, guard)
    database.sqliteMirror = mirror
    mirror.start()
  } catch (error) {
    database.sqliteMirror = null
    getPerfCapture().count("sqlite.mirrorFailure")
    console.error("SQLite mirror could not start", error)
  }
}

/**
 * Boot: a database opened under a persisted mode captures writes from its
 * first transaction. Off, a tab writes IndexedDB itself once it holds the
 * shared lock and no session left SQLite holding writes IndexedDB lacks;
 * otherwise a mirror follows the tab serving read-write, or lands the backlog
 * and is destroyed, before IndexedDB opens.
 */
export function resumeSqliteMirror(
  database: ThreaDatabase,
  createMirror: CreateMirror = createBrowserMirror,
  guard: IdbGuard | null = browserGuard(database.name)
): void {
  const mode = readSqliteStorageMode()
  if (mode !== "off") return startSqliteMirror(database, mode, createMirror)
  if (!guard) return
  database.sqliteBoot = landPrimaryWrites(database, createMirror, guard)
}

/** Without Web Locks no tab can run a mirror, so none can have made SQLite the primary copy. */
function browserGuard(idbName: string): IdbGuard | null {
  return typeof navigator !== "undefined" && navigator.locks ? createBrowserGuard(idbName) : null
}

async function landPrimaryWrites(database: ThreaDatabase, createMirror: CreateMirror, guard: IdbGuard): Promise<void> {
  if ((await guard.holdNative(false)) && !(await guard.primaryMarked())) return
  startSqliteMirror(database, "shadow", createMirror, guard)
  const mirror = database.sqliteMirror
  if (!mirror) throw new Error("SQLite may hold writes IndexedDB lacks, and no mirror could start to land them")
  void mirror.whenWritingIdb().then(() => stopAndDestroySqliteMirror(database))
  await mirror.beforeIdbOpen()
}

/**
 * Only a tab writing IndexedDB itself drops its mirror. A read-write tab keeps
 * it, SQLite being the primary copy, and so does one still waiting for a
 * backlog to land; the mode changes on the next boot.
 */
export async function stopAndDestroySqliteMirror(database: ThreaDatabase): Promise<void> {
  const mirror = database.sqliteMirror
  if (!mirror?.writesIdb) return
  database.sqliteMirror = null
  await mirror.stop()
}
