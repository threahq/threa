import type { DBCore, DBCoreTable, DBCoreTransaction, Middleware } from "dexie"
import { defaultFeatureFlagValue } from "@threahq/types"
import { NO_CAPTURE, getPerfCapture, type PerfCaptureLike } from "@/lib/perf/capture"

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

function trackRequests(table: DBCoreTable, observed: WeakMap<DBCoreTransaction, ObservedTransaction>): DBCoreTable {
  const track =
    <R extends { trans: DBCoreTransaction }, T>(call: (req: R) => Promise<T>) =>
    (req: R): Promise<T> => {
      const result = call(req)
      return observed.has(req.trans) ? result.finally(() => settle(observed, req.trans)) : result
    }
  return {
    ...table,
    mutate: track((req) => table.mutate(req)),
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
 */
export const transactionMiddleware: Middleware<DBCore> = {
  stack: "dbcore",
  name: "threaTransactions",
  create(down) {
    const storeOrder = down.schema.tables.map((table) => table.name).sort()
    const observed = new WeakMap<DBCoreTransaction, ObservedTransaction>()
    return {
      transaction(stores, mode, options) {
        const durability = transactionDurability(stores, mode, relaxedDurability)
        const tx = down.transaction(stores, mode, durability ? { ...options, durability } : options)
        const capture = getPerfCapture()
        if (capture !== NO_CAPTURE) observe(tx, stores, mode, storeOrder, capture, observed)
        return tx
      },
      table(name) {
        return trackRequests(down.table(name), observed)
      },
    }
  },
}
