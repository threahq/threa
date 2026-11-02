import type { ThreaDatabase } from "../database"
import type { IdbWrite, IdbWriteSink } from "../transaction-middleware"
import { getPerfCapture } from "@/lib/perf/capture"
import { DirtyJournal } from "./dirty-journal"
import { readChunk, readTouched, type Touched, type TouchedRows } from "./idb-reads"
import { encodeKey, encodeRange } from "./key-codec"
import type { MirrorEntry, MirrorMutation } from "./mirror-store"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { SQLITE_UNMIRRORED_STORES } from "./stores"
import { encodeValue } from "./value-codec"
import { createWorkerTransport } from "./worker-transport"

const BACKFILL_CHUNK_ROWS = 500
const MIN_RECORDED_APPLY_MS = 30

/** A follower's committed writes, and the owner's acknowledgement once SQLite holds them. */
export type MirrorBroadcast =
  | { type: "batch"; from: string; id: number; touched: Touched[] }
  | { type: "ack"; to: string; id: number }

type RemoteBatch = Extract<MirrorBroadcast, { type: "batch" }>

/** Decides which tab owns the SQLite file, and carries other tabs' batches to it. */
export interface MirrorCoordination {
  /** Reports ownership: `false` at once when another tab holds it, then `true` when it is handed to this tab. */
  claim(onChange: (owner: boolean) => void): void
  /** Gives up ownership, or the queued claim for it, so another tab can own the file; the channel stays open. */
  resign(): void
  close(): void
  broadcast(message: MirrorBroadcast): void
  onBroadcast(listener: (message: MirrorBroadcast) => void): () => void
}

export function createBrowserCoordination(idbName: string): MirrorCoordination {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Web Locks API is unavailable")
  if (typeof BroadcastChannel === "undefined") throw new Error("BroadcastChannel is unavailable")
  const name = `threa-sqlite-mirror:${idbName}`
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
  journalId: number
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

function touchedOf(write: IdbWrite): Touched {
  return write.op === "deleteRange"
    ? { store: write.store, range: write.range }
    : { store: write.store, keys: write.keys }
}

/**
 * Copies committed IndexedDB writes of one database into SQLite. One tab per
 * database owns the worker; the others broadcast what their writes touched,
 * and the owner copies those rows from IndexedDB as they stand when it reads.
 */
export class SqliteMirror implements IdbWriteSink {
  private role: Role = "idle"
  private transport: MirrorTransport | null = null
  private localPending: LocalCommit[] = []
  private remotePending: RemoteBatch[] = []
  private stopListening: (() => void) | null = null
  private starting: Promise<void> | null = null
  private wasFollower = false
  private readonly journal: DirtyJournal

  constructor(private readonly options: SqliteMirrorOptions) {
    this.journal = new DirtyJournal(options.database.name, crypto.randomUUID())
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

  commit(writes: IdbWrite[]): void {
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
    this.routeLocal({ batch, touched: writes.map(touchedOf), journalId: this.journal.begin() })
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
    } else {
      this.journal.markLost()
    }
    transport?.close()
    this.options.coordination.close()
  }

  private isStopped(): boolean {
    return this.role === "stopped"
  }

  private becomeFollower(): void {
    this.wasFollower = true
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
        this.journal.markLost()
    }
  }

  private applyOwn(local: LocalCommit): void {
    void this.send({ type: "apply", batch: local.batch }).then((reply) => {
      if (reply) this.journal.end(local.journalId)
      else
        this.lose(
          local.batch.map((mutation) => mutation.store),
          new Error("SQLite mirror apply failed")
        )
    })
  }

  private broadcastLocal(local: LocalCommit): void {
    this.options.coordination.broadcast({
      type: "batch",
      from: this.journal.tabId,
      id: local.journalId,
      touched: local.touched,
    })
  }

  private receive(message: MirrorBroadcast): void {
    if (message.type === "ack") {
      if (message.to === this.journal.tabId) this.journal.end(message.id)
    } else if (this.role === "owner") {
      this.applyRemote(message)
    } else if (this.role === "pending" || this.role === "starting") {
      this.remotePending.push(message)
    }
  }

  /**
   * A follower's batch can arrive before or after this tab's own commit to the
   * same keys, so the follower's values are never applied: the touched rows are
   * re-read from IndexedDB and their current state is what SQLite receives.
   */
  private applyRemote(message: RemoteBatch): void {
    const stores = message.touched.map((touched) => touched.store)
    readTouched(this.options.database.backendDB(), message.touched, (rows) => {
      void this.send({ type: "apply", batch: this.mutationsFor(rows) }).then((reply) => {
        if (reply) this.options.coordination.broadcast({ type: "ack", to: message.from, id: message.id })
        else this.lose(stores, new Error("SQLite mirror apply failed"))
      })
    }).catch((error: unknown) => this.lose(stores, error))
  }

  private mutationsFor(rows: readonly TouchedRows[]): MirrorMutation[] {
    const batch: MirrorMutation[] = []
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
    return batch
  }

  /** SQLite may be missing writes to these stores; the next owner re-backfills every store. */
  private lose(stores: readonly string[], error: unknown): void {
    markFailure(new Error(`Lost writes to ${[...new Set(stores)].join(", ")}`, { cause: error }))
    this.journal.markLost()
  }

  private async send(request: MirrorRequest): Promise<MirrorReply | null> {
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
   * broadcasting this tab's writes to it. Applies that were in flight never
   * get acknowledged, so the journal keeps them marked as possibly lost.
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
    const handedOver = this.wasFollower
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
      for (const local of this.localPending) this.applyOwn(local)
      for (const remote of this.remotePending) this.applyRemote(remote)
      this.localPending = []
      this.remotePending = []
      const status = await this.send({ type: "status" })
      if (this.role !== "owner") return
      if (!status) throw new Error("SQLite mirror could not report its status")
      // An inherited or journaled-dirty file may lack writes nobody can name, so nothing in it is trusted.
      const stale = this.journal.staleKeys()
      const trusted = handedOver || stale.length > 0 ? [] : (status.ok && status.backfilled) || []
      if (await this.backfill(stores.filter((store) => !trusted.includes(store)))) this.journal.clear(stale)
    } catch (error) {
      if (!this.isStopped()) this.fail(error)
    }
  }

  /** False when interrupted: a store left unbegun may still carry a stale backfilled flag. */
  private async backfill(stores: string[]): Promise<boolean> {
    const capture = getPerfCapture()
    const startedAt = performance.now()
    for (const store of stores) {
      const storeStartedAt = performance.now()
      const outcome = await this.backfillStore(store)
      if (outcome === "interrupted") return false
      if (outcome === "done") capture.mark("sqlite.backfillStore", performance.now() - storeStartedAt)
    }
    capture.mark("sqlite.backfillDone", performance.now() - startedAt)
    return true
  }

  private async backfillStore(store: string): Promise<"done" | "unmirrorable" | "interrupted"> {
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
    return (await this.send({ type: "backfillFinish", store })) ? "done" : "interrupted"
  }
}

export function createBrowserMirror(database: ThreaDatabase): SqliteMirror {
  return new SqliteMirror({
    database,
    coordination: createBrowserCoordination(database.name),
    createTransport: createWorkerTransport,
  })
}
