import type { ThreaDatabase } from "../database"
import { getPerfCapture } from "@/lib/perf/capture"
import { importIndexedDb } from "./import"
import { mirrorChannelName } from "./marks"
import type { CommitLedger, MirrorStoreSchema, MirrorWrite } from "./mirror-store"
import type {
  MirrorReadRequest,
  MirrorReadResults,
  MirrorReply,
  MirrorRequest,
  MirrorTransport,
  OpenTimings,
} from "./protocol"
import {
  observeSqliteRead,
  reportStorageBoot,
  reportStorageFailure,
  reportStorageRecovered,
} from "./storage-diagnostics"
import { recordReadWrite } from "./storage-mode"
import { isMirroredStore } from "./stores"
import { createWorkerTransport } from "./worker-transport"

/**
 * How long anything waits on the worker or the owner. A worker chunk that
 * never loads or a worker killed without an error event answers nothing.
 * Deadlines count only time in which the worker reported no progress, so a
 * request queued behind long work is not cut off.
 */
export interface MirrorDeadlines {
  /** A request the worker is silent on; past it the worker is presumed dead and this tab hands ownership on. */
  workerMs: number
  /** A tab waiting for an owner to answer; past it its requests fail until one does. */
  decidedMs: number
  /** The wait before this tab claims ownership again after its worker failed; each next one waits twice as long. */
  recoverMs: number
}

export const DEFAULT_DEADLINES: MirrorDeadlines = {
  workerMs: 30_000,
  decidedMs: 15_000,
  recoverMs: 1_000,
}

/** A tab claims ownership again after every worker failure; the wait between claims grows to this. */
const MAX_RECOVER_WAIT_MS = 60_000
/** Tabs of builds speaking another protocol never follow each other. */
const READ_WRITE_PROTOCOL = 2

class DeadlineError extends Error {
  override readonly name = "DeadlineError"
}

/** A timer this late ran on a page that was frozen or blocked, which could hear nothing meanwhile. */
const LATE_TIMER_MS = 1_000

/**
 * Calls `onSilent` once `heardAt()` reported nothing for `ms`; the returned
 * function stops waiting. Time the page could not run does not count: a
 * frozen page resumes with a reply on its way, not a dead worker.
 */
function whenSilent(ms: number, heardAt: () => number, onSilent: () => void): () => void {
  let since = performance.now()
  let timer: ReturnType<typeof setTimeout>
  const wait = (delay: number) => {
    const dueAt = performance.now() + delay
    timer = setTimeout(() => {
      const now = performance.now()
      if (now - dueAt > LATE_TIMER_MS) since = now
      const silent = now - Math.max(since, heardAt())
      if (silent >= ms) onSilent()
      else wait(ms - silent)
    }, delay)
  }
  wait(ms)
  return () => clearTimeout(timer)
}

/** Rejects once the worker has reported nothing for `ms` since the request was sent. */
export function withProgressDeadline<T>(
  transport: MirrorTransport,
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = whenSilent(ms, transport.heardAt, () =>
      reject(new DeadlineError(`${what}: the worker reported nothing for ${ms} ms`))
    )
    promise.then(resolve, reject).finally(stop)
  })
}

/**
 * A tab asks for the owner, the owner announces itself once it serves, and
 * followers send it their worker requests to run on their behalf. Builds that
 * mirrored IndexedDB post other messages on the same channel; they are ignored.
 */
export type ReadWriteMessage =
  | { type: "hello"; from: string; protocol: number }
  | { type: "decided"; tab: string; protocol: number }
  | { type: "call"; from: string; to: string; id: number; request: MirrorRequest }
  | { type: "reply"; to: string; id: number; reply: MirrorReply }

/** Decides which tab owns the SQLite file, and carries other tabs' requests to it. */
export interface MirrorCoordination {
  /** This tab, live for as long as the page is. */
  readonly tabId: string
  /** Calls `onGone` once that tab is gone; the returned function stops watching. */
  watchTab(tabId: string, onGone: () => void): () => void
  /** Reports ownership: `false` at once when another tab holds it, then `true` when it is handed to this tab. */
  claim(onChange: (owner: boolean) => void): void
  /** Gives up ownership, or the queued claim for it, so another tab can own the file; the channel stays open. */
  resign(): void
  broadcast(message: ReadWriteMessage): void
  onBroadcast(listener: (message: ReadWriteMessage) => void): () => void
}

