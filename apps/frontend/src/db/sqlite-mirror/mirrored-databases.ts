import type { Database } from "@sqlite.org/sqlite-wasm"
import type sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { ThreaDatabase, type CachedEvent } from "../database"
import { SqliteMirror, type MirrorCoordination, type MirrorDeadlines, type SqliteMirrorMode } from "./client"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { isMirroredStore } from "./stores"
import { createBus, inProcessTransport } from "./test-harness"

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>

export const WS = "ws_1"
export const READS: ReadonlySet<string> = new Set(["get", "getMany", "query", "count"])

export interface MirroredOptions {
  mode?: SqliteMirrorMode
  /** This boot holds every other tab out, so read-write may make SQLite the primary copy. */
  entering?: boolean
  requestRestart?: () => void
  /** The user restarted for this entering boot, so it may hold the app behind the upgrade lock. */
  upgrade?: boolean
  /** Stands in for reloading every tab once an upgrade copied every store; a no-op by default. */
  restartEveryTab?: () => void
  bus?: ReturnType<typeof createBus>
  name?: string
  sqlite?: Database
  failReads?: (request: MirrorRequest) => boolean
  /** Awaited before each request reaches the worker. */
  beforeRequest?: (request: MirrorRequest) => Promise<void> | undefined
  /** Sees every request before the worker; answering stands in for the worker. */
  intercept?: (request: MirrorRequest, next: () => Promise<MirrorReply>) => Promise<MirrorReply>
  deadlines?: Partial<MirrorDeadlines>
  /** Constructs the database as the app does for a signed-in account, gated on cache ownership. */
  owner?: string
  /** Holds every request, the open included, until this settles. */
  workerStarted?: Promise<void>
  failOpen?: boolean
  /** Holds this tab's claim until this settles, as the Web Locks API answers asynchronously. */
  claimAnswered?: Promise<void>
}

export function event(id: string, streamId: string, sequence: number, extra: Partial<CachedEvent> = {}): CachedEvent {
  return {
    id,
    workspaceId: WS,
    streamId,
    sequence: String(sequence),
    _sequenceNum: sequence,
    eventType: sequence % 4 === 0 ? "reaction_added" : "message_created",
    payload: { messageId: `msg_${id}`, at: new Date(sequence * 1000) },
    actorId: null,
    actorType: null,
    createdAt: new Date(sequence * 1000).toISOString(),
    ...extra,
  } as CachedEvent
}

export function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

export function mirroredStores(database: ThreaDatabase): string[] {
  return database.tables.map((table) => table.name).filter(isMirroredStore)
}

function withDelayedClaim(coordination: MirrorCoordination, answered: Promise<void>): MirrorCoordination {
  return { ...coordination, claim: (onChange) => void answered.then(() => coordination.claim(onChange)) }
}

let counter = 0

/** Tabs of one browser, each a ThreaDatabase with a mirror on an in-process worker; `owned` collects their cleanup. */
export function mirroredDatabases(sqlite3: Sqlite3, owned: Array<() => void>) {
  function openMirrored(options: MirroredOptions = {}) {
    counter += 1
    const name = options.name ?? `mirrored_${counter}_${Date.now()}`
    const database = new ThreaDatabase(name, options.owner)
    owned.push(() => database.close())
    let sqlite = options.sqlite
    if (!sqlite) {
      const created: Database = new sqlite3.oo1.DB(":memory:")
      owned.push(() => created.close())
      sqlite = created
    }
    const log: MirrorRequest["type"][] = []
    const bus = options.bus ?? createBus()
    const transport = (): MirrorTransport => {
      const inner = inProcessTransport(sqlite, log)
      const send = async (request: MirrorRequest): Promise<MirrorReply> => {
        await options.workerStarted
        await options.beforeRequest?.(request)
        if (request.type === "open" && options.failOpen) throw new Error("The worker failed to start")
        if (READS.has(request.type) && options.failReads?.(request))
          return { ok: false, error: "SQLiteError", message: "disk I/O error" }
        return inner.request(request)
      }
      return {
        request: (request) => (options.intercept ? options.intercept(request, () => send(request)) : send(request)),
        heardAt: inner.heardAt,
        close: inner.close,
      }
    }
    const coordination = bus.coordination()
    const mirror = new SqliteMirror({
      database,
      mode: options.mode ?? "read-only",
      coordination: options.claimAnswered ? withDelayedClaim(coordination, options.claimAnswered) : coordination,
      createTransport: transport,
      deadlines: options.deadlines,
      entering: options.entering,
      requestRestart: options.requestRestart,
      upgrade: options.upgrade,
      restartEveryTab: options.restartEveryTab ?? (() => {}),
    })
    database.sqliteMirror = mirror
    database.sqliteBoot = mirror.beforeIdbOpen()
    mirror.start()
    const sqliteReads = () => log.filter((type) => READS.has(type)).length
    return { database, sqlite, mirror, bus, coordination, name, log, sqliteReads }
  }

  function plainDatabase(name: string): ThreaDatabase {
    const database = new ThreaDatabase(name)
    owned.push(() => database.close())
    return database
  }

  /** A first boot that copies every store into SQLite, then closes as a tab would. */
  async function copiedSession(options: MirroredOptions = {}, seed?: (database: ThreaDatabase) => Promise<unknown>) {
    const first = openMirrored(options)
    await first.database.open()
    await seed?.(first.database)
    await until(() => mirroredStores(first.database).every((store) => first.mirror.trusts(store)), "a full backfill")
    await new Promise((resolve) => setTimeout(resolve, 50))
    first.database.close()
    first.coordination.die()
    return { name: first.name, sqlite: first.sqlite }
  }

  return { openMirrored, plainDatabase, copiedSession }
}
