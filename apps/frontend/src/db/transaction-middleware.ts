import type { DBCore, DBCoreKeyRange, DBCoreTable, DBCoreTransaction, Middleware } from "dexie"
import { defaultFeatureFlagValue } from "@threahq/types"
import { NO_CAPTURE, getPerfCapture, type PerfCaptureLike } from "@/lib/perf/capture"
import { touchedOf } from "./sqlite-mirror/idb-reads"
import {
  SQLITE_MARKS_STORE,
  writerBatch,
  type IdbWriter,
  type SqliteMark,
  type WriterCommit,
} from "./sqlite-mirror/marks"
import { SQLITE_UNMIRRORED_STORES } from "./sqlite-mirror/stores"
import { encodeValue } from "./sqlite-mirror/value-codec"

/**
 * One successful mutation of a store, as it reached IndexedDB. Put values are
 * encoded when the mutation is issued, as IndexedDB clones them then; `null`
 * marks a value the mirror cannot represent.
 */
export type IdbWrite =
  | { store: string; op: "put"; keys: IDBValidKey[]; values: Array<string | null> }
  | { store: string; op: "delete"; keys: IDBValidKey[] }
  | { store: string; op: "deleteRange"; range: DBCoreKeyRange }

/** Receives, in commit order, each committed readwrite transaction that wrote a mirrored store. */
export interface IdbWriteSink {
  commit(commit: WriterCommit, writes: IdbWrite[]): void
}

/** `sink` is read at creation: put values are encoded only for a running mirror. */
interface BufferedWrites {
  sink: IdbWriteSink | null
  seq: number
  marked: Set<string>
  writes: IdbWrite[]
}

/**
 * Stores holding what exists nowhere but this device: unsent messages,
 * operations and doc edits, drafts, queued uploads, device keys, and the
 * cache-ownership claim. A write touching any of them keeps strict durability.
 * Everything else is a server-refillable cache or cosmetic UI state (composer
 * target, collapse toggles), so its writes may confirm before the disk flush.
 */
const DEVICE_ONLY_STORES: ReadonlySet<string> = new Set([
  "pendingMessages",
  "pendingOperations",
  "drafts",
  "draftScratchpads",
  "uploadJobs",
  "docStates",
  "e2eDeviceKeys",
  "cacheOwnership",
])

let relaxedDurability = defaultFeatureFlagValue("idbRelaxedDurability") === "on"

/** Apply the `idbRelaxedDurability` flag; read per transaction, so it takes effect on the next write. */
export function setIdbRelaxedDurability(enabled: boolean): void {
  relaxedDurability = enabled
}

function transactionDurability(
  stores: readonly string[],
  mode: "readonly" | "readwrite",
  relaxed: boolean
): "relaxed" | undefined {
  if (!relaxed || mode !== "readwrite") return undefined
  return stores.some((store) => DEVICE_ONLY_STORES.has(store)) ? undefined : "relaxed"
}

interface ObservedTransaction {
  createdAt: number
  firstSettledAt: number | null
  lastSettledAt: number | null
}

// Shorter transactions are the healthy majority; recording them would evict the stalls from the capture ring.
const MIN_RECORDED_MS = 30

function storeMask(storeOrder: readonly string[], stores: readonly string[]): number {
  let mask = 0
  for (const store of stores) {
    const bit = storeOrder.indexOf(store)
    // Past 52 bits a double can't hold the mask exactly.
    if (bit >= 0 && bit < 53) mask += 2 ** bit
  }
  return mask
}

function observe(
  tx: DBCoreTransaction,
  stores: readonly string[],
  mode: "readonly" | "readwrite",
  storeOrder: readonly string[],
  capture: PerfCaptureLike,
  observed: WeakMap<DBCoreTransaction, ObservedTransaction>
): void {
  const target = tx as unknown as IDBTransaction
  const state: ObservedTransaction = { createdAt: performance.now(), firstSettledAt: null, lastSettledAt: null }
  observed.set(tx, state)
  const finish = (event: Event) => {
    const endedAt = performance.now()
    const lifetime = endedAt - state.createdAt
    if (lifetime < MIN_RECORDED_MS) return
    capture.mark("idb.txStores", storeMask(storeOrder, stores))
    if (mode === "readwrite") {
      capture.mark("idb.writeTx", lifetime)
      if (event.type === "complete" && state.lastSettledAt !== null)
        capture.mark("idb.writeTxCommit", endedAt - state.lastSettledAt)
    } else {
      capture.mark("idb.readTx", lifetime)
      if (state.firstSettledAt !== null) capture.mark("idb.readTxWait", state.firstSettledAt - state.createdAt)
    }
  }
  target.addEventListener("complete", finish, { once: true })
  target.addEventListener("abort", finish, { once: true })
}

function settle(observed: WeakMap<DBCoreTransaction, ObservedTransaction>, tx: DBCoreTransaction): void {
  const state = observed.get(tx)
  if (!state) return
  const at = performance.now()
  state.firstSettledAt ??= at
  state.lastSettledAt = at
}

function isMirrored(store: string): boolean {
  return !SQLITE_UNMIRRORED_STORES.has(store)
}

