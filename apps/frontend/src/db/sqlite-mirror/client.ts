import type { ThreaDatabase } from "../database"
import type { IdbWrite, IdbWriteSink } from "../transaction-middleware"
import { getPerfCapture } from "@/lib/perf/capture"
import { readChunk, readTouched, touchedOf, type Touched, type TouchedRows } from "./idb-reads"
import { encodeKey, encodeRange } from "./key-codec"
import {
  deleteMarks,
  holds,
  mirrorChannelName,
  readMarks,
  writerBatch,
  type MirrorBatch,
  type MirrorBroadcast,
  type SqliteMark,
  type WriterCommit,
} from "./marks"
import type { MirrorEntry, MirrorMutation, MirrorStatus } from "./mirror-store"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { SQLITE_UNMIRRORED_STORES } from "./stores"
import { encodeValue } from "./value-codec"
import { createWorkerTransport } from "./worker-transport"

const BACKFILL_CHUNK_ROWS = 500
const MIN_RECORDED_APPLY_MS = 30
/** Past it the oldest is dropped: its marks still send the next owner to re-backfill what it wrote. */
const MAX_UNACKED_BATCHES = 1000

/** Decides which tab owns the SQLite file, and carries other tabs' batches to it. */
export interface MirrorCoordination {
  /** This tab, live for as long as the page is. */
  readonly tabId: string
  /** Tabs still alive, this one included; a tab missing from it can no longer write. */
  liveTabs(): Promise<ReadonlySet<string>>
  /** Reports ownership: `false` at once when another tab holds it, then `true` when it is handed to this tab. */
  claim(onChange: (owner: boolean) => void): void
  /** Gives up ownership, or the queued claim for it, so another tab can own the file; the channel stays open. */
  resign(): void
  close(): void
  broadcast(message: MirrorBroadcast): void
  onBroadcast(listener: (message: MirrorBroadcast) => void): () => void
}

/** `tabId` is the database handle's writer id, so the owner can tell which writers are alive. */
export function createBrowserCoordination(idbName: string, tabId: string): MirrorCoordination {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Web Locks API is unavailable")
  if (typeof BroadcastChannel === "undefined") throw new Error("BroadcastChannel is unavailable")
  const name = mirrorChannelName(idbName)
  const tabPrefix = `threa-sqlite-mirror-tab:${idbName}:`
  // Never released: the page may write IndexedDB unmirrored after the mirror stops, so it stays live until it unloads.
  void navigator.locks.request(`${tabPrefix}${tabId}`, () => new Promise<void>(() => {}))
  const channel = new BroadcastChannel(name)
  let releaseLock: (() => void) | null = null
  let resigned = false

  const hold = (onChange: (owner: boolean) => void) => () =>
    new Promise<void>((resolve) => {
      if (resigned) return resolve()
      releaseLock = resolve
      onChange(true)
    })

  const resign = () => {
    resigned = true
    releaseLock?.()
  }

  return {
    tabId,
    async liveTabs() {
      const { held = [], pending = [] } = await navigator.locks.query()
      const tabs = new Set<string>()
      // Pending too: a tab that just started may write before its lock is granted.
      for (const lock of [...held, ...pending]) {
        if (lock.name?.startsWith(tabPrefix)) tabs.add(lock.name.slice(tabPrefix.length))
      }
      return tabs
    },
    claim(onChange) {
      void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
        if (lock) return hold(onChange)()
        onChange(false)
        return navigator.locks.request(name, hold(onChange))
      })
    },
    resign,
    close() {
      resign()
      channel.close()
    },
    broadcast: (message) => channel.postMessage(message),
    onBroadcast(listener) {
      const handle = (event: MessageEvent<MirrorBroadcast>) => listener(event.data)
      channel.addEventListener("message", handle)
      return () => channel.removeEventListener("message", handle)
    },
  }
}

export interface SqliteMirrorOptions {
  database: ThreaDatabase
  coordination: MirrorCoordination
  createTransport: () => MirrorTransport
}

type Role = "idle" | "pending" | "follower" | "starting" | "owner" | "failed" | "stopped"

