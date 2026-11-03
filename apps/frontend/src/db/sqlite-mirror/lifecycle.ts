import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { createBrowserMirror, type SqliteMirror, type SqliteMirrorMode } from "./client"

export const SQLITE_STORAGE_KEY = "threa:sqliteStorage"

export type SqliteStorageMode = "off" | SqliteMirrorMode

/** The mode persisted for this boot; anything unrecognised reads as off. */
export function readSqliteStorageMode(): SqliteStorageMode {
  if (typeof localStorage === "undefined") return "off"
  const stored = localStorage.getItem(SQLITE_STORAGE_KEY)
  return stored === "shadow" || stored === "read-only" ? stored : "off"
}

/** Persist the flag's value for the next boot; the running mirror is untouched unless the mode is off. */
export function persistSqliteStorageMode(mode: SqliteStorageMode): void {
  if (mode === "off") localStorage.removeItem(SQLITE_STORAGE_KEY)
  else localStorage.setItem(SQLITE_STORAGE_KEY, mode)
}

export function startSqliteMirror(
  database: ThreaDatabase,
  mode: SqliteMirrorMode,
  createMirror: (database: ThreaDatabase, mode: SqliteMirrorMode) => SqliteMirror = createBrowserMirror
): void {
  if (database.sqliteMirror) return
  try {
    const mirror = createMirror(database, mode)
    database.sqliteMirror = mirror
    mirror.start()
  } catch (error) {
    database.sqliteMirror = null
    getPerfCapture().count("sqlite.mirrorFailure")
    console.error("SQLite mirror could not start", error)
  }
}

/** Boot: a database opened under a persisted mode captures writes from its first transaction. */
export function resumeSqliteMirror(database: ThreaDatabase): void {
  const mode = readSqliteStorageMode()
  if (mode !== "off") startSqliteMirror(database, mode)
}

export async function stopAndDestroySqliteMirror(database: ThreaDatabase): Promise<void> {
  const mirror = database.sqliteMirror
  if (!mirror) return
  database.sqliteMirror = null
  await mirror.stop()
}
