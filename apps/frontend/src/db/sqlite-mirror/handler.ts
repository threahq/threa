import type { Database } from "@sqlite.org/sqlite-wasm"
import { MirrorStore } from "./mirror-store"
import type { MirrorReply, MirrorRequest } from "./protocol"
import { txOf } from "./protocol"

export interface MirrorDatabase {
  db: Database
  close(): void
}

interface Session {
  database: MirrorDatabase
  store: MirrorStore
}

type ReplyData = Omit<Extract<MirrorReply, { ok: true }>, "ok" | "ms">

interface Transaction extends Scope {
  id: number
  /** Set once a write failed: SQLite may have rolled the transaction back, so nothing after may write or commit. */
  failed: DOMException | null
  idle?: ReturnType<typeof setTimeout>
}

type Begin = Extract<MirrorRequest, { type: "begin" }>

/** What a transaction or a request outside any reads or writes; one outside any reaches every store. */
interface Scope {
  readonly: boolean
  stores: ReadonlySet<string> | null
}

/** A transaction's `begin`, or a request outside any; a write outside one waits for every admitted transaction. */
interface Waiting {
  begin?: Begin
  scope: Scope
  release: () => void
}

/** As IndexedDB orders transactions: two whose stores overlap run in turn unless both are readonly. */
function conflicts(a: Scope, b: Scope): boolean {
  if (a.readonly && b.readonly) return false
  if (a.stores === null || b.stores === null) return true
  for (const store of a.stores) if (b.stores.has(store)) return true
  return false
}

const scopeOf = (begin: Begin): Scope => ({ readonly: begin.readonly, stores: new Set(begin.stores) })
const OUTSIDE_READ: Scope = { readonly: true, stores: null }
const OUTSIDE_WRITE: Scope = { readonly: false, stores: null }

/** Requests outside a transaction that change what a transaction reads: they wait for every admitted one. */
const WRITES_OUTSIDE: ReadonlySet<MirrorRequest["type"]> = new Set(["backfillBegin", "backfillChunk", "backfillFinish"])

/** Under the owner's 30 s worker deadline, so a frozen tab's transaction ends before the owner presumes its worker dead. */
const DEFAULT_TX_IDLE_MS = 10_000
/** Expired transactions remembered; one older than these is reported as merely inactive. */
const MAX_EXPIRED = 64

function rollBack(db: Database): void {
  try {
    db.exec("ROLLBACK")
  } catch {
    // SQLite already rolled the transaction back.
  }
}

/**
 * Runs requests against one mirror database, one at a time in arrival order.
 * Transactions are admitted as IndexedDB orders them: one waits for every
 * earlier one whose stores overlap its own unless both are readonly. The single
 * connection holds one readwrite transaction at a time, from `begin` to its
 * commit or rollback, so readwrite ones also run in turn; a readonly one beside
 * it reads only stores it cannot write. Requests of transactions not yet
 * admitted wait; reads outside any wait while a readwrite one runs, and writes
 * outside any while any runs. A transaction with no request for `txIdleMs` is
 * rolled back, so a frozen tab cannot hold the others forever.
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

  /** Whether `candidate` may run now, given what runs and what waits ahead of it; readwrite ones keep their order. */
  function admissible(scope: Scope, ahead: readonly Waiting[]): boolean {
    if (!scope.readonly && writer !== null) return false
    for (const transaction of admitted.values()) if (conflicts(scope, transaction)) return false
    return !ahead.some((waiting) => conflicts(scope, waiting.scope) || (!scope.readonly && !waiting.scope.readonly))
  }

  function admit(begin: Begin, scope: Scope): void {
    admitted.set(begin.tx, { id: begin.tx, ...scope, failed: null })
    if (!begin.readonly) writer = begin.tx
  }

  function end(transaction: Transaction): void {
    clearTimeout(transaction.idle)
    admitted.delete(transaction.id)
    if (writer === transaction.id) writer = null
    for (let i = 0; i < queued.length; ) {
      const next = queued[i]
      if (!admissible(next.scope, queued.slice(0, i))) {
        i++
        continue
      }
      queued.splice(i, 1)
      if (next.begin) admit(next.begin, next.scope)
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

  async function run(request: MirrorRequest, progress: () => void): Promise<ReplyData> {
    if (request.type === "open") {
      session?.database.close()
      session = null
      const database = await openDatabase(request.idbName)
      // The pool VFS has no shared memory, so SQLite keeps its rollback journal; NORMAL there can corrupt the file on power loss.
      database.db.exec("PRAGMA synchronous=FULL")
      const store = new MirrorStore(database.db)
      store.ensureSchema(request.schema, progress)
      session = { database, store }
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
          return { failures: store.write(request.write).failures }
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
            store.recordCommit(request.ledger)
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
      case "committed":
        return { committed: store.committed(request.ledger) }
      case "backfillBegin":
        store.beginBackfill(request.store)
        return {}
      case "backfillChunk":
        store.backfillChunk(request.store, request.entries)
        return {}
      case "backfillFinish":
        store.finishBackfill(request.store)
        return {}
      case "get":
        return { result: store.get(request.store, request.key) }
      case "getMany":
        return { result: store.getMany(request.store, request.keys) }
      case "query":
        return { result: store.query(request.store, request.query) }
      case "count":
        return { result: store.count(request.store, request.index, request.range) }
      default:
        throw new Error(`Unknown mirror request: ${(request as { type: string }).type}`)
    }
  }

  async function timed(request: MirrorRequest, progress: () => void): Promise<MirrorReply> {
    progress()
    const startedAt = performance.now()
    try {
      const data = await run(request, progress)
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

  /** `progress` runs as the request begins and while a long one runs, so the caller can tell a busy worker from a dead one. */
  function handle(request: MirrorRequest, progress: () => void = () => {}): Promise<MirrorReply> {
    const wait = (scope: Scope, begin?: Begin) =>
      new Promise<MirrorReply>((resolve) =>
        queued.push({ begin, scope, release: () => resolve(dispatch(request, progress)) })
      )
    if (request.type === "begin") {
      const scope = scopeOf(request)
      if (!admissible(scope, queued)) return wait(scope, request)
      admit(request, scope)
      return dispatch(request, progress)
    }
    const tx = txOf(request)
    if (tx !== undefined) {
      if (queued.some(({ begin }) => begin?.tx === tx)) {
        return new Promise((resolve) => held.push(() => resolve(handle(request, progress))))
      }
      clearTimeout(admitted.get(tx)?.idle)
      return dispatch(request, progress)
    }
    if (WRITES_OUTSIDE.has(request.type)) {
      return admissible(OUTSIDE_WRITE, queued) ? dispatch(request, progress) : wait(OUTSIDE_WRITE)
    }
    // Behind a write outside any transaction that arrived first, so what was asked first is answered first.
    if (queued.some(({ begin }) => !begin)) return wait(OUTSIDE_READ)
    if (writer !== null) return new Promise((resolve) => held.push(() => resolve(handle(request, progress))))
    return dispatch(request, progress)
  }

  function dispatch(request: MirrorRequest, progress: () => void): Promise<MirrorReply> {
    const reply = tail.then(() => timed(request, progress))
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