interface LocalCommit {
  batch: MirrorMutation[]
  touched: Touched[]
  commit: WriterCommit
  /** Every write of the commit is in `batch`; only then may SQLite count the commit as held. */
  whole: boolean
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function markFailure(error: unknown): void {
  getPerfCapture().count("sqlite.mirrorFailure")
  console.error("SQLite mirror failure", error)
}

function mirroredStores(database: ThreaDatabase): string[] {
  return database.tables.map((table) => table.name).filter((name) => !SQLITE_UNMIRRORED_STORES.has(name))
}

/** `null` when any value cannot be represented, after marking the failure. */
function encodeRows(store: string, keys: readonly IDBValidKey[], values: readonly unknown[]): MirrorEntry[] | null {
  try {
    return keys.map((key, index) => ({ key: encodeKey(key), value: encodeValue(values[index]) }))
  } catch (error) {
    markFailure(new Error(`Cannot represent a row of ${store}`, { cause: error }))
    return null
  }
}

/**
 * Copies committed IndexedDB writes of one database into SQLite. One tab per
 * database owns the worker; the others broadcast what their writes touched,
 * and the owner copies those rows from IndexedDB as they stand when it reads.
 * Which writes SQLite holds is decided against the marks IndexedDB commits
 * with every write, never against what this tab believes it sent.
 */
export class SqliteMirror implements IdbWriteSink {
  private role: Role = "idle"
  private transport: MirrorTransport | null = null
  private localPending: LocalCommit[] = []
  private remotePending: MirrorBatch[] = []
  private stopListening: (() => void) | null = null
  private starting: Promise<void> | null = null
  /** Batches this tab broadcast that no owner has acknowledged yet, by seq. */
  private readonly unacked = new Map<number, MirrorBatch>()
  private droppedUnacked = false

  constructor(private readonly options: SqliteMirrorOptions) {}

  private get tabId(): string {
    return this.options.coordination.tabId
  }

  start(): void {
    if (this.role !== "idle") return
    this.role = "pending"
    const { coordination } = this.options
    this.stopListening = coordination.onBroadcast((message) => this.receive(message))
    coordination.claim((owner) => {
      if (this.role !== "pending" && this.role !== "follower") return
      if (owner) this.starting = this.becomeOwner()
      else this.becomeFollower()
    })
  }

  commit(commit: WriterCommit, writes: IdbWrite[]): void {
    const batch: MirrorMutation[] = []
    const lossy = new Set<string>()
    for (const write of writes) {
      if (write.op === "put") {
        const entries: MirrorEntry[] = []
        write.keys.forEach((key, index) => {
          const value = write.values[index]
          if (value === null) lossy.add(write.store)
          else entries.push({ key: encodeKey(key), value })
        })
        batch.push({ store: write.store, op: "put", entries })
      } else if (write.op === "delete") {
        batch.push({ store: write.store, op: "delete", keys: write.keys.map(encodeKey) })
      } else {
        batch.push({ store: write.store, op: "deleteRange", range: encodeRange(write.range) })
      }
    }
    if (lossy.size > 0) this.lose([...lossy], new Error("Unmirrorable value"))
    this.routeLocal({ batch, touched: writes.map(touchedOf), commit, whole: lossy.size === 0 })
  }

  /** Stops mirroring; the owner deletes the SQLite file, which only the owner can reach. */
  async stop(): Promise<void> {
    const ownsFile = this.role === "owner" || this.role === "starting"
    this.role = "stopped"
    this.stopListening?.()
    this.localPending = []
    this.remotePending = []
    await this.starting
    let transport = this.transport
    this.transport = null
    if (ownsFile) {
      transport ??= this.options.createTransport()
      const reply = await transport
        .request({ type: "destroy", idbName: this.options.database.name })
        .catch((error: unknown) => ({ ok: false as const, error: "TransportError", message: String(error) }))
      if (!reply.ok) markFailure(`${reply.error}: ${reply.message}`)
    }
    transport?.close()
    this.options.coordination.close()
  }

  private isStopped(): boolean {
    return this.role === "stopped"
  }

  private becomeFollower(): void {
    this.role = "follower"
    for (const local of this.localPending) this.broadcastLocal(local)
    this.localPending = []
    this.remotePending = []
  }

  private routeLocal(local: LocalCommit): void {
    switch (this.role) {
      case "owner":
        return this.applyOwn(local)
      case "pending":
      case "starting":
        this.localPending.push(local)
        return
      case "follower":
      case "failed":
        return this.broadcastLocal(local)
      case "idle":
      case "stopped":
        this.options.database.sqliteWriter.announce(writerBatch(local.commit, local.touched))
    }
  }

  private applyOwn(local: LocalCommit): void {
    void this.send({ type: "apply", batch: local.batch, commit: local.whole ? local.commit : undefined }).then(
      (reply) => {
        if (!reply)
          this.lose(
            local.batch.map((mutation) => mutation.store),
            new Error("SQLite mirror apply failed")
          )
      }
    )
  }

  private broadcastLocal(local: LocalCommit): void {
    const batch = writerBatch(local.commit, local.touched)
    this.unacked.set(batch.id, batch)
    if (this.unacked.size > MAX_UNACKED_BATCHES) {
      this.unacked.delete(this.unacked.keys().next().value!)
      if (!this.droppedUnacked) markFailure(new Error("No SQLite mirror owner acknowledged this tab's writes"))
      this.droppedUnacked = true
    }
    this.options.coordination.broadcast(batch)
  }

