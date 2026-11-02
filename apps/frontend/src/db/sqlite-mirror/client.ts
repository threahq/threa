import type { IndexableType } from "dexie"
import type { ThreaDatabase } from "../database"
import type { IdbWrite, IdbWriteSink } from "../transaction-middleware"
import { getPerfCapture } from "@/lib/perf/capture"
import { encodeKey, encodeRange } from "./key-codec"
import type { MirrorEntry, MirrorMutation } from "./mirror-store"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import { SQLITE_UNMIRRORED_STORES } from "./stores"
import { encodeValue } from "./value-codec"
import { createWorkerTransport } from "./worker-transport"

const BACKFILL_CHUNK_ROWS = 500
const MIN_RECORDED_APPLY_MS = 30

/** Decides which tab owns the SQLite file, and carries other tabs' batches to it. */
export interface MirrorCoordination {
  /** Reports ownership: `false` at once when another tab holds it, then `true` when it is handed to this tab. */
  claim(onChange: (owner: boolean) => void): void
  release(): void
  broadcast(batch: MirrorMutation[]): void
  onBroadcast(listener: (batch: MirrorMutation[]) => void): () => void
}

export function createBrowserCoordination(idbName: string): MirrorCoordination {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("Web Locks API is unavailable")
  if (typeof BroadcastChannel === "undefined") throw new Error("BroadcastChannel is unavailable")
  const name = `threa-sqlite-mirror:${idbName}`
  const channel = new BroadcastChannel(name)
  let releaseLock: (() => void) | null = null
  let released = false

  const hold = (onChange: (owner: boolean) => void) => () =>
    new Promise<void>((resolve) => {
      if (released) return resolve()
      releaseLock = resolve
      onChange(true)
    })

  return {
    claim(onChange) {
      void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
        if (lock) return hold(onChange)()
        onChange(false)
        return navigator.locks.request(name, hold(onChange))
      })
    },
    release() {
      released = true
      releaseLock?.()
      channel.close()
    },
    broadcast: (batch) => channel.postMessage(batch),
    onBroadcast(listener) {
      const handle = (event: MessageEvent<MirrorMutation[]>) => listener(event.data)
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function markFailure(error: unknown): void {
  getPerfCapture().count("sqlite.mirrorFailure")
  console.error("SQLite mirror failure", error)
}

function encodeEntries(keys: IDBValidKey[], values: unknown[]): MirrorEntry[] {
  const entries: MirrorEntry[] = []
  keys.forEach((key, index) => {
    try {
      entries.push({ key: encodeKey(key), value: encodeValue(values[index]) })
    } catch (error) {
      markFailure(error)
    }
  })
  return entries
}

function encodeWrites(writes: readonly IdbWrite[]): MirrorMutation[] {
  const batch: MirrorMutation[] = []
  for (const write of writes) {
    try {
      if (write.op === "put") {
        batch.push({ store: write.store, op: "put", entries: encodeEntries(write.keys, write.values) })
      } else if (write.op === "delete") {
        batch.push({ store: write.store, op: "delete", keys: write.keys.map(encodeKey) })
      } else {
        batch.push({ store: write.store, op: "deleteRange", range: encodeRange(write.range) })
      }
    } catch (error) {
      markFailure(error)
    }
  }
  return batch
}

/**
 * Copies committed IndexedDB writes of one database into SQLite. One tab per
 * database owns the worker; the others broadcast their batches to it.
 */
export class SqliteMirror implements IdbWriteSink {
  private role: Role = "idle"
  private transport: MirrorTransport | null = null
  private buffered: MirrorMutation[][] = []
  private stopListening: (() => void) | null = null
  private wasFollower = false

  constructor(private readonly options: SqliteMirrorOptions) {}

  start(): void {
    if (this.role !== "idle") return
    this.role = "pending"
    const { coordination } = this.options
    this.stopListening = coordination.onBroadcast((batch) => this.route(batch, false))
    coordination.claim((owner) => {
      if (this.role === "stopped") return
      if (owner) void this.becomeOwner()
      else {
        this.wasFollower = true
        this.role = "follower"
      }
    })
  }

  commit(writes: IdbWrite[]): void {
    const batch = encodeWrites(writes)
    if (batch.length > 0) this.route(batch, true)
  }

  async stop({ destroy }: { destroy: boolean }): Promise<void> {
    const wasOwner = this.role === "owner"
    this.role = "stopped"
    this.stopListening?.()
    this.buffered = []
    const transport = this.transport
    this.transport = null
    if (transport && wasOwner) {
      await transport.request({ type: destroy ? "destroy" : "close" }).catch(markFailure)
    }
    transport?.close()
    this.options.coordination.release()
  }

  private isStopped(): boolean {
    return this.role === "stopped"
  }

  private route(batch: MirrorMutation[], local: boolean): void {
    if (this.role === "owner") void this.send({ type: "apply", batch })
    else if (this.role === "pending" || this.role === "starting") this.buffered.push(batch)
    else if (this.role === "follower" && local) this.options.coordination.broadcast(batch)
  }

  private async send(request: MirrorRequest): Promise<MirrorReply | null> {
    const transport = this.transport
    if (!transport) return null
    let reply: MirrorReply
    try {
      reply = await transport.request(request)
    } catch (error) {
      if (this.transport === transport) markFailure(error)
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

  private async becomeOwner(): Promise<void> {
    const { database, createTransport } = this.options
    const handedOver = this.wasFollower
    this.role = "starting"
    const capture = getPerfCapture()
    const openedAt = performance.now()
    try {
      await database.open()
      const stores = database.tables.map((table) => table.name).filter((name) => !SQLITE_UNMIRRORED_STORES.has(name))
      this.transport = createTransport()
      const opened = await this.send({ type: "open", idbName: database.name, stores, idbVersion: database.verno })
      if (!opened) throw new Error("SQLite mirror could not open its database")
      if (this.isStopped()) return
      capture.mark("sqlite.open", performance.now() - openedAt)
      this.role = "owner"
      for (const batch of this.buffered) void this.send({ type: "apply", batch })
      this.buffered = []
      // A tab that inherited ownership missed its predecessor's followers' writes, so nothing is trusted.
      const status = await this.send({ type: "status" })
      const trusted = handedOver ? [] : (status?.ok && status.backfilled) || []
      await this.backfill(stores.filter((store) => !trusted.includes(store)))
    } catch (error) {
      if (!this.isStopped()) {
        this.role = "failed"
        this.buffered = []
        markFailure(error)
      }
    }
  }

  private async backfill(stores: string[]): Promise<void> {
    const capture = getPerfCapture()
    const startedAt = performance.now()
    for (const store of stores) {
      const storeStartedAt = performance.now()
      if (!(await this.backfillStore(store))) return
      capture.mark("sqlite.backfillStore", performance.now() - storeStartedAt)
    }
    capture.mark("sqlite.backfillDone", performance.now() - startedAt)
  }

  private async backfillStore(store: string): Promise<boolean> {
    const { database } = this.options
    const table = database.table(store)
    if (!(await this.send({ type: "backfillBegin", store }))) return false
    let last: IDBValidKey | undefined
    for (;;) {
      const rows = await database.transaction("r", table, async () => {
        const collection = last === undefined ? table.toCollection() : table.where(":id").above(last)
        const keys = (await collection.limit(BACKFILL_CHUNK_ROWS).primaryKeys()) as IDBValidKey[]
        return { keys, values: await table.bulkGet(keys as IndexableType[]) }
      })
      if (this.role !== "owner") return false
      if (rows.keys.length === 0) break
      const entries = encodeEntries(rows.keys, rows.values)
      if (!(await this.send({ type: "backfillChunk", store, entries }))) return false
      last = rows.keys[rows.keys.length - 1]
      await yieldToEventLoop()
      if (this.role !== "owner") return false
    }
    return (await this.send({ type: "backfillFinish", store })) !== null
  }
}

export function createBrowserMirror(database: ThreaDatabase): SqliteMirror {
  return new SqliteMirror({
    database,
    coordination: createBrowserCoordination(database.name),
    createTransport: createWorkerTransport,
  })
}