export function createBrowserCoordination(idbName: string, tabId: string): MirrorCoordination {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Web Locks API is unavailable")
  if (typeof BroadcastChannel === "undefined") throw new Error("BroadcastChannel is unavailable")
  const name = mirrorChannelName(idbName)
  const tabPrefix = `threa-sqlite-mirror-tab:${idbName}:`
  // Never released: the owner watches it to roll back the transactions of a tab that is gone.
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

  return {
    tabId,
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
    resign() {
      resigned = true
      releaseLock?.()
    },
    broadcast: (message) => channel.postMessage(message),
    onBroadcast(listener) {
      const handle = (event: MessageEvent<ReadWriteMessage>) => listener(event.data)
      channel.addEventListener("message", handle)
      return () => channel.removeEventListener("message", handle)
    },
  }
}

export interface SqliteMirrorOptions {
  database: ThreaDatabase
  coordination: MirrorCoordination
  createTransport: () => MirrorTransport
  deadlines?: Partial<MirrorDeadlines>
  /** SQLite already holds the primary copy; otherwise this boot holds every other tab out and imports IndexedDB first. */
  primary: boolean
}

type Role = "idle" | "pending" | "follower" | "starting" | "owner" | "failed"

type OkReply = Extract<MirrorReply, { ok: true }>

/** A request of a transaction, and what it was answered: `!` and the error's name for a failure. */
interface Asked {
  request: MirrorRequest
  answer?: string
  resolve(reply: OkReply): void
  reject(error: unknown): void
}

/**
 * A transaction, kept until it ends: a worker that dies takes the transaction
 * with it, uncommitted, so the next route runs it again. It goes on only where
 * every request answers as it did, so it saw what it would have.
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
  /** Its commit reached a route that was lost before answering: the next route's ledger tells whether it landed. */
  committing: boolean
}

function answerOf(reply: OkReply): string {
  return JSON.stringify([reply.result, reply.failures], (_, value: unknown) =>
    value instanceof Uint8Array ? Array.from(value) : value
  )
}

function errorAnswer(error: unknown): string {
  return `!${(error as { name?: unknown } | null)?.name}`
}

function unavailable(): DOMException {
  return new DOMException("SQLite storage has no owner serving this tab", "UnknownError")
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

function ledgerOf(routed: RoutedTx): CommitLedger {
  return (routed.asked.at(-1)!.request as Extract<MirrorRequest, { type: "commit" }>).ledger
}

const OWNER_LOST_RUNS = 3

/** Runs `run` again from its start while a try fails having never committed; each try must hold no state of the last. */
export async function rerunWhileOwnerLost<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (!isOwnerLost(error) || attempt === OWNER_LOST_RUNS) throw error
    }
  }
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

/** Why SQLite cannot serve a store: writes key rows by their inbound key path and know no unique indexes. */
function sqliteBlocker(database: ThreaDatabase): string | null {
  for (const table of database.tables) {
    if (!isMirroredStore(table.name)) continue
    const { primKey, indexes } = table.schema
    if (primKey.auto || !primKey.keyPath) return `${table.name} has no inbound primary key`
    if (indexes.some((index) => index.unique)) return `${table.name} has a unique index`
  }
  return null
}

