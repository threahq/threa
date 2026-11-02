import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { createBrowserMirror, type SqliteMirror } from "./client"

export const SQLITE_STORAGE_KEY = "threa:sqliteStorage"

export type SqliteStorageMode = "off" | "shadow"

/** The mode persisted for this boot; anything unrecognised reads as off. */
export function readSqliteStorageMode(): SqliteStorageMode {
  if (typeof localStorage === "undefined") return "off"
  return localStorage.getItem(SQLITE_STORAGE_KEY) === "shadow" ? "shadow" : "off"
}

/** Persist the flag's value for the next boot; the running mirror is untouched unless the mode is off. */
export function persistSqliteStorageMode(mode: SqliteStorageMode): void {
  if (mode === "off") localStorage.removeItem(SQLITE_STORAGE_KEY)
  else localStorage.setItem(SQLITE_STORAGE_KEY, mode)
}

export function startSqliteShadow(
  database: ThreaDatabase,
  createMirror: (database: ThreaDatabase) => SqliteMirror = createBrowserMirror
): void {
  if (database.sqliteMirror) return
  try {
    const mirror = createMirror(database)
    database.sqliteMirror = mirror
    mirror.start()
  } catch (error) {
    database.sqliteMirror = null
    getPerfCapture().count("sqlite.mirrorFailure")
    console.error("SQLite mirror could not start", error)
  }
}

/** Boot: a database opened under a persisted shadow mode captures writes from its first transaction. */
export function resumeSqliteShadow(database: ThreaDatabase): void {
  if (readSqliteStorageMode() === "shadow") startSqliteShadow(database)
}

export async function stopAndDestroySqliteShadow(database: ThreaDatabase): Promise<void> {
  const mirror = database.sqliteMirror
  if (!mirror) return
  database.sqliteMirror = null
  await mirror.stop({ destroy: true })
}