  private receive(message: MirrorBroadcast): void {
    if (message.type === "ack") {
      if (message.to === this.tabId) this.unacked.delete(message.id)
    } else if (message.type === "owner") {
      if (this.role === "follower" || this.role === "failed") {
        for (const batch of this.unacked.values()) this.options.coordination.broadcast(batch)
      }
    } else if (this.role === "owner") {
      this.applyRemote(message)
    } else if (this.role === "pending" || this.role === "starting") {
      this.remotePending.push(message)
    }
  }

  /**
   * Another writer's batch can arrive before or after this tab's own commit to
   * the same keys, so its values are never applied: the touched rows are re-read
   * from IndexedDB and their current state is what SQLite receives.
   */
  private applyRemote(message: MirrorBatch): void {
    const stores = message.touched.map((touched) => touched.store)
    readTouched(this.options.database.backendDB(), message.touched, (rows) => {
      const { batch, whole } = this.mutationsFor(rows)
      const commit = whole ? { writer: message.from, seq: message.id, prev: message.prev } : undefined
      void this.send({ type: "apply", batch, commit }).then((reply) => {
        if (!reply) return this.lose(stores, new Error("SQLite mirror apply failed"))
        if (message.from === this.tabId) this.unacked.delete(message.id)
        else this.options.coordination.broadcast({ type: "ack", to: message.from, id: message.id })
      })
    }).catch((error: unknown) => this.lose(stores, error))
  }

  private mutationsFor(rows: readonly TouchedRows[]): { batch: MirrorMutation[]; whole: boolean } {
    const batch: MirrorMutation[] = []
    let whole = true
    for (const row of rows) {
      const present = row.found.keys.flatMap((key, index) =>
        row.found.values[index] === undefined ? [] : [{ key, value: row.found.values[index] }]
      )
      const entries = encodeRows(
        row.store,
        present.map((p) => p.key),
        present.map((p) => p.value)
      )
      if (!entries) {
        whole = false
        this.lose([row.store], new Error("Unmirrorable value"))
        continue
      }
      if ("range" in row) {
        batch.push({ store: row.store, op: "deleteRange", range: encodeRange(row.range) })
      } else {
        const missing = row.found.keys.filter((_, index) => row.found.values[index] === undefined)
        if (missing.length > 0) batch.push({ store: row.store, op: "delete", keys: missing.map(encodeKey) })
      }
      if (entries.length > 0) batch.push({ store: row.store, op: "put", entries })
    }
    return { batch, whole }
  }

  /** SQLite missed writes to these stores; their marks stay ahead of it, so the next owner re-backfills them. */
  private lose(stores: readonly string[], error: unknown): void {
    markFailure(new Error(`Lost writes to ${[...new Set(stores)].join(", ")}`, { cause: error }))
  }

  private async send(request: MirrorRequest): Promise<Extract<MirrorReply, { ok: true }> | null> {
    const transport = this.transport
    if (!transport) return null
    let reply: MirrorReply
    try {
      reply = await transport.request(request)
    } catch (error) {
      if (this.transport === transport) this.fail(error)
      return null
    }
    if (!reply.ok) {
      markFailure(`${reply.error}: ${reply.message}`)
      return null
    }
    if (request.type === "apply" && reply.ms >= MIN_RECORDED_APPLY_MS)
      getPerfCapture().mark("sqlite.mirrorApply", reply.ms)
    return reply
  }

  /**
   * The worker died or never started: hand ownership to another tab and keep
   * broadcasting this tab's writes to it.
   */
  private fail(error: unknown): void {
    if (this.role === "stopped" || this.role === "failed") return
    markFailure(error)
    this.role = "failed"
    const transport = this.transport
    this.transport = null
    transport?.close()
    this.options.coordination.resign()
    for (const local of this.localPending) this.broadcastLocal(local)
    this.localPending = []
    this.remotePending = []
  }

  private async becomeOwner(): Promise<void> {
    const { database, createTransport } = this.options
    this.role = "starting"
    const capture = getPerfCapture()
    const openedAt = performance.now()
    try {
      await database.open()
      if (this.isStopped()) return
      const stores = mirroredStores(database)
      this.transport = createTransport()
      const opened = await this.send({ type: "open", idbName: database.name, stores, idbVersion: database.verno })
      if (this.isStopped()) return
      if (!opened) throw new Error("SQLite mirror could not open its database")
      capture.mark("sqlite.open", performance.now() - openedAt)
      this.role = "owner"
      this.options.coordination.broadcast({ type: "owner" })
      for (const batch of this.unacked.values()) this.remotePending.push(batch)
      for (const local of this.localPending) this.applyOwn(local)
      for (const remote of this.remotePending) this.applyRemote(remote)
      this.localPending = []
      this.remotePending = []
      const reconciled = await this.reconcile(stores)
      if (!reconciled || this.role !== "owner") return
      // Taken before the backfill reads: a writer dead by now committed everything it ever will.
      const live = await this.options.coordination.liveTabs()
      if (this.role !== "owner") return
      const backfilled = await this.backfill(
        stores.filter((store) => !reconciled.trusted.has(store)),
        reconciled.marks
      )
      if (backfilled) await this.forget(reconciled, backfilled, live)
    } catch (error) {
      if (!this.isStopped()) this.fail(error)
    }
  }

