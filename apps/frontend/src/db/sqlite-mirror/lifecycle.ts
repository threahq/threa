import { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { createBrowserMirror, type SqliteMirror } from "./client"
import { browserModeLock, isSqlitePrimary, markSqlitePrimary, readRecordedMode, type ModeLock } from "./storage-mode"
import { reportStorageBoot, reportStorageFailure, setStorageContext } from "./storage-diagnostics"

type CreateMirror = (database: ThreaDatabase, primary: boolean) => SqliteMirror

interface StorageBoot {
  lock: ModeLock
  createMirror: CreateMirror
}

/**
 * Boot, before IndexedDB opens. A database SQLite holds runs on SQLite at
 * once, never reading IndexedDB first. Any other imports IndexedDB into SQLite
 * when this boot holds every other tab out, and otherwise runs on IndexedDB
 * this session. `null` boots in browsers that cannot run SQLite storage.
 */
export function resumeSqliteMirror(database: ThreaDatabase, boot: StorageBoot | null = browserBoot(database)): void {
  database.sqliteBoot = boot ? bootStorage(database, boot) : refuseWithoutSqlite(database.name)
}

async function refuseWithoutSqlite(name: string): Promise<void> {
  if (isSqlitePrimary(name)) throw new Error(`SQLite holds the primary copy of ${name}, but cannot run in this tab`)
  runOnIndexedDb()
}

function browserBoot(database: ThreaDatabase): StorageBoot | null {
  if (typeof navigator === "undefined" || !navigator.locks || !navigator.storage?.getDirectory) return null
  if (typeof Worker === "undefined") return null
  return { lock: browserModeLock(database.name), createMirror: createBrowserMirror }
}

function runOnIndexedDb(): void {
  setStorageContext("off")
  reportStorageBoot(null)
}

async function bootStorage(database: ThreaDatabase, boot: StorageBoot): Promise<void> {
  const { name } = database
  const exclusive = isSqlitePrimary(name) ? null : await boot.lock.exclusive()
  if (!exclusive) await boot.lock.shared()
  const primary = isSqlitePrimary(name) || (await recordedReadWrite(name))
  const importing = exclusive !== null && primary === false
  const release = () => {
    if (!exclusive) return
    exclusive()
    void boot.lock.shared()
  }
  if (!primary && !importing) {
    release()
    return runOnIndexedDb()
  }
  if (importing && !(await upgradeInstalled(name))) {
    release()
    return runOnIndexedDb()
  }
  let mirror: SqliteMirror
  try {
    mirror = boot.createMirror(database, primary === true)
  } catch (error) {
    release()
    getPerfCapture().count("sqlite.mirrorFailure")
    if (primary)
      throw new Error(`SQLite holds the primary copy of ${name}, but cannot run in this tab`, { cause: error })
    console.error("SQLite storage could not start; this session runs on IndexedDB", error)
    return runOnIndexedDb()
  }
  setStorageContext("read-write")
  database.sqliteMirror = mirror
  mirror.start()
  // The import holds every other tab out until it ended; they then boot onto whichever copy it left primary.
  await mirror.beforeIdbOpen()
  release()
  if (!mirror.readWrite && importing) runOnIndexedDb()
}

/**
 * Runs the schema's upgrades on the installed IndexedDB, so the import copies
 * rows in the shape this build reads: upgrades that ran after it would find
 * the copied stores cleared and SQLite's rows never upgraded.
 */
async function upgradeInstalled(name: string): Promise<boolean> {
  const installed = new ThreaDatabase(name)
  try {
    await installed.open()
    return true
  } catch (error) {
    reportStorageFailure("import_failed")
    console.error(`IndexedDB ${name} could not be upgraded for the import; this session runs on IndexedDB`, error)
    return false
  } finally {
    installed.close()
  }
}

/** A database recorded read-write whose marker was lost; `null` when the recorded mode cannot be read. */
async function recordedReadWrite(name: string): Promise<boolean | null> {
  try {
    if ((await readRecordedMode(name)) !== "read-write") return false
    markSqlitePrimary(name)
    return true
  } catch (error) {
    reportStorageFailure("mode_unreadable")
    console.error(`Cannot tell whether SQLite holds ${name}; this session runs on IndexedDB`, error)
    return null
  }
}