function bufferWrites(
  tx: DBCoreTransaction,
  writer: IdbWriter,
  sink: IdbWriteSink | null,
  buffers: WeakMap<DBCoreTransaction, BufferedWrites>
): void {
  const buffer: BufferedWrites = { sink, seq: writer.nextSeq(), marked: new Set(), writes: [] }
  buffers.set(tx, buffer)
  const target = tx as unknown as IDBTransaction
  target.addEventListener(
    "complete",
    () => {
      if (buffer.marked.size === 0) return
      const commit = writer.committed(buffer.seq, buffer.marked)
      if (sink) sink.commit(commit, buffer.writes)
      else writer.announce(writerBatch(commit, buffer.writes.map(touchedOf)))
    },
    { once: true }
  )
}

function abortTransaction(tx: DBCoreTransaction): void {
  try {
    ;(tx as unknown as IDBTransaction).abort()
  } catch {
    // Already finished: then the mark committed or nothing did.
  }
}

function tryEncode(value: unknown): string | null {
  try {
    return encodeValue(value)
  } catch {
    return null
  }
}

function recordWrite(
  store: string,
  req: Parameters<DBCoreTable["mutate"]>[0],
  encoded: Array<string | null>,
  res: Awaited<ReturnType<DBCoreTable["mutate"]>>,
  writes: IdbWrite[]
): void {
  if (req.type === "add" || req.type === "put") {
    const keys: IDBValidKey[] = []
    const values: Array<string | null> = []
    req.values.forEach((_, index) => {
      if (res.failures[index]) return
      keys.push(res.results?.[index])
      values.push(encoded[index] ?? null)
    })
    if (keys.length > 0) writes.push({ store, op: "put", keys, values })
  } else if (req.type === "delete") {
    writes.push({ store, op: "delete", keys: req.keys })
  } else {
    writes.push({ store, op: "deleteRange", range: req.range })
  }
}

function trackRequests(
  table: DBCoreTable,
  marks: DBCoreTable | null,
  writer: IdbWriter,
  observed: WeakMap<DBCoreTransaction, ObservedTransaction>,
  buffers: WeakMap<DBCoreTransaction, BufferedWrites>
): DBCoreTable {
  const track =
    <R extends { trans: DBCoreTransaction }, T>(call: (req: R) => Promise<T>) =>
    (req: R): Promise<T> => {
      const result = call(req)
      return observed.has(req.trans) ? result.finally(() => settle(observed, req.trans)) : result
    }
  const mutate = track((req: Parameters<DBCoreTable["mutate"]>[0]) => table.mutate(req))
  const store = table.name
  const mirrored = isMirrored(store)
  return {
    ...table,
    mutate: (req) => {
      const buffer = mirrored && marks ? buffers.get(req.trans) : undefined
      if (!buffer || !marks) return mutate(req)
      if (!buffer.marked.has(store)) {
        buffer.marked.add(store)
        // Issued before the write it covers; without it the write must not commit.
        const mark: SqliteMark = { store, writer: writer.id, seq: buffer.seq }
        marks.mutate({ type: "put", trans: req.trans, values: [mark] }).then(
          (res) => res.numFailures > 0 && abortTransaction(req.trans),
          () => abortTransaction(req.trans)
        )
      }
      const encoded = buffer.sink && (req.type === "add" || req.type === "put") ? req.values.map(tryEncode) : []
      return mutate(req).then((res) => {
        recordWrite(store, req, encoded, res, buffer.writes)
        return res
      })
    },
    get: track((req) => table.get(req)),
    getMany: track((req) => table.getMany(req)),
    query: track((req) => table.query(req)),
    openCursor: track((req) => table.openCursor(req)),
    count: track((req) => table.count(req)),
  }
}

/**
 * Sets per-transaction durability and, while a perf capture is armed, records
 * slow transactions: lifetime, a write's commit after its last request (the
 * disk flush), a read's wait for its first result, and a bitmask of its stores
 * (bit = index in the schema's store names, sorted).
 *
 * Each readwrite transaction over a mirrored store also takes the marks store
 * and marks each mirrored store it writes. Once it commits, its successful
 * mutations go to `currentSink` (read per transaction, as the table core is
 * cached at open) or, with no mirror running, are announced to whichever tab
 * owns one; an aborted transaction hands over nothing.
 */
export function createTransactionMiddleware(
  currentSink: () => IdbWriteSink | null,
  writer: IdbWriter
): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "threaTransactions",
    create(down) {
      const storeOrder = down.schema.tables.map((table) => table.name).sort()
      const observed = new WeakMap<DBCoreTransaction, ObservedTransaction>()
      const buffers = new WeakMap<DBCoreTransaction, BufferedWrites>()
      // Absent only from the cores Dexie builds for an upgrade, whose writes run in the versionchange transaction.
      const marks = down.schema.tables.some((table) => table.name === SQLITE_MARKS_STORE)
        ? down.table(SQLITE_MARKS_STORE)
        : null
      return {
        transaction(stores, mode, options) {
          const durability = transactionDurability(stores, mode, relaxedDurability)
          const marking = marks !== null && mode === "readwrite" && stores.some(isMirrored)
          const scope = marking ? [...stores, SQLITE_MARKS_STORE] : stores
          const tx = down.transaction(scope, mode, durability ? { ...options, durability } : options)
          const capture = getPerfCapture()
          if (capture !== NO_CAPTURE) observe(tx, stores, mode, storeOrder, capture, observed)
          if (marking) bufferWrites(tx, writer, currentSink(), buffers)
          return tx
        },
        table(name) {
          return trackRequests(down.table(name), marks, writer, observed, buffers)
        },
      }
    },
  }
}