function markFailure(error: unknown): void {
  getPerfCapture().count("sqlite.mirrorFailure")
  console.error("SQLite storage failure", error)
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

/**
 * Serves every transaction over this database's mirrored stores from SQLite.
 * One tab per database owns the worker holding the SQLite file; the others
 * send their requests to it. A boot onto a database SQLite does not hold yet
 * copies IndexedDB into it first, holding every other tab out meanwhile;
 * failing that, this session runs on IndexedDB.
 */
export class SqliteMirror {
  private role: Role = "idle"
  private transport: MirrorTransport | null = null
  private readonly deadlines: MirrorDeadlines
  /**
   * SQLite serves every request on mirrored stores. Stays set when this tab
   * loses its owner or worker: requests then wait for the next owner, or fail,
   * rather than read IndexedDB.
   */
  private serving = false
  /** SQLite holds the primary copy: until an owner serves, requests wait for it. */
  private primary: boolean
  /** IndexedDB may open: no import reads it, or the import ended. */
  private readonly idbGate = deferred()
  private nextTx = 0
  /** Workers this tab failed on in a row before one served. */
  private recoveries = 0
  private bootReported = false
  /** Settles once requests have somewhere to go: SQLite, here or through the owner, or IndexedDB. */
  private routable = deferred()
  /** The owner this follower sends its requests to, watched so its end fails what it had in flight. */
  private owner: { tab: string; unwatch: () => void } | null = null
  private nextCall = 0
  /** This owner serves: it runs transactions and answers followers. */
  private decided = false
  private readonly calls = new Map<
    number,
    {
      owner: string
      commit: boolean
      stopDeadline: () => void
      resolve: (reply: OkReply) => void
      reject: (error: unknown) => void
    }
  >()
  /** When the owner last replied to any tab: a call waits on it only while it keeps answering someone. */
  private ownerHeardAt = 0
  /** This tab's transactions, in creation order. */
  private readonly transactions = new Map<number, RoutedTx>()
  /** While the ledger answers whether commits a lost route was given landed, every other transaction waits behind them. */
  private resuming = false
  /** Followers' transactions this owner runs, by tab, as transactions of its own. */
  private readonly served = new Map<string, Map<number, number>>()

  constructor(private readonly options: SqliteMirrorOptions) {
    this.primary = options.primary
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines }
    if (this.primary) this.idbGate.resolve()
  }

  private get tabId(): string {
    return this.options.coordination.tabId
  }

  get readWrite(): boolean {
    return this.serving
  }

  /** What IndexedDB's open must wait for: an import reads IndexedDB as installed, before any upgrade. */
  beforeIdbOpen(): Promise<void> {
    return this.idbGate.promise
  }

  /** What Dexie's ready handlers wait for: whether this tab's transactions go to SQLite or IndexedDB. */
  whenRoutable(): Promise<void> {
    return this.routable.promise
  }

  /** Queues a transaction in creation order, as IndexedDB orders them; one that fails to begin fails its requests and commit. */
  beginTransaction(mode: "readonly" | "readwrite", stores: readonly string[]): number {
    const tx = ++this.nextTx
    this.askInTx(tx, { type: "begin", tx, readonly: mode === "readonly", stores }).catch(() => {})
    return tx
  }

  async write(tx: number, write: MirrorWrite): Promise<number[]> {
    return (await this.askInTx(tx, { type: "write", tx, write })).failures ?? []
  }

  async read<T extends MirrorReadRequest & { tx: number }>(request: T): Promise<MirrorReadResults[T["type"]]> {
    const sentAt = performance.now()
    try {
      return (await this.askInTx(request.tx, request)).result as MirrorReadResults[T["type"]]
    } finally {
      observeSqliteRead(performance.now() - sentAt)
    }
  }

  async commitTransaction(tx: number): Promise<void> {
    await this.askInTx(tx, { type: "commit", tx, ledger: { tab: this.tabId, tx } })
  }

  /** Never rejects: a rollback that fails leaves nothing to undo, the worker being gone or the transaction ended. */
  rollbackTransaction(tx: number): Promise<void> {
    return this.askInTx(tx, { type: "rollback", tx }).then(() => undefined, markFailure)
  }

  start(): void {
    if (this.role !== "idle") return
    this.role = "pending"
    this.options.coordination.onBroadcast((message) => this.receive(message))
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

  private becomeFollower(): void {
    this.role = "follower"
    // Another tab owns the file while this boot holds every other tab out: it can only be a build that predates this one.
    if (!this.primary) return this.fail(new Error("Another tab owns SQLite storage during the import"))
    this.awaitOwner()
  }

  /** An owner of another build, or none at all, never answers; requests then fail rather than wait forever. */
  private awaitOwner(): void {
    const hello = () =>
      this.options.coordination.broadcast({ type: "hello", from: this.tabId, protocol: READ_WRITE_PROTOCOL })
    hello()
    const { decidedMs } = this.deadlines
    setTimeout(() => {
      if (this.role !== "follower" || this.owner) return
      getPerfCapture().count("sqlite.decisionOverdue")
      console.error(`No tab answered as SQLite storage's owner within ${decidedMs} ms; requests fail until one does`)
      reportStorageFailure("owner_lost", { elapsedMs: decidedMs })
      this.options.database.reportStorageReconnecting(true)
      this.settleServing(true)
      hello()
    }, decidedMs)
  }

  private receive(message: ReadWriteMessage): void {
    switch (message.type) {
      case "hello":
        if (this.role === "owner" && this.decided && message.protocol === READ_WRITE_PROTOCOL) this.announce()
        return
      case "decided":
        if (this.role === "follower" && message.protocol === READ_WRITE_PROTOCOL) this.followOwner(message.tab)
        return
      case "call":
        if (message.to === this.tabId) this.serveCall(message)
        return
      case "reply":
        this.ownerHeardAt = performance.now()
        if (message.to === this.tabId) this.settleCall(message)
    }
  }

  /**
   * The worker died or never started: hand ownership to another tab. Where
   * SQLite is the primary copy this tab then claims ownership again, on a
   * fresh worker; an import that failed leaves this session on IndexedDB.
   */
  private fail(error: unknown): void {
    if (this.role === "failed") return
    markFailure(error)
    reportStorageFailure(this.primary ? "worker_failed" : "import_failed", { attempt: this.recoveries })
    this.role = "failed"
    this.decided = false
    this.orphan(this.tabId)
    if (this.primary) this.recover()
    else this.settleServing(false)
    const transport = this.transport
    this.transport = null
    transport?.close()
    this.options.coordination.resign()
  }

  /** Requests wait for the next owner, this tab or another, for as long as it takes; the user sees storage reconnecting. */
  private recover(): void {
    this.unroute()
    this.options.database.reportStorageReconnecting(true)
    const waitMs = Math.min(this.deadlines.recoverMs * 2 ** this.recoveries, MAX_RECOVER_WAIT_MS)
    this.recoveries++
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
    const openedAt = performance.now()
    try {
      const blocker = sqliteBlocker(database)
      if (blocker) throw new Error(`SQLite storage cannot hold ${database.name}: ${blocker}`)
      const schema = mirroredSchema(database)
      const transport = createTransport()
      this.transport = transport
      const ask = (request: MirrorRequest) => this.askWorker(transport, request)
      const { timings } = await ask({ type: "open", idbName: database.name, schema })
      const openMs = performance.now() - openedAt
      getPerfCapture().mark("sqlite.open", openMs)
      this.role = "owner"
      if (!this.primary) {
        const stores = schema.map((store) => store.name)
        await importIndexedDb(database.name, stores, ask, async () => {
          await recordReadWrite(database.name)
          this.primary = true
        })
        this.idbGate.resolve()
        if (this.role !== "owner") return
      }
      this.reportBoot("owner", { openMs: Math.round(openMs), ...timings })
      this.decided = true
      this.resumeServing()
      this.announce()
    } catch (error) {
      this.fail(error)
    }
  }

  /** SQLite serves this tab's requests again, itself or through an owner. */
  private resumeServing(): void {
    const recovered = this.recoveries > 0
    this.recoveries = 0
    this.settleServing(true)
    this.options.database.reportStorageReconnecting(false)
    if (recovered) reportStorageRecovered()
  }

  private reportBoot(role: "owner" | "follower", fields: { openMs?: number } & Partial<OpenTimings> = {}): void {
    if (this.bootReported) return
    this.bootReported = true
    reportStorageBoot(role, fields)
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

  /**
   * The owner dispatches to its worker before yielding, so requests reach it in
   * call order; a follower sends them to the owner. Between owners, and until
   * an owner serves, they wait.
   */
  private askInTx(tx: number, request: MirrorRequest): Promise<OkReply> {
    if (request.type === "begin") {
      const route = this.resuming ? null : this.route()
      const failed = !route && !this.resuming && this.routable.settled
      this.transactions.set(tx, {
        readonly: request.readonly,
        route,
        asked: [],
        failed: failed ? unavailable() : null,
        unmatched: 0,
        heldCommit: null,
        committing: false,
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
   * have landed: the next route answers whether it did, from SQLite's ledger.
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
      } else {
        routed.route = null
        routed.unmatched = 0
        routed.heldCommit = null
        routed.committing = ending === "commit"
      }
    }
  }

  /**
   * Runs every transaction a lost route held again, in creation order, ahead
   * of anything that waited for a route. A commit the lost route may have
   * applied is first looked up in the next route's ledger, every later
   * transaction waiting: one that landed completes, one that did not runs again
   * ahead of them, as it was ordered.
   */
  private resumeTransactions(): void {
    if (this.resuming) return
    const route = this.route()
    const waiting = [...this.transactions].filter(([, routed]) => routed.route === null && !routed.failed)
    const committing = route ? waiting.filter(([, routed]) => routed.committing) : []
    if (committing.length === 0) {
      for (const [tx, routed] of waiting) {
        if (!route) {
          this.failTx(tx, routed, routed.committing ? outcomeUnknown() : unavailable())
          continue
        }
        routed.route = route
        for (const asked of routed.asked) this.sendInTx(tx, routed, asked)
      }
      return
    }
    this.resuming = true
    const landed = committing.map(([, routed]) =>
      this.dispatch(route!, { type: "committed", ledger: ledgerOf(routed) }).then(
        (reply) => reply.committed ?? null,
        () => null
      )
    )
    void Promise.all(landed).then((answers) => {
      this.resuming = false
      committing.forEach(([tx, routed], i) => {
        if (this.transactions.get(tx) !== routed || routed.failed) return
        routed.committing = false
        if (answers[i] === null) {
          reportStorageFailure("outcome_unknown")
          return this.failTx(tx, routed, outcomeUnknown())
        }
        if (!answers[i]) return
        this.transactions.delete(tx)
        const commit = routed.asked.at(-1)!
        commit.answer = ""
        commit.resolve({ ok: true, ms: 0 })
      })
      this.resumeTransactions()
    })
  }

  private call(owner: string, request: MirrorRequest): Promise<OkReply> {
    const id = ++this.nextCall
    const commit = request.type === "commit"
    const reply = new Promise<OkReply>((resolve, reject) => {
      const stopDeadline = whenSilent(
        this.deadlines.workerMs,
        () => this.ownerHeardAt,
        () => this.dropCall(id, commit ? outcomeUnknown() : ownerLost())
      )
      this.calls.set(id, { owner, commit, stopDeadline, resolve, reject })
    })
    this.options.coordination.broadcast({ type: "call", from: this.tabId, to: owner, id, request })
    return reply
  }

  private settleCall(message: Extract<ReadWriteMessage, { type: "reply" }>): void {
    const call = this.calls.get(message.id)
    if (!call) return
    this.calls.delete(message.id)
    call.stopDeadline()
    if (message.reply.ok) call.resolve(message.reply)
    else call.reject(new DOMException(message.reply.message, message.reply.error))
  }

  private dropCall(id: number, error: DOMException): void {
    const call = this.calls.get(id)
    if (!call) return
    this.calls.delete(id)
    call.stopDeadline()
    call.reject(error)
  }

  private followOwner(tab: string): void {
    if (this.owner?.tab !== tab) {
      this.loseOwner()
      this.owner = { tab, unwatch: this.options.coordination.watchTab(tab, () => this.loseOwner()) }
    }
    this.reportBoot("follower")
    this.resumeServing()
  }

  /** What this follower had in flight on the owner runs again on the next owner, which also answers whether a commit it was given landed. */
  private loseOwner(): void {
    const owner = this.owner
    if (!owner) return
    this.owner = null
    owner.unwatch()
    this.unroute()
    this.orphan(owner.tab)
    let commits = 0
    for (const [id, call] of this.calls) {
      if (call.owner !== owner.tab) continue
      if (call.commit) commits++
      this.dropCall(id, call.commit ? outcomeUnknown() : ownerLost())
    }
    if (this.role !== "owner" && this.role !== "starting") {
      reportStorageFailure("owner_lost", { count: commits })
      this.recoveries++
      this.options.database.reportStorageReconnecting(true)
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
    this.serve(request).then(respond, fail)
  }

  /** A follower's request, run on this owner's worker; its own transaction log is the follower's. */
  private serve(request: MirrorRequest): Promise<OkReply> {
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
}

export function createBrowserMirror(database: ThreaDatabase, primary: boolean): SqliteMirror {
  return new SqliteMirror({
    database,
    primary,
    coordination: createBrowserCoordination(database.name, crypto.randomUUID()),
    createTransport: createWorkerTransport,
  })
}
