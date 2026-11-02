import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import {
  DEFAULT_DEADLINES,
  createBrowserMirror,
  mirrorEverRan,
  mirroredSchema,
  withProgressDeadline,
  type SqliteMirror,
  type SqliteMirrorMode,
} from "./client"
import { drainBacklog } from "./idb-backlog"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import {
  REQUESTED_PREFIX,
  browserModeLock,
  parseMode,
  readRecordedMode,
  readSqliteStorageMode,
  recordMode,
  reloadWhenAsked,
  takeSwitchReload,
  type ModeLock,
  type SqliteStorageMode,
} from "./storage-mode"
import { createWorkerTransport } from "./worker-transport"

const DELIVERED_PREFIX = "threa:sqliteStorageDelivered:"

/** How long a boot changing the mode right after a reload for it waits for the other tabs to close. */
const SWITCH_WAIT_MS = 5_000
const MODE_READ_ATTEMPTS = 3

function storeMode(key: string, mode: SqliteStorageMode): void {
  if (mode === "off") localStorage.removeItem(key)
  else localStorage.setItem(key, mode)
}

/**
 * Takes a workspace's delivered `sqliteStorage` value. Overrides are per
 * workspace while the database is per account, so only a change in this
 * workspace's own value since it last delivered one, "off" before that, moves
 * the database's requested mode. True when the requested mode changed.
 */
export function adoptDeliveredMode(idbName: string, workspaceId: string, mode: SqliteStorageMode): boolean {
  const delivered = `${DELIVERED_PREFIX}${idbName}:${workspaceId}`
  if (mode === parseMode(localStorage.getItem(delivered))) return false
  storeMode(delivered, mode)
  if (mode === readSqliteStorageMode(idbName)) return false
  storeMode(`${REQUESTED_PREFIX}${idbName}`, mode)
  return true
}

type CreateMirror = (database: ThreaDatabase, mode: SqliteMirrorMode, entering: boolean) => SqliteMirror

interface StorageBoot {
  lock: ModeLock
  createMirror: CreateMirror
  createTransport: () => MirrorTransport
  /** How long a boot changing the mode waits for the other tabs to close; by default, only right after a reload for it. */
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
  const requested = readSqliteStorageMode(name)
  const waitMs = boot.switchWaitMs ?? (takeSwitchReload() ? SWITCH_WAIT_MS : 0)
  const switching = requested !== (await recordedModeAtBoot(name))
  const release = switching ? await boot.lock.exclusive(waitMs) : null
  if (!release) await boot.lock.shared()
  let mode = await recordedModeAtBoot(name).catch((error: unknown) => {
    release?.()
    throw error
  })
  const entering = release !== null && requested === "read-write" && mode !== "read-write"
  if (release && !entering && mode !== requested) mode = await switchMode(database, mode, requested, boot)
  const running = entering ? "read-write" : mode
  if (running !== "off") startSqliteMirror(database, running, boot.createMirror, entering)
  const mirror = database.sqliteMirror
  if (release) {
    // Entering read-write holds the others out until the mirror decided, recording the mode before any of them boots.
    // A boot taking the exclusive side before this tab's shared one is granted re-reads that mode, so it switches
    // only on a flag change, which reloads this tab too; its worker cannot open the file this tab's worker holds.
    void (entering && mirror ? mirror.whenRoutable() : Promise.resolve()).then(() => {
      release()
      return boot.lock.shared()
    })
  }
  await mirror?.beforeIdbOpen()
}

/**
 * The recorded mode, retried. Unreadable, it is unknown: a database no mirror
 * ever ran for cannot have made SQLite its primary copy, so it runs off; any
 * other boot fails rather than open IndexedDB, possibly a stale backup.
 */
async function recordedModeAtBoot(name: string): Promise<SqliteStorageMode> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readRecordedMode(name)
    } catch (error) {
      if (attempt < MODE_READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
        continue
      }
      getPerfCapture().count("sqlite.mirrorFailure")
      if (mirrorEverRan(name)) {
        throw new Error(`Cannot tell whether SQLite holds the primary copy of ${name}`, { cause: error })
      }
      console.error(`SQLite storage mode of ${name} is unreadable; no mirror ever ran for it, so it runs off`, error)
      return "off"
    }
  }
}

/** The mode this boot runs: `to` once recorded, or `from` when its backlog could not land. */
async function switchMode(
  database: ThreaDatabase,
  from: SqliteStorageMode,
  to: SqliteStorageMode,
  boot: StorageBoot
): Promise<SqliteStorageMode> {
  const { name, verno } = database
  try {
    if (from === "read-write") {
      await onWorker(boot, async (ask) => {
        await ask({ type: "open", idbName: name, schema: mirroredSchema(database), idbVersion: verno })
        await drainBacklog(ask, name)
      })
    }
    await recordMode(name, to)
  } catch (error) {
    getPerfCapture().count("sqlite.drainFailure")
    console.error(`SQLite storage stays ${from}: switching to ${to} failed`, error)
    return from
  }
  // Once off is recorded the file holds nothing IndexedDB lacks, so a file left behind is only space.
  if (to === "off") {
    await onWorker(boot, (ask) => ask({ type: "destroy", idbName: name })).catch((error: unknown) => {
      getPerfCapture().count("sqlite.mirrorFailure")
      console.error("SQLite storage could not delete its file", error)
    })
  }
  return to
}

type Ask = (request: MirrorRequest) => Promise<Extract<MirrorReply, { ok: true }>>

/** Runs `work` on a worker of its own; the backlog lands strictly durable, under the schema it was written in. */
async function onWorker(boot: StorageBoot, work: (ask: Ask) => Promise<unknown>): Promise<void> {
  const transport = boot.createTransport()
  const ask: Ask = async (request) => {
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
    await work(ask)
  } finally {
    transport.close()
  }
}
