import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import {
  DEFAULT_DEADLINES,
  createBrowserMirror,
  mirroredSchema,
  withProgressDeadline,
  type SqliteMirror,
  type SqliteMirrorMode,
} from "./client"
import { drainBacklog } from "./idb-backlog"
import type { MirrorRequest, MirrorTransport } from "./protocol"
import {
  browserModeLock,
  readRecordedMode,
  recordMode,
  reloadWhenAsked,
  type ModeLock,
  type SqliteStorageMode,
} from "./storage-mode"
import { createWorkerTransport } from "./worker-transport"

const SQLITE_STORAGE_KEY = "threa:sqliteStorage"

/** How long a boot changing the mode waits for the other tabs to close; past it, it boots under the recorded mode. */
const SWITCH_WAIT_MS = 5_000

/** The mode the flag asked for; anything unrecognised reads as off. */
export function readSqliteStorageMode(): SqliteStorageMode {
  if (typeof localStorage === "undefined") return "off"
  const stored = localStorage.getItem(SQLITE_STORAGE_KEY)
  return stored === "shadow" || stored === "read-only" || stored === "read-write" ? stored : "off"
}

export function persistSqliteStorageMode(mode: SqliteStorageMode): void {
  if (mode === "off") localStorage.removeItem(SQLITE_STORAGE_KEY)
  else localStorage.setItem(SQLITE_STORAGE_KEY, mode)
}

type CreateMirror = (database: ThreaDatabase, mode: SqliteMirrorMode, entering: boolean) => SqliteMirror

interface StorageBoot {
  lock: ModeLock
  createMirror: CreateMirror
  createTransport: () => MirrorTransport
  switchWaitMs?: number
}

export function startSqliteMirror(
  database: ThreaDatabase,
  mode: SqliteMirrorMode,
  createMirror: CreateMirror = createBrowserMirror,
  entering = false
): void {
  if (database.sqliteMirror) return
  try {
    const mirror = createMirror(database, mode, entering)
    database.sqliteMirror = mirror
    mirror.start()
  } catch (error) {
    database.sqliteMirror = null
    getPerfCapture().count("sqlite.mirrorFailure")
    console.error("SQLite mirror could not start", error)
  }
}

/**
 * Boot, before IndexedDB opens: the tab runs the database's recorded mode.
 * Only a boot holding every other tab out changes it to the flag's, landing
 * SQLite's backlog first when leaving read-write; entering read-write is
 * decided by the mirror, once it knows SQLite holds every store in full.
 */
export function resumeSqliteMirror(database: ThreaDatabase, boot: StorageBoot | null = browserBoot(database)): void {
  if (boot) database.sqliteBoot = bootStorage(database, boot)
}

/** Without Web Locks no tab can run a mirror, so none can have made SQLite the primary copy. */
function browserBoot(database: ThreaDatabase): StorageBoot | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null
  reloadWhenAsked()
  return {
    lock: browserModeLock(database.name),
    createMirror: createBrowserMirror,
    createTransport: createWorkerTransport,
  }
}

async function bootStorage(database: ThreaDatabase, boot: StorageBoot): Promise<void> {
  const { name } = database
  const requested = readSqliteStorageMode()
  const switching = requested !== (await readRecordedMode(name))
  const release = switching ? await boot.lock.exclusive(boot.switchWaitMs ?? SWITCH_WAIT_MS) : null
  if (!release) await boot.lock.shared()
  let mode = await readRecordedMode(name)
  const entering = release !== null && requested === "read-write" && mode !== "read-write"
  if (release && !entering && mode !== requested) mode = await switchMode(database, mode, requested, boot)
  const running = entering ? "read-write" : mode
  if (running !== "off") startSqliteMirror(database, running, boot.createMirror, entering)
  const mirror = database.sqliteMirror
  if (release) {
    // Entering read-write holds the others out until the mirror decided, recording the mode before any of them boots.
    void (entering && mirror ? mirror.whenRoutable() : Promise.resolve()).then(() => {
      release()
      return boot.lock.shared()
    })
  }
  await mirror?.beforeIdbOpen()
}

/** The mode this boot runs: `to` once recorded, or `from` when its backlog could not land. */
async function switchMode(
  database: ThreaDatabase,
  from: SqliteStorageMode,
  to: SqliteStorageMode,
  boot: StorageBoot
): Promise<SqliteStorageMode> {
  try {
    if (from === "read-write" || to === "off") await settleSqlite(database, from === "read-write", to === "off", boot)
    await recordMode(database.name, to)
    return to
  } catch (error) {
    getPerfCapture().count("sqlite.drainFailure")
    console.error(`SQLite storage stays ${from}: switching to ${to} failed`, error)
    return from
  }
}

/** Lands the backlog under the schema it was written in, strictly durable, until the worker answers it is empty; then drops the file. */
async function settleSqlite(
  database: ThreaDatabase,
  drain: boolean,
  destroy: boolean,
  boot: StorageBoot
): Promise<void> {
  const transport = boot.createTransport()
  const ask = async (request: MirrorRequest) => {
    const reply = await withProgressDeadline(
      transport,
      transport.request(request),
      DEFAULT_DEADLINES.workerMs,
      `SQLite ${request.type}`
    )
    if (!reply.ok) throw new DOMException(reply.message, reply.error)
    return reply
  }
  try {
    if (drain) {
      const { name, verno } = database
      await ask({ type: "open", idbName: name, schema: mirroredSchema(database), idbVersion: verno })
      await drainBacklog(ask, name)
    }
    if (destroy) await ask({ type: "destroy", idbName: database.name })
  } finally {
    transport.close()
  }
}
