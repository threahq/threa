import type { Database } from "@sqlite.org/sqlite-wasm"
import { MirrorStore, backlogSize, type MirrorMutation } from "./mirror-store"
import type { MirrorReply, MirrorRequest } from "./protocol"
import { txOf } from "./protocol"

export interface MirrorDatabase {
  db: Database
  close(): void
  /** Closes the database and deletes its storage. */
  destroy(): Promise<void>
}

interface Session {
  database: MirrorDatabase
  store: MirrorStore
}

type ReplyData = Omit<Extract<MirrorReply, { ok: true }>, "ok" | "ms">

interface Transaction {
  id: number
  readonly: boolean
  writes: MirrorMutation[]
  /** Set once a write failed: SQLite may have rolled the transaction back, so nothing after may write or commit. */
  failed: DOMException | null
  idle?: ReturnType<typeof setTimeout>
}

type Begin = Extract<MirrorRequest, { type: "begin" }>

/** A transaction's `begin`, or a request outside any; `readonly: false` outside one waits for every admitted transaction. */
interface Waiting {
  begin?: Begin
  readonly: boolean
  release: () => void
}

/** Requests outside a transaction that change what a transaction reads, or end the backlog's drain: they wait for every admitted one. */
const WRITES_OUTSIDE: ReadonlySet<MirrorRequest["type"]> = new Set([
  "apply",
  "backfillBegin",
  "backfillChunk",
  "backfillFinish",
  "reset",
  "forgetWriters",
  "backlog",
])

/** Under the owner's 30 s worker deadline, so a frozen tab's transaction ends before the owner presumes its worker dead. */
const DEFAULT_TX_IDLE_MS = 10_000
/** Expired transactions remembered; one older than these is reported as merely inactive. */
const MAX_EXPIRED = 64

/** Nothing drops what IndexedDB lacks of SQLite's committed transactions. */
function unlandedBacklog(db: Database): Error | null {
  const pending = backlogSize(db)
  return pending > 0 ? new Error(`${pending} committed transactions have not reached IndexedDB yet`) : null
}

function rollBack(db: Database): void {
  try {
    db.exec("ROLLBACK")
  } catch {
    // SQLite already rolled the transaction back.
  }
}

/**
 * Runs requests against one mirror database, one at a time in arrival order.
 * Transactions are admitted in `begin` order as IndexedDB orders overlapping
 * ones: readonly ones together, a readwrite one alone, holding the single
 * connection from `begin` to its commit or rollback. Requests of transactions
 * not yet admitted wait; reads outside any wait while a readwrite one runs,
 * and writes outside any while any runs. A transaction with no request for
 * `txIdleMs` is rolled back, so a frozen tab cannot hold the others forever.
 */
