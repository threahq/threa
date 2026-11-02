import { RangeSet } from "dexie"
import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { discardPrefetches } from "../prefetch-inbox"
import { drainBacklog } from "./idb-backlog"
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
import { ranRequestedMode, readSqliteStorageMode, recordMode, reloadEveryTab, takeModeReload } from "./storage-mode"
import { isMirroredStore } from "./stores"
import { encodeValue } from "./value-codec"
import { createWorkerTransport } from "./worker-transport"

const BACKFILL_CHUNK_ROWS = 500
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
  /** A read-write tab waiting for an owner to answer; past it its requests fail until one does. */
  decidedMs: number
  /** The first retry of a backlog replay IndexedDB refused; each next one waits twice as long. */
  drainRetryMs: number
  /** Read-write: the wait before this tab claims ownership again after its worker failed; each next one waits twice as long. */
  recoverMs: number
}

export const DEFAULT_DEADLINES: MirrorDeadlines = {
  claimMs: 5_000,
  readMs: 5_000,
  workerMs: 30_000,
  decidedMs: 15_000,
  drainRetryMs: 1_000,
  recoverMs: 1_000,
}

const MAX_DRAIN_RETRY_MS = 60_000
/** Workers in a row that fail before serving; past it requests fail and the user is told. */
const MAX_RECOVERIES = 3
/** Tabs of builds speaking another protocol never follow each other. */
const READ_WRITE_PROTOCOL = 1

class DeadlineError extends Error {
  override readonly name = "DeadlineError"
}

/** Rejects once the worker has reported nothing for `ms` since the request was sent. */
export function withProgressDeadline<T>(
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
 * Under read-write storage: a tab asks for the owner, the owner announces
 * itself once it serves, and followers send it their worker requests to run
 * on their behalf.
 */
export type ReadWriteMessage =
  | { type: "hello"; from: string; protocol: number }
  | { type: "decided"; tab: string; protocol: number }
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
      resigned = false
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
  createTransport: () => MirrorTransport
  deadlines?: Partial<MirrorDeadlines>
  /** Read-write only: this boot holds every other tab out, so it may make SQLite the primary copy; otherwise SQLite already is. */
  entering?: boolean
  reloadEveryTab?: () => void
}

type Role = "idle" | "pending" | "follower" | "starting" | "owner" | "failed"

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

/** A request of a read-write transaction, and what it was answered: `!` and the error's name for a failure. */
interface Asked {
  request: MirrorRequest
  answer?: string
  resolve(reply: OkReply): void
  reject(error: unknown): void
}

/**
 * A read-write transaction, kept until it ends: a worker that dies takes the
 * transaction with it, uncommitted, so the next route runs it again. It goes
 * on only where every request answers as it did, so it saw what it would have.
 */
interface RoutedTx {
  readonly: boolean
  /** This tab (its own worker) or the owner's tab; `null` while it waits for the next owner. */
  route: string | null
  asked: Asked[]
  failed: DOMException | null
  /** Answers given on a lost route, asked again and not yet matched: its commit waits for every one. */
  unmatched: number
  heldCommit: Asked | null
}

function answerOf(reply: OkReply): string {
  return JSON.stringify([reply.result, reply.failures], (_, value: unknown) =>
    value instanceof Uint8Array ? Array.from(value) : value
  )
}

function errorAnswer(error: unknown): string {
  return `!${(error as { name?: unknown } | null)?.name}`
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
  // Not AbortError: an IndexedDB open failing with that is recovered by deleting the database.
  return new DOMException("The tab running SQLite storage closed during this transaction", "OwnerLostError")
}

function inactive(tx: number): DOMException {
  return new DOMException(`Transaction ${tx} is not active`, "TransactionInactiveError")
}

function outcomeUnknown(): DOMException {
  return new DOMException(
    "SQLite storage stopped answering while committing; the transaction may have committed",
    "OutcomeUnknownError"
  )
}

/** Dexie reports what aborted a transaction as the abort's cause. */
function failedWith(error: unknown, name: string): boolean {
  const cause = (error as { inner?: unknown } | null)?.inner
  return [error, cause].some((e) => e instanceof DOMException && e.name === name)
}

