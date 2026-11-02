import { RangeSet } from "dexie"
import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { touchesDeviceOnlyData } from "../transaction-middleware"
import { openInstalledIdb, replayBacklog } from "./idb-backlog"
import { createBrowserGuard, type IdbGuard } from "./idb-guard"
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
import type { IdbWrite } from "./middleware"
import type { MirrorEntry, MirrorMutation, MirrorStatus, MirrorStoreSchema, MirrorWrite } from "./mirror-store"
import type { MirrorReadRequest, MirrorReadResults, MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { txOf } from "./protocol"
import { isMirroredStore } from "./stores"
import { encodeValue } from "./value-codec"
import { createWorkerTransport } from "./worker-transport"

const BACKFILL_CHUNK_ROWS = 500
const BACKLOG_CHUNK_BATCHES = 100
const MIN_RECORDED_APPLY_MS = 30
/** Past it the oldest is dropped: its marks still send the next owner to re-backfill what it wrote. */
const MAX_UNACKED_BATCHES = 1000
const TRUSTED_PREFIX = "threa:sqliteTrusted:"

/**
 * How long anything waits on the worker. A worker chunk that never loads or a
 * worker killed without an error event answers nothing, and boot reads wait on
 * it from inside Dexie's open. Request deadlines count only time in which the
 * worker reported no progress, so a read queued behind long work is not cut off.
 */
export interface MirrorDeadlines {
  /** A read waiting for the claim to resolve; past it the mirror stops serving reads this session. */
  claimMs: number
  /** A read the worker is silent on, or a snapshot waiting on another writer's batch; past it SQLite stops serving the stores. */
  readMs: number
  /** Any other request the worker is silent on; past it the worker is presumed dead and this tab hands ownership on. */
  workerMs: number
}

const DEFAULT_DEADLINES: MirrorDeadlines = { claimMs: 5_000, readMs: 5_000, workerMs: 30_000 }

class DeadlineError extends Error {
  override readonly name = "DeadlineError"
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(`${what} took over ${ms} ms`)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Rejects once the worker has reported nothing for `ms` since the request was sent. */
function withProgressDeadline<T>(
  transport: MirrorTransport,
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  const sentAt = performance.now()
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      const silent = performance.now() - Math.max(sentAt, transport.heardAt())
      if (silent >= ms) reject(new DeadlineError(`${what}: the worker reported nothing for ${ms} ms`))
      else timer = setTimeout(check, ms - silent)
    }
    timer = setTimeout(check, ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * Under read-write storage: a tab asks for the owner's decision, the owner
 * announces whether it serves read-write, and followers send it their worker
 * requests to run on their behalf.
 */
export type ReadWriteMessage =
  | { type: "hello"; from: string }
  | { type: "decided"; tab: string; serving: boolean }
  | { type: "call"; from: string; to: string; id: number; request: MirrorRequest }
  | { type: "reply"; to: string; id: number; reply: MirrorReply }

export type CoordinationMessage = MirrorBroadcast | ReadWriteMessage

/** Decides which tab owns the SQLite file, and carries other tabs' batches to it. */
export interface MirrorCoordination {
  /** This tab, live for as long as the page is. */
  readonly tabId: string
  /** Tabs still alive, this one included; a tab missing from it can no longer write. */
  liveTabs(): Promise<ReadonlySet<string>>
  /** Calls `onGone` once that tab is gone; the returned function stops watching. */
  watchTab(tabId: string, onGone: () => void): () => void
  /** Reports ownership: `false` at once when another tab holds it, then `true` when it is handed to this tab. */
  claim(onChange: (owner: boolean) => void): void
  /** Gives up ownership, or the queued claim for it, so another tab can own the file; the channel stays open. */
  resign(): void
  close(): void
  broadcast(message: CoordinationMessage): void
  onBroadcast(listener: (message: CoordinationMessage) => void): () => void
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
    watchTab(tab, onGone) {
      const watching = new AbortController()
      // Granted only once that tab's page is gone, its lock being held for the page's life.
      navigator.locks.request(`${tabPrefix}${tab}`, { signal: watching.signal }, () => onGone()).catch(() => {})
      return () => watching.abort()
    },
    resign,
    close() {
      resign()
      channel.close()
    },
    broadcast: (message) => channel.postMessage(message),
    onBroadcast(listener) {
      const handle = (event: MessageEvent<CoordinationMessage>) => listener(event.data)
      channel.addEventListener("message", handle)
      return () => channel.removeEventListener("message", handle)
    },
  }
}

/**
 * `shadow` only compares reads; `read-only` serves readonly transactions from
 * SQLite where it can; `read-write` serves every request on mirrored stores
 * from SQLite, replaying committed writes into IndexedDB as a backup.
 */
export type SqliteMirrorMode = "shadow" | "read-only" | "read-write"

export interface SqliteMirrorOptions {
  database: ThreaDatabase
  mode: SqliteMirrorMode
  coordination: MirrorCoordination
  guard: IdbGuard
  createTransport: () => MirrorTransport
  deadlines?: Partial<MirrorDeadlines>
}

type Role = "idle" | "pending" | "follower" | "starting" | "owner" | "failed" | "stopped"

type OkReply = Extract<MirrorReply, { ok: true }>

interface LocalCommit {
  batch: MirrorMutation[]
  touched: Touched[]
  commit: WriterCommit
  /** Every write of the commit is in `batch`; only then may SQLite count the commit as held. */
  whole: boolean
}

interface HeldApply {
  stores: readonly string[]
  send: () => void
}

/** A request not yet sent to the worker. */
interface Outgoing {
  read: boolean
  /** Stores whose rows it changes; `null` for every store. */
  writes: readonly string[] | null
  run(): Promise<unknown>
  cancel(): void
}

function unavailable(): DOMException {
  return new DOMException("SQLite storage is unavailable in this tab; reload to recover", "UnknownError")
}

function ownerLost(): DOMException {
  return new DOMException("The tab running SQLite storage closed during this transaction", "AbortError")
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Why read-write cannot serve a store: writes key rows by their inbound key path and know no unique indexes. */
function readWriteBlocker(database: ThreaDatabase): string | null {
  for (const table of database.tables) {
    if (!isMirroredStore(table.name)) continue
    const { primKey, indexes } = table.schema
    if (primKey.auto || !primKey.keyPath) return `${table.name} has no inbound primary key`
    if (indexes.some((index) => index.unique)) return `${table.name} has a unique index`
  }
  return null
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function markFailure(error: unknown): void {
  getPerfCapture().count("sqlite.mirrorFailure")
  console.error("SQLite mirror failure", error)
}

function mirroredSchema(database: ThreaDatabase): MirrorStoreSchema[] {
  return database.tables
    .filter((table) => isMirroredStore(table.name))
    .map((table) => ({
      name: table.name,
      indexes: table.schema.indexes.map((index) => ({
        name: index.name,
        keyPath: index.keyPath as string | string[],
        multiEntry: index.multi === true,
      })),
    }))
}

function writesOf(request: MirrorRequest): readonly string[] | null {
  switch (request.type) {
    case "apply":
      return request.batch.map((mutation) => mutation.store)
    case "backfillBegin":
    case "backfillChunk":
    case "backfillFinish":
      return [request.store]
    case "status":
    case "forgetWriters":
      return []
    default:
      return null
  }
}

/** The stores the last owner served under `version`: which reads wait for this boot's claim instead of going to IndexedDB. */
function readTrustedHint(idbName: string, version: number): string[] {
  let record: { version?: unknown; stores?: unknown }
  try {
    record = JSON.parse(localStorage.getItem(`${TRUSTED_PREFIX}${idbName}`) ?? "{}")
  } catch {
    return []
  }
  if (record.version !== version || !Array.isArray(record.stores)) return []
  return record.stores.filter((store): store is string => typeof store === "string")
}

/**
 * Dexie told this tab's live queries about another writer's write when it
 * committed, before SQLite held it; tell them again now that it does. Dexie's
 * same-tab event also drops their cached results.
 */
function signalStorageMutated(database: ThreaDatabase, stores: readonly string[]): void {
  const parts: Record<string, RangeSet> = {}
  for (const store of new Set(stores)) {
    const prefix = `idb://${database.name}/${store}/`
    const names = ["", ":dels", ...database.table(store).schema.indexes.map((index) => index.name)]
    for (const name of names) parts[`${prefix}${name}`] = new RangeSet(-Infinity, [[[]]])
  }
  dispatchEvent(new CustomEvent("x-storagemutated-1", { detail: parts }))
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
 *
 * Under read-write storage SQLite is the primary copy instead: its
 * transactions write no marks, and each commit lands in a backlog the owner
 * replays into IndexedDB, bypassing marks, as SQLite already holds those rows.
 * A durable marker and an exclusive lock keep tabs that write IndexedDB
 * themselves out until the backlog has drained.
 */
export class SqliteMirror {
  readonly mode: SqliteMirrorMode
  private role: Role = "idle"
  private transport: MirrorTransport | null = null
  private localPending: LocalCommit[] = []
  private remotePending: MirrorBatch[] = []
  private stopListening: (() => void) | null = null
  private starting: Promise<void> | null = null
  /** Batches this tab broadcast that no owner has acknowledged yet, by seq. */
  private readonly unacked = new Map<number, MirrorBatch>()
  private droppedUnacked = false
  private markedUnowned = false
  private reportedFallback = false
  /** IndexedDB is open, so other writers' batches can be read back from it. */
  private idbOpen = false
  /**
   * Stores SQLite holds in full, as the marks decide once this tab owns the
   * worker. Until then, the set the last owner persisted: reads of those wait
   * for the claim, and IndexedDB serves any the claim does not trust.
   */
  private readonly trusted: Set<string>
  private readonly distrusted = new Set<string>()
  private readonly deadlines: MirrorDeadlines
  /** Set once this tab's first claim leads to an open worker with reconciled trust, or to none. */
  private claimSettled = false
  private settleClaim: () => void = () => {}
  private readonly claimResolved = new Promise<void>((resolve) => (this.settleClaim = resolve))
  private claimDeadline: Promise<void> | null = null
  /** Committed or received writes per store, so a shadow comparison a write raced is dropped, not reported. */
  private readonly changesByStore = new Map<string, number>()
  /** Stores of each emulated readonly transaction reading SQLite now; applies to them wait, as IndexedDB's writes would. */
  private readonly snapshots = new Set<{ stores: readonly string[] }>()
  /** Applies in commit order, from the first one a snapshot held. */
  private heldApplies: HeldApply[] = []
  private awaitingSnapshot: Array<() => void> = []
  /** Per store, other writers' batches received but not yet handed to `apply`: committed in IndexedDB, not in SQLite. */
  private readonly remoteUnapplied = new Map<string, number>()
  private awaitingRemote: Array<() => void> = []
  /** Requests not yet sent; one non-read at a time is in flight, so a read jumps every one that does not write its store. */
  private outbox: Outgoing[] = []
  private sending = false
  /**
   * SQLite serves every request on mirrored stores and IndexedDB only receives
   * its backlog. Also set when SQLite may hold writes IndexedDB lacks but this
   * tab lost its worker: requests then fail rather than read a stale backup.
   */
  private serving = false
  /** This tab holds the shared lock, so it may write IndexedDB itself and no tab serves read-write meanwhile. */
  private nativeHeld = false
  private readonly writingIdb = deferred()
  /** No tab may open IndexedDB before a backlog has drained, nor without the lock to write it. */
  private readonly idbGate = deferred()
  private booted: Promise<void> = Promise.resolve()
  private nextTx = 0
  private drainRequested = false
  private draining: Promise<void> | null = null
  /** Settles once requests have somewhere to go: SQLite, here or through the owner, or IndexedDB. */
  private routable = deferred()
  /** The owner this follower sends its requests to, watched so its end fails what it had in flight. */
  private owner: { tab: string; unwatch: () => void } | null = null
  private nextCall = 0
  /** This owner decided whether it serves read-write, so it can answer followers. */
  private decided = false
  private readonly calls = new Map<
    number,
    { owner: string; resolve: (reply: OkReply) => void; reject: (error: unknown) => void }
  >()
  /** The owner each of this follower's transactions began on. */
  private readonly txOwners = new Map<number, string>()
  /** Followers' transactions this owner runs, by tab, as transactions of its own. */
  private readonly served = new Map<string, Map<number, number>>()

  constructor(private readonly options: SqliteMirrorOptions) {
    this.mode = options.mode
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines }
    this.trusted = new Set(readTrustedHint(options.database.name, options.database.verno))
  }

  private get tabId(): string {
    return this.options.coordination.tabId
  }

  get readWrite(): boolean {
    return this.serving
  }

  /** This tab writes IndexedDB itself, holding the lock that keeps any tab from serving read-write. */
  get writesIdb(): boolean {
    return this.nativeHeld && !this.serving
  }

  /** Settles once this tab writes IndexedDB itself: at boot, or when the owner it followed stops serving read-write. */
  whenWritingIdb(): Promise<void> {
    return this.writingIdb.promise
  }

  /** What IndexedDB's open must wait for. */
  beforeIdbOpen(): Promise<void> {
    return this.idbGate.promise
  }

  /** What Dexie's ready handlers wait for: whether this tab's transactions go to SQLite or IndexedDB. */
  whenRoutable(): Promise<void> {
    return this.routable.promise
  }

  /** Queues a transaction in creation order, as IndexedDB orders them; one that fails to begin fails its requests and commit. */
  beginTransaction(stores: readonly string[], mode: "readonly" | "readwrite"): number {
    const tx = ++this.nextTx
    const readonly = mode === "readonly"
    this.ask({ type: "begin", tx, readonly, strict: !readonly && touchesDeviceOnlyData(stores) }).catch(() => {})
    return tx
  }

  async write(tx: number, write: MirrorWrite): Promise<number[]> {
    return (await this.ask({ type: "write", tx, write })).failures ?? []
  }

  async commitTransaction(tx: number, wrote: boolean): Promise<void> {
    await this.ask({ type: "commit", tx })
    if (wrote) this.scheduleDrain()
  }

  /** Never rejects: a rollback that fails leaves nothing to undo, the worker being gone or the transaction ended. */
  rollbackTransaction(tx: number): Promise<void> {
    return this.ask({ type: "rollback", tx }).then(() => undefined, markFailure)
  }

  start(): void {
    if (this.role !== "idle") return
    this.role = "pending"
    const { coordination } = this.options
    this.stopListening = coordination.onBroadcast((message) => this.receive(message))
    this.booted = this.boot()
    coordination.claim((owner) => {
      if (this.role !== "pending" && this.role !== "follower") return
      if (owner) this.starting = this.becomeOwner()
      else this.becomeFollower()
    })
  }

  /**
   * A tab outside read-write writes IndexedDB itself once it holds the shared
   * lock. Without a backlog to land first, it opens IndexedDB at once;
   * otherwise it waits for an owner, which drains the backlog or serves read-write.
   */
  private async boot(): Promise<void> {
    if (this.mode === "read-write") return
    if ((await this.holdNative(false)) && !(await this.primaryMarked())) this.settleServing(false)
  }

  private async holdNative(wait: boolean): Promise<boolean> {
    this.nativeHeld ||= await this.options.guard.holdNative(wait)
    return this.nativeHeld
  }

  /** Unreadable reads as marked: IndexedDB then waits for an owner to drain, rather than risk opening without its writes. */
  private primaryMarked(): Promise<boolean> {
    return this.options.guard.primaryMarked().catch((error: unknown) => {
      markFailure(error)
      return true
    })
  }

  /** Requests now have somewhere to go: SQLite when serving, else IndexedDB, under the lock to write it. */
  private settleServing(serving: boolean): void {
    this.serving = serving
    this.routable.resolve()
    this.idbGate.resolve()
    if (this.writesIdb) this.writingIdb.resolve()
  }

  commit(commit: WriterCommit, writes: IdbWrite[]): void {
    this.changed(writes.map((write) => write.store))
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

  /** Before the claim resolves a store is trusted on the persisted set, and its reads wait for the worker. */
  trusts(store: string): boolean {
    const role = this.role
    return (role === "owner" || role === "pending" || role === "starting") && this.trusted.has(store)
  }

  /**
   * Whether SQLite may serve a readonly transaction over these stores. Other
   * tabs cannot reach this tab's worker, so they keep reading IndexedDB.
   */
  servesReads(stores: readonly string[]): boolean {
    if (this.mode !== "read-only") return false
    if ((this.role === "follower" || this.role === "failed") && !this.markedUnowned) {
      this.markedUnowned = true
      getPerfCapture().count("sqlite.readFallback")
    }
    return stores.every((store) => this.trusts(store))
  }

  changes(store: string): number {
    return this.changesByStore.get(store) ?? 0
  }

  /**
   * Starts a consistent read of `stores`: resolves once every apply to them
   * committed or received before now has been sent, and holds later applies to them
   * until `until` settles, so no commit lands between the reads of one
   * transaction. Another writer's batch not applied within `readMs` takes its
   * stores off SQLite, so the reads fall back to IndexedDB.
   */
  async snapshot(stores: readonly string[], until: Promise<unknown>): Promise<void> {
    await this.awaitClaim()
    await this.awaitRemote(stores)
    while (this.heldApplies.some((held) => held.stores.some((store) => stores.includes(store)))) {
      await new Promise<void>((resolve) => this.awaitingSnapshot.push(resolve))
    }
    const snapshot = { stores }
    this.snapshots.add(snapshot)
    void until.finally(() => {
      this.snapshots.delete(snapshot)
      this.releaseApplies()
    })
  }

  /**
   * Waits until this tab owns an open worker. Rejects when it never will, when
   * SQLite fails the read, or when the store lost trust meanwhile; a failed
   * read leaves its store on IndexedDB this session.
   */
  async read<T extends MirrorReadRequest>(request: T): Promise<MirrorReadResults[T["type"]]> {
    if (this.serving) return (await this.ask(request)).result as MirrorReadResults[T["type"]]
    await this.awaitClaim()
    const transport = this.transport
    if (this.role !== "owner" || !transport || !this.trusts(request.store))
      throw new Error(`SQLite mirror cannot serve ${request.store}`)
    let reply: MirrorReply
    try {
      reply = await this.enqueueRead(transport, request)
    } catch (error) {
      if (error instanceof DeadlineError) this.stopServingReads(error)
      else if (this.transport === transport) this.fail(error)
      throw error
    }
    if (!reply.ok) {
      this.distrust([request.store])
      throw new Error(`SQLite mirror read failed: ${reply.error}: ${reply.message}`)
    }
    if (!this.trusts(request.store)) throw new Error(`SQLite mirror no longer trusts ${request.store}`)
    return reply.result as MirrorReadResults[T["type"]]
  }

  /** A read SQLite was meant to serve, but IndexedDB answered; the store stays on IndexedDB this session. */
  fellBack(store: string, error: unknown): void {
    if (this.trusts(store)) this.distrust([store])
    getPerfCapture().count("sqlite.readFallback")
    if (this.reportedFallback) return
    this.reportedFallback = true
    console.error(`SQLite mirror could not serve a read of ${store}; IndexedDB answered`, error)
  }

  private async awaitClaim(): Promise<void> {
    if (this.claimSettled) return
    const { claimMs } = this.deadlines
    this.claimDeadline ??= new Promise<void>((resolve) => setTimeout(resolve, claimMs)).then(() => {
      if (this.claimSettled) return
      this.stopServingReads(new DeadlineError(`SQLite mirror did not open within ${claimMs} ms`))
      this.settle()
    })
    await this.claimResolved
  }

  private remoteBlocks(stores: readonly string[]): boolean {
    return stores.some((store) => (this.remoteUnapplied.get(store) ?? 0) > 0)
  }

  private async awaitRemote(stores: readonly string[]): Promise<void> {
    if (!this.remoteBlocks(stores)) return
    const { readMs } = this.deadlines
    let timer: ReturnType<typeof setTimeout> | undefined
    const applied = await Promise.race([
      new Promise<boolean>((resolve) => {
        const check = () => {
          if (this.remoteBlocks(stores)) this.awaitingRemote.push(check)
          else resolve(true)
        }
        check()
      }),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), readMs))),
    ])
    clearTimeout(timer)
    if (applied) return
    markFailure(new DeadlineError(`Another writer's batch to ${stores.join(", ")} was not applied within ${readMs} ms`))
    this.distrust(stores)
  }

  private countRemote(stores: readonly string[], delta: 1 | -1): void {
    for (const store of new Set(stores)) {
      const count = (this.remoteUnapplied.get(store) ?? 0) + delta
      if (count > 0) this.remoteUnapplied.set(store, count)
      else this.remoteUnapplied.delete(store)
    }
    if (delta < 0) this.recheckRemote()
  }

  private clearRemote(): void {
    this.remotePending = []
    this.remoteUnapplied.clear()
    this.recheckRemote()
  }

  private recheckRemote(): void {
    const waiting = this.awaitingRemote
    this.awaitingRemote = []
    for (const check of waiting) check()
  }

  /** Reads go back to IndexedDB for the session; writes keep reaching SQLite if its worker recovers. */
  private stopServingReads(error: unknown): void {
    markFailure(error)
    this.distrust(mirroredSchema(this.options.database).map((store) => store.name))
  }

  private changed(stores: readonly string[]): void {
    for (const store of stores) this.changesByStore.set(store, this.changes(store) + 1)
  }

  /** Sent at once unless a snapshot reads one of its stores or an earlier apply is held; commit order is kept. */
  private apply(batch: MirrorMutation[], commit: WriterCommit | undefined): Promise<OkReply | null> {
    const stores = batch.map((mutation) => mutation.store)
    return new Promise((resolve) => {
      const send = () => resolve(this.send({ type: "apply", batch, commit }))
      if (this.heldApplies.length > 0 || this.snapshotReads(stores)) this.heldApplies.push({ stores, send })
      else send()
    })
  }

  private snapshotReads(stores: readonly string[]): boolean {
    for (const snapshot of this.snapshots) if (stores.some((store) => snapshot.stores.includes(store))) return true
    return false
  }

  private releaseApplies(): void {
    while (this.heldApplies.length > 0 && !this.snapshotReads(this.heldApplies[0].stores)) {
      this.heldApplies.shift()?.send()
    }
    const waiting = this.awaitingSnapshot
    this.awaitingSnapshot = []
    for (const resume of waiting) resume()
  }

  /** Stops mirroring; the owner deletes the SQLite file, which only the owner can reach. */
  async stop(): Promise<void> {
    const ownsFile = this.role === "owner" || this.role === "starting"
    this.role = "stopped"
    this.settle()
    this.loseOwner()
    this.idbGate.resolve()
    this.routable.resolve()
    localStorage.removeItem(`${TRUSTED_PREFIX}${this.options.database.name}`)
    this.stopListening?.()
    this.localPending = []
    this.clearRemote()
    this.dropOutbox()
    await this.starting
    let transport = this.transport
    this.transport = null
    if (ownsFile) {
      transport ??= this.options.createTransport()
      const reply = await withDeadline(
        transport.request({ type: "destroy", idbName: this.options.database.name }),
        this.deadlines.workerMs,
        "SQLite mirror destroy"
      ).catch((error: unknown) => ({ ok: false as const, error: "TransportError", message: String(error) }))
      if (!reply.ok) markFailure(`${reply.error}: ${reply.message}`)
    }
    transport?.close()
    this.options.coordination.close()
  }

  private isStopped(): boolean {
    return this.role === "stopped"
  }

  private settle(): void {
    this.claimSettled = true
    this.settleClaim()
  }

  private becomeFollower(): void {
    this.role = "follower"
    this.trusted.clear()
    this.settle()
    this.options.coordination.broadcast({ type: "hello", from: this.tabId })
    for (const local of this.localPending) this.broadcastLocal(local)
    this.localPending = []
    this.clearRemote()
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
    void this.apply(local.batch, local.whole ? local.commit : undefined)
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

  private receive(message: CoordinationMessage): void {
    if (message.type === "hello") {
      if (this.role === "owner" && this.decided) this.announce()
    } else if (message.type === "decided") {
      if (this.role === "follower") this.followOwner(message)
    } else if (message.type === "call") {
      if (message.to === this.tabId) this.serveCall(message)
    } else if (message.type === "reply") {
      if (message.to === this.tabId) this.settleCall(message)
    } else if (message.type === "ack") {
      if (message.to === this.tabId) this.unacked.delete(message.id)
    } else if (message.type === "owner") {
      if (this.role === "follower" || this.role === "failed") {
        for (const batch of this.unacked.values()) this.options.coordination.broadcast(batch)
      }
    } else {
      const stores = message.touched.map((touched) => touched.store)
      // Another writer's write is in IndexedDB before it reaches SQLite.
      this.changed(stores)
      if (this.role !== "pending" && this.role !== "starting" && this.role !== "owner") return
      this.countRemote(stores, 1)
      if (this.role === "owner" && this.idbOpen) this.applyRemote(message)
      else this.remotePending.push(message)
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
      const applied = this.apply(batch, commit)
      this.countRemote(stores, -1)
      void applied.then((reply) => {
        if (!reply) return
        this.changed(stores)
        if (message.from === this.tabId) this.unacked.delete(message.id)
        else this.options.coordination.broadcast({ type: "ack", to: message.from, id: message.id })
        if (this.mode !== "shadow") signalStorageMutated(this.options.database, stores)
      })
    }).catch((error: unknown) => {
      this.lose(stores, error)
      this.countRemote(stores, -1)
    })
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

  /** SQLite missed writes to these stores: they leave its reads, and their marks stay ahead of it, so the next owner re-backfills them. */
  private lose(stores: readonly string[], error: unknown): void {
    markFailure(new Error(`Lost writes to ${[...new Set(stores)].join(", ")}`, { cause: error }))
    this.distrust(stores)
  }

  /** For the rest of the session: a later backfill may have read IndexedDB before the write SQLite missed. */
  private distrust(stores: readonly string[]): void {
    const served = stores.filter((store) => this.trusts(store))
    for (const store of stores) {
      this.distrusted.add(store)
      this.trusted.delete(store)
    }
    this.persistTrusted()
    this.rereadLiveQueries(served)
  }

  /** Live queries SQLite answered may hold what it lacked; they run again, now on IndexedDB. */
  private rereadLiveQueries(stores: readonly string[]): void {
    if (this.mode === "read-only" && stores.length > 0) signalStorageMutated(this.options.database, stores)
  }

  private trust(store: string): void {
    if (this.distrusted.has(store)) return
    this.trusted.add(store)
    this.persistTrusted()
  }

  /** Only the owner knows what SQLite holds; the next boot routes reads by what it trusted last. */
  private persistTrusted(): void {
    if (this.role !== "owner") return
    const { name, verno } = this.options.database
    localStorage.setItem(`${TRUSTED_PREFIX}${name}`, JSON.stringify({ version: verno, stores: [...this.trusted] }))
  }

  private send(request: MirrorRequest): Promise<OkReply | null> {
    return new Promise((resolve) => {
      this.outbox.push({
        read: false,
        writes: writesOf(request),
        run: () => this.deliver(request).then(resolve),
        cancel: () => resolve(null),
      })
      this.pump()
    })
  }

  /** Queued right behind the last unsent request that writes its store, so it reads every write committed before it. */
  private enqueueRead(transport: MirrorTransport, request: MirrorReadRequest): Promise<MirrorReply> {
    return new Promise((resolve, reject) => {
      const outgoing: Outgoing = {
        read: true,
        writes: [],
        run: () => {
          const reply = withProgressDeadline(
            transport,
            transport.request(request),
            this.deadlines.readMs,
            `SQLite read of ${request.store}`
          )
          reply.then(resolve, reject)
          return reply
        },
        cancel: () => reject(new Error(`SQLite mirror stopped before reading ${request.store}`)),
      }
      let after = this.outbox.length - 1
      while (after >= 0 && !(this.outbox[after].writes?.includes(request.store) ?? true)) after--
      this.outbox.splice(after + 1, 0, outgoing)
      this.pump()
    })
  }

  private pump(): void {
    while (!this.sending && this.outbox.length > 0) {
      const next = this.outbox.shift()!
      if (next.read) {
        next.run().catch(() => {})
        continue
      }
      this.sending = true
      void next.run().finally(() => {
        this.sending = false
        this.pump()
      })
    }
  }

  private dropOutbox(): void {
    const dropped = this.outbox
    this.outbox = []
    for (const outgoing of dropped) outgoing.cancel()
  }

  private async deliver(request: MirrorRequest): Promise<OkReply | null> {
    const transport = this.transport
    if (!transport) return null
    let reply: MirrorReply
    try {
      reply = await withProgressDeadline(
        transport,
        transport.request(request),
        this.deadlines.workerMs,
        `SQLite ${request.type}`
      )
    } catch (error) {
      if (this.transport === transport) this.fail(error)
      return null
    }
    if (!reply.ok) {
      const error = `${reply.error}: ${reply.message}`
      // Untrusted before any read queued behind this apply resolves.
      if (request.type === "apply")
        this.lose(
          request.batch.map((mutation) => mutation.store),
          error
        )
      else markFailure(error)
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
    const served = [...this.trusted].filter((store) => this.trusts(store))
    this.role = "failed"
    this.options.guard.releasePrimary()
    this.settle()
    if (this.serving) this.settleServing(true)
    else void this.fallBackToIdb()
    this.rereadLiveQueries(served)
    const transport = this.transport
    this.transport = null
    transport?.close()
    this.dropOutbox()
    this.options.coordination.resign()
    for (const local of this.localPending) this.broadcastLocal(local)
    this.localPending = []
    this.clearRemote()
  }

  private async becomeOwner(): Promise<void> {
    const { database, createTransport } = this.options
    this.role = "starting"
    this.loseOwner()
    const capture = getPerfCapture()
    const openedAt = performance.now()
    try {
      const schema = mirroredSchema(database)
      const stores = schema.map((store) => store.name)
      this.transport = createTransport()
      const opened = await this.send({ type: "open", idbName: database.name, schema, idbVersion: database.verno })
      if (this.isStopped()) return
      if (!opened) throw new Error("SQLite mirror could not open its database")
      capture.mark("sqlite.open", performance.now() - openedAt)
      this.role = "owner"
      this.options.coordination.broadcast({ type: "owner" })
      for (const local of this.localPending) this.applyOwn(local)
      this.localPending = []
      if (opened.backlog) await this.drainBeforeIdbOpens()
      await this.booted
      const primary = await this.primaryMarked()
      if (this.role !== "owner") return
      // Read-write is decided on the marks, which only an open IndexedDB can show; Dexie's ready handlers wait for it.
      if (this.mode === "read-write") this.idbGate.resolve()
      else await this.decide(false, primary)
      // Not `open()` alone: Dexie's open waits for its ready handlers, whose reads may wait for this claim.
      await Promise.race([database.whenIdbOpen(), database.open()])
      if (this.role !== "owner") return
      this.idbOpen = true
      for (const batch of this.unacked.values()) {
        this.countRemote(
          batch.touched.map((touched) => touched.store),
          1
        )
        this.remotePending.push(batch)
      }
      for (const remote of this.remotePending) this.applyRemote(remote)
      this.remotePending = []
      const reconciled = await this.reconcile(stores)
      if (!reconciled || this.role !== "owner") return
      this.trusted.clear()
      for (const store of reconciled.trusted) this.trust(store)
      this.persistTrusted()
      if (this.mode === "read-write") {
        const serving = this.entersReadWrite(stores, reconciled.trusted) && (await this.goPrimary(primary))
        await this.decide(serving, primary)
        if (this.role !== "owner") return
      }
      this.settle()
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

  /** Requests fail instead while SQLite may hold writes IndexedDB lacks, or while another tab serves read-write. */
  private async fallBackToIdb(): Promise<void> {
    const native = !(await this.primaryMarked()) && (await this.holdNative(false))
    this.settleServing(!native)
  }

  /** Read-write needs every mirrored store held in full, so no request ever needs IndexedDB's copy. */
  private entersReadWrite(stores: readonly string[], trusted: ReadonlySet<string>): boolean {
    const blocker = readWriteBlocker(this.options.database)
    if (blocker) {
      console.error(`SQLite storage cannot run read-write: ${blocker}`)
      return false
    }
    const untrusted = stores.filter((store) => !trusted.has(store))
    if (untrusted.length === 0) return true
    console.warn(`SQLite storage stays read-only until it holds every store in full; missing: ${untrusted.join(", ")}`)
    getPerfCapture().count("sqlite.readWriteDeferred")
    return false
  }

  /**
   * The exclusive lock first, so no tab writes IndexedDB itself from here on;
   * then the durable marker, before the first write only SQLite holds.
   */
  private async goPrimary(marked: boolean): Promise<boolean> {
    if (this.nativeHeld || !(await this.options.guard.claimPrimary())) {
      console.warn("SQLite storage stays read-only: another tab writes IndexedDB directly")
      getPerfCapture().count("sqlite.readWriteDeferred")
      return false
    }
    if (marked) return true
    try {
      await this.options.guard.markPrimary(true)
      return true
    } catch (error) {
      this.options.guard.releasePrimary()
      markFailure(error)
      return false
    }
  }

  /** Not serving, this tab writes IndexedDB itself; the backlog drained when it took ownership, so the marker goes. */
  private async decide(serving: boolean, primary: boolean): Promise<void> {
    if (!serving) {
      await this.holdNative(true)
      if (primary) await this.options.guard.markPrimary(false)
    }
    if (this.role !== "owner") return
    this.decided = true
    this.settleServing(serving)
    this.announce()
  }

  private async drainBeforeIdbOpens(): Promise<void> {
    const idb = await openInstalledIdb(this.options.database.name)
    try {
      await this.drainInto(idb)
    } finally {
      idb.close()
    }
  }

  /** Background, in commit order; a row leaves the backlog only once IndexedDB committed it. */
  private scheduleDrain(): void {
    this.drainRequested = true
    if (this.draining) return
    this.draining = (async () => {
      while (this.drainRequested && this.role === "owner") {
        this.drainRequested = false
        await this.drainInto(this.options.database.backendDB())
      }
    })()
      .catch((error: unknown) => markFailure(new Error("IndexedDB backup fell behind", { cause: error })))
      .finally(() => (this.draining = null))
  }

  /** Raw IndexedDB writes without marks: these rows came from SQLite, so a mark would only send it to re-backfill them. */
  private async drainInto(idb: IDBDatabase): Promise<void> {
    for (;;) {
      const { batches = [] } = await this.ask({ type: "backlog", limit: BACKLOG_CHUNK_BATCHES })
      if (batches.length === 0) return
      await replayBacklog(idb, batches)
      await this.ask({ type: "backlogDone", through: batches[batches.length - 1].seq })
    }
  }

  /**
   * The owner dispatches to its worker before yielding, so requests reach it in
   * call order; a follower serving read-write sends them to the owner. Between
   * owners they wait for the next.
   */
  private ask(request: MirrorRequest): Promise<OkReply> {
    if (this.role === "owner" && this.transport) return this.askWorker(this.transport, request)
    if (this.role === "follower" && this.serving && this.owner) return this.call(this.owner.tab, request)
    if (!this.serving || (this.role !== "follower" && this.role !== "starting")) return Promise.reject(unavailable())
    return this.routable.promise.then(() =>
      this.role === "owner" || (this.role === "follower" && this.serving && this.owner)
        ? this.ask(request)
        : Promise.reject(unavailable())
    )
  }

  private async askWorker(transport: MirrorTransport, request: MirrorRequest): Promise<OkReply> {
    let reply: MirrorReply
    try {
      reply = await withProgressDeadline(
        transport,
        transport.request(request),
        this.deadlines.workerMs,
        `SQLite ${request.type}`
      )
    } catch (error) {
      if (this.transport === transport) this.fail(error)
      throw unavailable()
    }
    if (!reply.ok) throw new DOMException(reply.message, reply.error)
    return reply
  }

  private call(owner: string, request: MirrorRequest): Promise<OkReply> {
    const tx = txOf(request)
    if (tx !== undefined) {
      if (request.type === "begin") this.txOwners.set(tx, owner)
      if (this.txOwners.get(tx) !== owner) return Promise.reject(ownerLost())
      if (request.type === "commit" || request.type === "rollback") this.txOwners.delete(tx)
    }
    const id = ++this.nextCall
    const reply = new Promise<OkReply>((resolve, reject) => this.calls.set(id, { owner, resolve, reject }))
    this.options.coordination.broadcast({ type: "call", from: this.tabId, to: owner, id, request })
    return reply
  }

  private settleCall(message: Extract<ReadWriteMessage, { type: "reply" }>): void {
    const call = this.calls.get(message.id)
    if (!call) return
    this.calls.delete(message.id)
    if (message.reply.ok) call.resolve(message.reply)
    else call.reject(new DOMException(message.reply.message, message.reply.error))
  }

  private followOwner(message: Extract<ReadWriteMessage, { type: "decided" }>): void {
    if (this.owner?.tab !== message.tab) {
      this.loseOwner()
      this.owner = {
        tab: message.tab,
        unwatch: this.options.coordination.watchTab(message.tab, () => this.loseOwner()),
      }
    }
    if (message.serving) return this.settleServing(true)
    void this.holdNative(true).then(() => {
      if (this.role === "follower" && this.owner?.tab === message.tab) this.settleServing(false)
    })
  }

  /** What this follower had in flight on the owner fails; what it sends next waits for the next owner. */
  private loseOwner(): void {
    const owner = this.owner
    if (!owner) return
    this.owner = null
    owner.unwatch()
    this.routable = deferred()
    for (const [id, call] of this.calls) {
      if (call.owner !== owner.tab) continue
      this.calls.delete(id)
      call.reject(ownerLost())
    }
  }

  private announce(): void {
    this.options.coordination.broadcast({ type: "decided", tab: this.tabId, serving: this.serving })
  }

  /** Runs a follower's request as this tab's own, under a transaction id of this tab's. */
  private serveCall(message: Extract<ReadWriteMessage, { type: "call" }>): void {
    const respond = (reply: MirrorReply) =>
      this.options.coordination.broadcast({ type: "reply", to: message.from, id: message.id, reply })
    const fail = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      respond({ ok: false, error: failure.name, message: failure.message })
    }
    // A tab that followed this one's predecessor may call before it learns this one writes IndexedDB.
    if (!this.serving) return fail(unavailable())
    let request = message.request
    if ("tx" in request && request.tx !== undefined) {
      const tx = request.tx
      const transactions = this.servedBy(message.from)
      if (request.type === "begin") transactions.set(tx, ++this.nextTx)
      const own = transactions.get(tx)
      if (own === undefined)
        return fail(new DOMException(`Transaction ${tx} is not active`, "TransactionInactiveError"))
      if (request.type === "commit" || request.type === "rollback") transactions.delete(tx)
      request = { ...request, tx: own }
    }
    const committed = request.type === "commit"
    this.ask(request).then((reply) => {
      respond(reply)
      if (committed) this.scheduleDrain()
    }, fail)
  }

  /** A follower that closes mid-transaction would hold the worker forever; its transactions roll back instead. */
  private servedBy(tab: string): Map<number, number> {
    let transactions = this.served.get(tab)
    if (transactions) return transactions
    transactions = new Map()
    this.served.set(tab, transactions)
    this.options.coordination.watchTab(tab, () => {
      const abandoned = this.served.get(tab) ?? new Map<number, number>()
      this.served.delete(tab)
      for (const own of abandoned.values()) void this.rollbackTransaction(own)
    })
    return transactions
  }

  /**
   * What SQLite holds in full: backfilled stores of this IndexedDB incarnation
   * with no mark past what SQLite holds of its writer. Anything else may lack
   * writes from a writer that died, never ran a mirror, or ran one no owner heard.
   */
  private async reconcile(
    stores: string[]
  ): Promise<{ status: MirrorStatus; marks: SqliteMark[]; trusted: Set<string> } | null> {
    const { incarnation, marks } = await readMarks(this.options.database.backendDB(), stores)
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
    const stores = new Set(mirroredSchema(this.options.database).map((store) => store.name))
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
        this.trust(store)
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

export function createBrowserMirror(
  database: ThreaDatabase,
  mode: SqliteMirrorMode,
  guard: IdbGuard = createBrowserGuard(database.name)
): SqliteMirror {
  return new SqliteMirror({
    database,
    mode,
    coordination: createBrowserCoordination(database.name, database.sqliteWriter.id),
    guard,
    createTransport: createWorkerTransport,
  })
}