export function createMirrorHandler(
  openDatabase: (idbName: string) => Promise<MirrorDatabase>,
  { txIdleMs = DEFAULT_TX_IDLE_MS }: { txIdleMs?: number } = {}
) {
  let session: Session | null = null
  let tail: Promise<unknown> = Promise.resolve()
  // Admission happens when a request arrives, not when it runs, so the requests queued behind it are judged against it.
  const admitted = new Map<number, Transaction>()
  /** Transactions this handler ended itself, and why, for the requests that still name them. */
  const expired = new Map<number, DOMException>()
  let writer: number | null = null
  const queued: Waiting[] = []
  const held: Array<() => void> = []

  function requireSession(): Session {
    if (!session) throw new Error("Mirror database is not open")
    return session
  }

  function requireActive(tx: number): Transaction {
    const transaction = admitted.get(tx)
    if (transaction) return transaction
    throw expired.get(tx) ?? new DOMException(`Transaction ${tx} is not active`, "TransactionInactiveError")
  }

  function admissible(readonly: boolean): boolean {
    return writer === null && (readonly || admitted.size === 0)
  }

  function admit(begin: Begin): void {
    admitted.set(begin.tx, { id: begin.tx, readonly: begin.readonly, writes: [], failed: null })
    if (!begin.readonly) writer = begin.tx
  }

  function end(transaction: Transaction): void {
    clearTimeout(transaction.idle)
    admitted.delete(transaction.id)
    if (writer === transaction.id) writer = null
    while (queued.length > 0 && admissible(queued[0].readonly)) {
      const next = queued.shift()!
      if (next.begin) admit(next.begin)
      next.release()
    }
    for (const release of held.splice(0)) release()
  }

  function expire(transaction: Transaction): void {
    if (admitted.get(transaction.id) !== transaction) return
    if (!transaction.readonly && !transaction.failed && session) rollBack(session.database.db)
    const message = `Transaction ${transaction.id} was rolled back after ${txIdleMs} ms without a request`
    console.error(`SQLite storage: ${message}`)
    expired.set(transaction.id, new DOMException(message, "AbortError"))
    if (expired.size > MAX_EXPIRED) expired.delete(expired.keys().next().value!)
    end(transaction)
  }

  async function run(request: MirrorRequest): Promise<ReplyData> {
    if (request.type === "open") {
      session?.database.close()
      session = null
      const database = await openDatabase(request.idbName)
      // The pool VFS has no shared memory, so SQLite keeps its rollback journal; NORMAL there can corrupt the file on power loss.
      database.db.exec("PRAGMA synchronous=FULL")
      const store = new MirrorStore(database.db)
      store.ensureSchema(request.schema, request.idbVersion)
      session = { database, store }
      return { backlog: backlogSize(database.db) }
    }
    if (request.type === "destroy") {
      const database = session?.database ?? (await openDatabase(request.idbName))
      session = null
      const unlanded = unlandedBacklog(database.db)
      if (unlanded) {
        database.close()
        throw unlanded
      }
      await database.destroy()
      return {}
    }
    const { store, database } = requireSession()
    switch (request.type) {
      case "begin": {
        const tx = requireActive(request.tx)
        if (!tx.readonly) database.db.exec("BEGIN IMMEDIATE")
        return {}
      }
      case "write": {
        const tx = requireActive(request.tx)
        if (tx.readonly) throw new DOMException("The transaction is read-only", "ReadOnlyError")
        if (tx.failed) throw tx.failed
        try {
          const { failures, applied } = store.write(request.write)
          tx.writes.push(applied)
          return { failures }
        } catch (error) {
          tx.failed = new DOMException(
            `Transaction ${tx.id} was rolled back after a failed write: ${error}`,
            "AbortError"
          )
          rollBack(database.db)
          throw error
        }
      }
      case "commit": {
        const tx = requireActive(request.tx)
        expired.delete(tx.id)
        if (tx.failed) throw tx.failed
        if (!tx.readonly) {
          try {
            if (tx.writes.length > 0) store.appendBacklog(tx.writes)
            database.db.exec("COMMIT")
          } catch (error) {
            rollBack(database.db)
            throw error
          }
        }
        end(tx)
        return {}
      }
      case "rollback": {
        expired.delete(request.tx)
        const tx = admitted.get(request.tx)
        if (!tx) return {}
        if (!tx.readonly && !tx.failed) rollBack(database.db)
        end(tx)
        return {}
      }
      case "backlog":
        return { batches: store.readBacklog(request.limit) }
      case "backlogDone":
        store.dropBacklog(request.through)
        return {}
      case "apply":
        store.apply(request.batch, request.commit)
        return {}
      case "backfillBegin":
        store.beginBackfill(request.store)
        return {}
      case "backfillChunk":
        store.backfillChunk(request.store, request.entries)
        return {}
      case "backfillFinish":
        store.finishBackfill(request.store, request.covered)
        return {}
      case "status":
        return { status: store.status() }
      case "reset": {
        const unlanded = unlandedBacklog(database.db)
        if (unlanded) throw unlanded
        store.reset(request.incarnation)
        return {}
      }
      case "forgetWriters":
        store.forgetWriters(request.writers)
        return {}
      case "get":
        return { result: store.get(request.store, request.key) }
      case "getMany":
        return { result: store.getMany(request.store, request.keys) }
      case "query":
        return { result: store.query(request.store, request.query) }
      case "count":
        return { result: store.count(request.store, request.index, request.range) }
    }
  }

  async function timed(request: MirrorRequest, onStart: () => void): Promise<MirrorReply> {
    onStart()
    const startedAt = performance.now()
    try {
      const data = await run(request)
      return { ok: true, ms: performance.now() - startedAt, ...data }
    } catch (error) {
      // A transaction whose begin or commit failed must not hold the others back.
      const ends = request.type === "begin" || request.type === "commit"
      const stuck = ends ? admitted.get(request.tx) : undefined
      if (stuck) end(stuck)
      const failure = error instanceof Error ? error : new Error(String(error))
      return { ok: false, error: failure.name, message: failure.message }
    }
  }

  /** `onStart` runs as the request begins, so the caller can tell a busy worker from a dead one. */
  function handle(request: MirrorRequest, onStart: () => void = () => {}): Promise<MirrorReply> {
    const wait = (readonly: boolean, begin?: Begin) =>
      new Promise<MirrorReply>((resolve) =>
        queued.push({ begin, readonly, release: () => resolve(dispatch(request, onStart)) })
      )
    if (request.type === "begin") {
      if (queued.length > 0 || !admissible(request.readonly)) return wait(request.readonly, request)
      admit(request)
      return dispatch(request, onStart)
    }
    const tx = txOf(request)
    if (tx !== undefined) {
      if (queued.some(({ begin }) => begin?.tx === tx)) {
        return new Promise((resolve) => held.push(() => resolve(handle(request, onStart))))
      }
      clearTimeout(admitted.get(tx)?.idle)
      return dispatch(request, onStart)
    }
    if (WRITES_OUTSIDE.has(request.type)) {
      return queued.length > 0 || !admissible(false) ? wait(false) : dispatch(request, onStart)
    }
    // Behind a write outside any transaction that arrived first, so what was asked first is answered first.
    if (queued.some(({ begin }) => !begin)) return wait(true)
    if (writer !== null) return new Promise((resolve) => held.push(() => resolve(handle(request, onStart))))
    return dispatch(request, onStart)
  }

  function dispatch(request: MirrorRequest, onStart: () => void): Promise<MirrorReply> {
    const reply = tail.then(() => timed(request, onStart))
    tail = reply
    const tx = txOf(request)
    if (tx !== undefined) {
      void reply.then(() => {
        const transaction = admitted.get(tx)
        if (!transaction) return
        clearTimeout(transaction.idle)
        transaction.idle = setTimeout(() => {
          tail = tail.then(() => expire(transaction))
        }, txIdleMs)
      })
    }
    return reply
  }

  return { handle }
}