/** A commit SQLite storage may have applied though no answer came. */
export function isOutcomeUnknown(error: unknown): boolean {
  return failedWith(error, "OutcomeUnknownError")
}

/** A transaction that never committed: its owner was lost, and running it again read what another tab wrote meanwhile. */
export function isOwnerLost(error: unknown): boolean {
  return failedWith(error, "OwnerLostError")
}

function deferred(): { promise: Promise<void>; resolve: () => void; settled: boolean } {
  let settle = () => {}
  const promise = new Promise<void>((done) => (settle = done))
  const gate = {
    promise,
    settled: false,
    resolve: () => {
      gate.settled = true
      settle()
    },
  }
  return gate
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

function reportDrainFailure(error: unknown): void {
  getPerfCapture().count("sqlite.drainFailure")
  console.error("SQLite storage could not replay its backlog into IndexedDB; retrying", error)
}

/** Opening IndexedDB would upgrade it; a browser that cannot tell counts as one that would. */
async function upgradePending(database: ThreaDatabase): Promise<boolean> {
  try {
    const installed = (await indexedDB.databases()).find((info) => info.name === database.name)
    return installed?.version !== undefined && installed.version < database.verno * 10
  } catch {
    return true
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function markFailure(error: unknown): void {
  getPerfCapture().count("sqlite.mirrorFailure")
  console.error("SQLite mirror failure", error)
}

export function mirroredSchema(database: ThreaDatabase): MirrorStoreSchema[] {
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
 * Under read-write storage SQLite is the primary copy instead, for every tab
 * of the database: its transactions write no marks, and each commit lands in
 * a backlog the owner replays into IndexedDB, bypassing marks, as SQLite
 * already holds those rows. The recorded mode keeps it so until a boot drains
 * the backlog.
 */
export class SqliteMirror {
  readonly mode: SqliteMirrorMode
  private role: Role = "idle"
  private transport: MirrorTransport | null = null
  private localPending: LocalCommit[] = []
  private remotePending: MirrorBatch[] = []
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
   * its backlog. Stays set when this tab loses its owner or worker: requests
   * then wait for the next owner, or fail, rather than read a stale backup.
   */
  private serving = false
  /** SQLite is the recorded primary copy: until an owner serves, requests wait for it rather than fall back to IndexedDB. */
  private primary: boolean
  /** The owner opens IndexedDB once the backlog landed under the schema it was written in. */
  private readonly idbGate = deferred()
  private nextTx = 0
  /** Every drain, one at a time: a later one must not replay a batch before an earlier one's. */
  private drains: Promise<void> = Promise.resolve()
  private drainQueued = false
  private drainRetryMs = 0
  /** Workers this primary tab failed on in a row before one served. */
  private recoveries = 0
  /** IndexedDB is being upgraded: no transaction begins on this owner any more. */
  private closing = false
  /** Settles once requests have somewhere to go: SQLite, here or through the owner, or IndexedDB. */
  private routable = deferred()
  /** The owner this follower sends its requests to, watched so its end fails what it had in flight. */
  private owner: { tab: string; unwatch: () => void } | null = null
  private nextCall = 0
  /** This owner serves read-write: it runs transactions and answers followers. */
  private decided = false
  private readonly calls = new Map<
    number,
    {
      owner: string
      commit: boolean
      deadline: ReturnType<typeof setTimeout>
      resolve: (reply: OkReply) => void
      reject: (error: unknown) => void
    }
  >()
  /** When the owner last replied to any tab: a call waits on it only while it keeps answering someone. */
  private ownerHeardAt = 0
  /** This tab's read-write transactions, in creation order. */
  private readonly transactions = new Map<number, RoutedTx>()
  /** Followers' transactions this owner runs, by tab, as transactions of its own. */
  private readonly served = new Map<string, Map<number, number>>()

  constructor(private readonly options: SqliteMirrorOptions) {
    this.mode = options.mode
    this.primary = options.mode === "read-write" && !options.entering
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines }
    this.trusted = new Set(readTrustedHint(options.database.name, options.database.verno))
  }

  private get tabId(): string {
    return this.options.coordination.tabId
  }

  get readWrite(): boolean {
    return this.serving
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
  beginTransaction(mode: "readonly" | "readwrite"): number {
    const tx = ++this.nextTx
    this.ask({ type: "begin", tx, readonly: mode === "readonly" }).catch(() => {})
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
    coordination.onBroadcast((message) => this.receive(message))
    if (this.mode !== "read-write") this.settleServing(false)
    this.claim()
  }

  private claim(): void {
    this.options.coordination.claim((owner) => {
      if (this.role !== "pending" && this.role !== "follower") return
      if (owner) void this.becomeOwner()
      else this.becomeFollower()
    })
  }

  /** Requests now have somewhere to go: SQLite when serving, else IndexedDB. */
  private settleServing(serving: boolean): void {
    this.serving = serving
    this.resumeTransactions()
    this.routable.resolve()
    this.idbGate.resolve()
  }

  /** Requests wait for the next owner, which serves only once it holds what its predecessor committed. */
  private unroute(): void {
    if (this.routable.settled) this.routable = deferred()
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

  private settle(): void {
    this.claimSettled = true
    this.settleClaim()
  }

  private becomeFollower(): void {
    this.role = "follower"
    this.trusted.clear()
    this.settle()
    // An entering tab that is not the owner booted in the owner's gap after it stayed on IndexedDB.
    if (this.primary) this.awaitOwner()
    else if (this.mode === "read-write") this.settleServing(false)
    for (const local of this.localPending) this.broadcastLocal(local)
    this.localPending = []
    this.clearRemote()
  }

  /** An owner of another build, or none at all, never answers; requests then fail rather than wait forever. */
  private awaitOwner(): void {
    const hello = () =>
      this.options.coordination.broadcast({ type: "hello", from: this.tabId, protocol: READ_WRITE_PROTOCOL })
    this.idbGate.resolve()
    hello()
    const { decidedMs } = this.deadlines
    setTimeout(() => {
      if (this.role !== "follower" || this.owner) return
      getPerfCapture().count("sqlite.decisionOverdue")
      console.error(`No tab answered as SQLite storage's owner within ${decidedMs} ms; requests fail until one does`)
      this.settleServing(true)
      hello()
    }, decidedMs)
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
      if (this.role === "owner" && this.decided && message.protocol === READ_WRITE_PROTOCOL) this.announce()
    } else if (message.type === "decided") {
      if (this.role === "follower" && message.protocol === READ_WRITE_PROTOCOL) this.followOwner(message.tab)
    } else if (message.type === "call") {
      if (message.to === this.tabId) this.serveCall(message)
    } else if (message.type === "reply") {
      this.ownerHeardAt = performance.now()
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
    if (this.serving) {
      // Re-reading IndexedDB, a backup that lags SQLite, would revert SQLite's newer rows.
      this.countRemote(stores, -1)
      getPerfCapture().count("sqlite.foreignWrite")
      console.error(`${message.from} wrote ${stores.join(", ")} to IndexedDB while SQLite is the primary copy`)
      return
    }
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
   * broadcasting this tab's writes to it. Where SQLite is the primary copy,
   * this tab then claims ownership again, on a fresh worker.
   */
  private fail(error: unknown): void {
    if (this.role === "failed") return
    markFailure(error)
    const served = [...this.trusted].filter((store) => this.trusts(store))
    this.role = "failed"
    this.decided = false
    this.orphan(this.tabId)
    this.settle()
    if (this.primary) this.recover()
    else if (!this.routable.settled) this.settleServing(false)
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

  /** Requests wait for the next owner, this tab or another; once workers keep failing they fail instead, and the user is told. */
  private recover(): void {
    this.unroute()
    if (this.recoveries === MAX_RECOVERIES) {
      console.error(`SQLite storage failed on ${MAX_RECOVERIES} workers in a row; its requests fail until a reload`)
      this.options.database.reportStorageFailure(true)
      this.settleServing(true)
      return
    }
    const waitMs = this.deadlines.recoverMs * 2 ** this.recoveries++
    setTimeout(() => {
      if (this.role !== "failed" || this.options.database.hasBeenClosed()) return
      this.role = "pending"
      this.claim()
    }, waitMs)
  }

  private async becomeOwner(): Promise<void> {
    const { database, createTransport } = this.options
    this.role = "starting"
    this.decided = false
    this.loseOwner()
    if (this.serving) this.unroute()
    const capture = getPerfCapture()
    const openedAt = performance.now()
    try {
      const schema = mirroredSchema(database)
      const stores = schema.map((store) => store.name)
      this.transport = createTransport()
      const opened = await this.send({ type: "open", idbName: database.name, schema, idbVersion: database.verno })
      if (!opened) throw new Error("SQLite mirror could not open its database")
      capture.mark("sqlite.open", performance.now() - openedAt)
      this.role = "owner"
      this.options.coordination.broadcast({ type: "owner" })
      for (const local of this.localPending) this.applyOwn(local)
      this.localPending = []
      if (opened.backlog) await this.landBootBacklog()
      this.idbGate.resolve()
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
        await this.decide(this.holdsEverything(stores, reconciled.trusted))
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
      if (!backfilled) return
      await this.forget(reconciled, backfilled, live)
      if (this.role === "owner") this.reloadToEnterReadWrite(stores)
    } catch (error) {
      this.fail(error)
    }
  }

  /** Read-write needs every mirrored store held in full, so no request ever needs IndexedDB's copy. */
  private holdsEverything(stores: readonly string[], trusted: ReadonlySet<string>): boolean {
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
   * Holding every store, SQLite serves, recorded as the primary copy before
   * its first write. Short of that, an entering boot stays on IndexedDB this
   * session; a database already read-write, as after an IndexedDB upgrade,
   * lands its backlog and hands back to IndexedDB for every tab's next boot.
   */
  private async decide(full: boolean): Promise<void> {
    const { database } = this.options
    const entering = this.options.entering && !this.primary
    if (full) {
      if (entering) {
        await recordMode(database.name, "read-write")
        ranRequestedMode(database.name)
      }
      this.primary = true
      if (this.role !== "owner") return
      this.decided = true
      this.recoveries = 0
      this.settleServing(true)
      this.announce()
    } else if (entering) {
      this.settleServing(false)
    } else {
      await discardPrefetches(database.name)
      await this.drain()
      await recordMode(database.name, "read-only")
      ;(this.options.reloadEveryTab ?? reloadEveryTab)()
    }
  }

  /**
   * The flag asks for read-write and SQLite now holds every store, yet this
   * session runs on IndexedDB: every tab reloads, so the next boot may wait
   * for the others to close and enter. A plain reload never waits for them.
   */
  private reloadToEnterReadWrite(stores: readonly string[]): void {
    const { database } = this.options
    if (this.primary || readSqliteStorageMode(database.name) !== "read-write") return
    if (readWriteBlocker(database) || !stores.every((store) => this.trusted.has(store))) return
    if (takeModeReload(database.name, "enter")) (this.options.reloadEveryTab ?? reloadEveryTab)()
  }

  /**
   * Another tab upgrades IndexedDB: nothing begins here any more, and the
   * backlog lands under the schema it was written in, by this tab as owner or
   * by the owner a follower follows, which closes only once it did. Meanwhile
   * the connection stays open, holding the upgrade back; false once no owner
   * will come, so it stays open for good.
   */
  async drainBeforeClose(): Promise<boolean> {
    this.closing = true
    while (this.role !== "owner" && this.primary && !(this.role === "follower" && this.owner)) {
      if (this.routable.settled) {
        console.error("SQLite storage has no owner to land its backlog; IndexedDB stays open, holding the upgrade back")
        return false
      }
      await this.routable.promise
    }
    if (this.role !== "owner") return true
    try {
      await this.drainUntilLanded()
      return true
    } catch {
      return this.drainBeforeClose()
    }
  }

  /**
   * A backlog written under an older schema lands before IndexedDB opens, as
   * opening upgrades it; under the installed schema it may land once open.
   */
  private async landBootBacklog(): Promise<void> {
    try {
      await this.drain()
    } catch (error) {
      if (this.role !== "owner") throw error
      if (this.mode === "read-write" && (await upgradePending(this.options.database))) await this.drainUntilLanded()
      else this.drainFailed(error)
    }
  }

  /** Rejects only once this tab no longer owns the worker; the user is told while IndexedDB keeps refusing it. */
  private async drainUntilLanded(): Promise<void> {
    const { database } = this.options
    let refused = false
    try {
      for (let waitMs = this.deadlines.drainRetryMs; ; waitMs = Math.min(waitMs * 2, MAX_DRAIN_RETRY_MS)) {
        try {
          return await this.drain()
        } catch (error) {
          if (this.role !== "owner") throw error
          reportDrainFailure(error)
          refused = true
          database.reportStorageFailure(true)
          await new Promise((resolve) => setTimeout(resolve, waitMs))
        }
      }
    } finally {
      if (refused) database.reportStorageFailure(false)
    }
  }

  /**
   * Every drain runs here, one after another, until the worker answers the
   * backlog is empty; its `backlog` request waits for every transaction the
   * worker admitted, so a drain that finds nothing left is final.
   */
  private drain(): Promise<void> {
    const drained = this.drains.then(async () => {
      this.drainQueued = false
      const transport = this.transport
      if (this.role !== "owner" || !transport) throw unavailable()
      const { database } = this.options
      await drainBacklog(
        (request) => this.askWorker(transport, request),
        this.idbOpen ? database.backendDB() : database.name
      )
    })
    this.drains = drained.catch(() => {})
    return drained
  }

  private scheduleDrain(): void {
    if (this.drainQueued || this.role !== "owner") return
    this.drainQueued = true
    this.drain().then(
      () => (this.drainRetryMs = 0),
      (error: unknown) => this.drainFailed(error)
    )
  }

  /** The backlog stays in SQLite, which keeps serving; IndexedDB catches up once it accepts the replay. */
  private drainFailed(error: unknown): void {
    // Closed after opening, the page is going away or Dexie reopens it; the next boot or commit drains.
    if (this.idbOpen && !this.options.database.isOpen()) return
    reportDrainFailure(error)
    if (this.role !== "owner") return
    this.drainRetryMs = Math.min(this.drainRetryMs * 2 || this.deadlines.drainRetryMs, MAX_DRAIN_RETRY_MS)
    setTimeout(() => this.scheduleDrain(), this.drainRetryMs)
  }

  /**
   * The owner dispatches to its worker before yielding, so requests reach it in
   * call order; a follower sends them to the owner. Between owners, and until
   * an owner serves, they wait.
   */
  private ask(request: MirrorRequest): Promise<OkReply> {
    const tx = txOf(request)
    if (tx !== undefined) return this.askInTx(tx, request)
    if (this.role === "owner" && this.decided && this.transport) return this.askWorker(this.transport, request)
    if (this.role === "follower" && this.owner) return this.call(this.owner.tab, request)
    if (this.mode !== "read-write" || this.routable.settled) return Promise.reject(unavailable())
    return this.routable.promise.then(() => this.ask(request))
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
      throw request.type === "commit" ? outcomeUnknown() : unavailable()
    }
    if (!reply.ok) throw new DOMException(reply.message, reply.error)
    return reply
  }

  /** Where requests go now: this tab's worker, named by this tab, or the owner's tab. */
  private route(): string | null {
    if (this.role === "owner" && this.decided && this.transport) return this.tabId
    if (this.role === "follower" && this.owner) return this.owner.tab
    return null
  }

  private dispatch(route: string, request: MirrorRequest): Promise<OkReply> {
    if (route !== this.tabId) return this.call(route, request)
    return this.transport ? this.askWorker(this.transport, request) : Promise.reject(unavailable())
  }

  private askInTx(tx: number, request: MirrorRequest): Promise<OkReply> {
    if (request.type === "begin") {
      const route = this.route()
      const failed = this.closing || (!route && this.routable.settled)
      this.transactions.set(tx, {
        readonly: request.readonly,
        route,
        asked: [],
        failed: failed ? unavailable() : null,
        unmatched: 0,
        heldCommit: null,
      })
    }
    const routed = this.transactions.get(tx)
    if (!routed) return Promise.reject(inactive(tx))
    const ends = request.type === "commit" || request.type === "rollback"
    if (routed.failed) {
      if (ends) this.transactions.delete(tx)
      // A failed transaction holds nothing to roll back.
      return request.type === "rollback" ? Promise.resolve({ ok: true, ms: 0 }) : Promise.reject(routed.failed)
    }
    return new Promise((resolve, reject) => {
      const asked: Asked = { request, resolve, reject }
      routed.asked.push(asked)
      if (routed.route !== null) this.sendInTx(tx, routed, asked)
    })
  }

  private sendInTx(tx: number, routed: RoutedTx, asked: Asked): void {
    if (asked.request.type === "commit" && routed.unmatched > 0) {
      routed.heldCommit = asked
      return
    }
    const route = routed.route!
    if (asked.answer !== undefined) routed.unmatched++
    const answered = (answer: string, settle: () => void) => {
      if (this.transactions.get(tx) !== routed || routed.route !== route || routed.failed) return
      if (asked.answer !== undefined) {
        if (asked.answer !== answer) return this.failTx(tx, routed, ownerLost())
        const commit = routed.heldCommit
        if (--routed.unmatched > 0 || !commit) return
        routed.heldCommit = null
        this.sendInTx(tx, routed, commit)
        return
      }
      asked.answer = answer
      const { type } = asked.request
      if (type === "commit" || type === "rollback") this.transactions.delete(tx)
      settle()
    }
    this.dispatch(route, asked.request).then(
      (reply) => answered(answerOf(reply), () => asked.resolve(reply)),
      (error: unknown) => answered(errorAnswer(error), () => asked.reject(error))
    )
  }

  /** It ends as a transaction whose owner was lost would: rolled back where it runs, its open requests failed. */
  private failTx(tx: number, routed: RoutedTx, error: DOMException): void {
    const route = routed.route
    routed.failed = error
    if (route !== null) this.dispatch(route, { type: "rollback", tx }).catch(() => {})
    for (const asked of routed.asked) {
      if (asked.answer !== undefined) continue
      asked.answer = errorAnswer(error)
      asked.reject(error)
    }
  }

  /**
   * The worker behind `route` is gone with every transaction it held open,
   * uncommitted; each waits for the next route. A commit it was given may
   * have landed, so that one fails as of unknown outcome, unless it only read.
   */
  private orphan(route: string): void {
    for (const [tx, routed] of this.transactions) {
      if (routed.route !== route || routed.failed) continue
      const last = routed.asked.at(-1)
      const ending = last?.answer === undefined && last !== routed.heldCommit ? last?.request.type : undefined
      if (ending === "rollback" || (ending === "commit" && routed.readonly)) {
        this.transactions.delete(tx)
        last!.answer = ""
        last!.resolve({ ok: true, ms: 0 })
      } else if (ending !== "commit") {
        routed.route = null
        routed.unmatched = 0
        routed.heldCommit = null
      }
    }
  }

  /** Runs every transaction a lost route held again, in creation order, ahead of anything that waited for a route. */
  private resumeTransactions(): void {
    const route = this.route()
    for (const [tx, routed] of this.transactions) {
      if (routed.route !== null || routed.failed) continue
      if (!route) {
        this.failTx(tx, routed, unavailable())
        continue
      }
      routed.route = route
      for (const asked of routed.asked) this.sendInTx(tx, routed, asked)
    }
  }

  private call(owner: string, request: MirrorRequest): Promise<OkReply> {
    const id = ++this.nextCall
    const commit = request.type === "commit"
    const sentAt = performance.now()
    const { workerMs } = this.deadlines
    const check = () => {
      const call = this.calls.get(id)
      if (!call) return
      const silent = performance.now() - Math.max(sentAt, this.ownerHeardAt)
      if (silent < workerMs) call.deadline = setTimeout(check, workerMs - silent)
      else this.dropCall(id, commit ? outcomeUnknown() : ownerLost())
    }
    const reply = new Promise<OkReply>((resolve, reject) =>
      this.calls.set(id, { owner, commit, deadline: setTimeout(check, workerMs), resolve, reject })
    )
    this.options.coordination.broadcast({ type: "call", from: this.tabId, to: owner, id, request })
    return reply
  }

  private settleCall(message: Extract<ReadWriteMessage, { type: "reply" }>): void {
    const call = this.calls.get(message.id)
    if (!call) return
    this.calls.delete(message.id)
    clearTimeout(call.deadline)
    if (message.reply.ok) call.resolve(message.reply)
    else call.reject(new DOMException(message.reply.message, message.reply.error))
  }

  private dropCall(id: number, error: DOMException): void {
    const call = this.calls.get(id)
    if (!call) return
    this.calls.delete(id)
    clearTimeout(call.deadline)
    call.reject(error)
  }

  private followOwner(tab: string): void {
    if (this.owner?.tab !== tab) {
      this.loseOwner()
      this.owner = { tab, unwatch: this.options.coordination.watchTab(tab, () => this.loseOwner()) }
    }
    this.recoveries = 0
    this.settleServing(true)
  }

  /** What this follower had in flight on the owner runs again on the next owner, but a commit, which fails as of unknown outcome. */
  private loseOwner(): void {
    const owner = this.owner
    if (!owner) return
    this.owner = null
    owner.unwatch()
    this.unroute()
    this.orphan(owner.tab)
    for (const [id, call] of this.calls) {
      if (call.owner === owner.tab) this.dropCall(id, call.commit ? outcomeUnknown() : ownerLost())
    }
  }

  private announce(): void {
    this.options.coordination.broadcast({ type: "decided", tab: this.tabId, protocol: READ_WRITE_PROTOCOL })
  }

  /** Runs a follower's request as this tab's own, under a transaction id of this tab's. */
  private serveCall(message: Extract<ReadWriteMessage, { type: "call" }>): void {
    const respond = (reply: MirrorReply) =>
      this.options.coordination.broadcast({ type: "reply", to: message.from, id: message.id, reply })
    const fail = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      respond({ ok: false, error: failure.name, message: failure.message })
    }
    let request = message.request
    if ("tx" in request && request.tx !== undefined) {
      const tx = request.tx
      const transactions = this.servedBy(message.from)
      if (request.type === "begin") transactions.set(tx, ++this.nextTx)
      const own = transactions.get(tx)
      if (own === undefined) return fail(inactive(tx))
      if (request.type === "commit" || request.type === "rollback") transactions.delete(tx)
      request = { ...request, tx: own }
    }
    const committed = request.type === "commit"
    this.serve(request).then((reply) => {
      respond(reply)
      if (committed) this.scheduleDrain()
    }, fail)
  }

  /** A follower's request, run on this owner's worker; its own transaction log is the follower's. */
  private serve(request: MirrorRequest): Promise<OkReply> {
    if (this.closing && request.type === "begin") return Promise.reject(unavailable())
    if (this.role === "owner" && this.decided && this.transport) return this.askWorker(this.transport, request)
    return Promise.reject(unavailable())
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
      for (const own of abandoned.values()) this.serve({ type: "rollback", tx: own }).catch(() => {})
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
    if (status.incarnation !== incarnation && this.primary) {
      // IndexedDB was recreated, but holds only a backup: SQLite keeps every row and writes all of them to it again.
      if (!(await this.send({ type: "reseed", incarnation })))
        throw new Error("SQLite storage could not re-seed IndexedDB")
      if (this.role !== "owner") return null
      this.scheduleDrain()
      status = { ...status, incarnation }
    } else if (status.incarnation !== incarnation) {
      await this.drain()
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

export function createBrowserMirror(database: ThreaDatabase, mode: SqliteMirrorMode, entering = false): SqliteMirror {
  return new SqliteMirror({
    database,
    mode,
    coordination: createBrowserCoordination(database.name, database.sqliteWriter.id),
    createTransport: createWorkerTransport,
    entering,
  })
}