  /**
   * What SQLite holds in full: backfilled stores of this IndexedDB incarnation
   * with no mark past what SQLite holds of its writer. Anything else may lack
   * writes from a writer that died, never ran a mirror, or ran one no owner heard.
   */
  private async reconcile(
    stores: string[]
  ): Promise<{ status: MirrorStatus; marks: SqliteMark[]; trusted: Set<string> } | null> {
    const { incarnation, marks } = await readMarks(this.options.database.backendDB())
    if (this.role !== "owner") return null
    const reply = await this.send({ type: "status" })
    if (this.role !== "owner") return null
    if (!reply?.status) throw new Error("SQLite mirror could not report its status")
    let status = reply.status
    if (status.incarnation !== incarnation) {
      if (!(await this.send({ type: "reset", incarnation }))) throw new Error("SQLite mirror could not reset")
      if (this.role !== "owner") return null
      status = { backfilled: [], writers: {}, incarnation }
    }
    const behind = new Set(marks.filter((mark) => !holds(status.writers, mark)).map((mark) => mark.store))
    const trusted = new Set(status.backfilled.filter((store) => stores.includes(store) && !behind.has(store)))
    return { status, marks, trusted }
  }

  /**
   * Drops marks SQLite now covers, read before the backfill so a backfilled
   * store holds their writes, and the records of writers with no mark left
   * that are no longer alive.
   */
  private async forget(
    { status, marks }: { status: MirrorStatus; marks: SqliteMark[] },
    backfilled: ReadonlySet<string>,
    live: ReadonlySet<string>
  ): Promise<void> {
    const stores = new Set(mirroredStores(this.options.database))
    const covered = marks.filter(
      (mark) => !stores.has(mark.store) || backfilled.has(mark.store) || holds(status.writers, mark)
    )
    await deleteMarks(this.options.database.backendDB(), covered)
    const marked = new Set(marks.filter((mark) => !covered.includes(mark)).map((mark) => mark.writer))
    const writers = Object.keys(status.writers).filter((writer) => !marked.has(writer) && !live.has(writer))
    if (writers.length > 0 && this.role === "owner") await this.send({ type: "forgetWriters", writers })
  }

  /** The stores backfilled, or `null` when interrupted: a store left unbegun may still carry a stale backfilled flag. */
  private async backfill(stores: string[], marks: readonly SqliteMark[]): Promise<Set<string> | null> {
    const capture = getPerfCapture()
    const startedAt = performance.now()
    const done = new Set<string>()
    for (const store of stores) {
      const storeStartedAt = performance.now()
      const covered = Object.fromEntries(marks.filter((mark) => mark.store === store).map((m) => [m.writer, m.seq]))
      const outcome = await this.backfillStore(store, covered)
      if (outcome === "interrupted") return null
      if (outcome === "done") {
        done.add(store)
        capture.mark("sqlite.backfillStore", performance.now() - storeStartedAt)
      }
    }
    capture.mark("sqlite.backfillDone", performance.now() - startedAt)
    return done
  }

  /** `covered`: the store's marks read before the backfill began, so it holds their writes. */
  private async backfillStore(
    store: string,
    covered: Record<string, number>
  ): Promise<"done" | "unmirrorable" | "interrupted"> {
    const idb = this.options.database.backendDB()
    if (!(await this.send({ type: "backfillBegin", store }))) return "interrupted"
    let last: IDBValidKey | undefined
    for (;;) {
      const rows = await readChunk(idb, store, last, BACKFILL_CHUNK_ROWS)
      if (this.role !== "owner") return "interrupted"
      if (rows.keys.length === 0) break
      const entries = encodeRows(store, rows.keys, rows.values)
      if (!entries) return "unmirrorable"
      if (!(await this.send({ type: "backfillChunk", store, entries }))) return "interrupted"
      last = rows.keys[rows.keys.length - 1]
      await yieldToEventLoop()
      if (this.role !== "owner") return "interrupted"
    }
    return (await this.send({ type: "backfillFinish", store, covered })) ? "done" : "interrupted"
  }
}

export function createBrowserMirror(database: ThreaDatabase): SqliteMirror {
  return new SqliteMirror({
    database,
    coordination: createBrowserCoordination(database.name, database.sqliteWriter.id),
    createTransport: createWorkerTransport,
  })
}
