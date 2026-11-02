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
  strict: boolean
  writes: MirrorMutation[]
}

type Begin = Extract<MirrorRequest, { type: "begin" }>

/**
 * Runs requests against one mirror database, one at a time in arrival order.
 * Transactions are admitted in `begin` order as IndexedDB orders overlapping
 * ones: readonly ones together, a readwrite one alone, holding the single
 * connection from `begin` to its commit or rollback. Requests of transactions
 * not yet admitted wait, and so does everything outside any while a readwrite
 * one runs.
 */
export function createMirrorHandler(openDatabase: (idbName: string) => Promise<MirrorDatabase>) {
  let session: Session | null = null
  let tail: Promise<unknown> = Promise.resolve()
  // Admission happens when a request arrives, not when it runs, so the requests queued behind it are judged against it.
  const admitted = new Map<number, Transaction>()
  let writer: number | null = null
  const queued: Array<{ begin: Begin; release: () => void }> = []
  const held: Array<() => void> = []

  function requireSession(): Session {
    if (!session) throw new Error("Mirror database is not open")
    return session
  }

  function requireActive(tx: number): Transaction {
    const transaction = admitted.get(tx)
    if (!transaction) throw new DOMException(`Transaction ${tx} is not active`, "TransactionInactiveError")
    return transaction
  }

  function admissible(begin: Begin): boolean {
    return writer === null && (begin.readonly || admitted.size === 0)
  }

  function admit(begin: Begin): void {
    admitted.set(begin.tx, { id: begin.tx, readonly: begin.readonly, strict: begin.strict, writes: [] })
    if (!begin.readonly) writer = begin.tx
  }

  function end(db: Database | undefined, transaction: Transaction): void {
    admitted.delete(transaction.id)
    if (writer === transaction.id) writer = null
    if (transaction.strict) db?.exec("PRAGMA synchronous=NORMAL")
    while (queued.length > 0 && admissible(queued[0].begin)) {
      const next = queued.shift()!
      admit(next.begin)
      next.release()
    }
    for (const release of held.splice(0)) release()
  }

  async function run(request: MirrorRequest): Promise<ReplyData> {
    if (request.type === "open") {
      session?.database.close()
      session = null
      const database = await openDatabase(request.idbName)
      const store = new MirrorStore(database.db)
      store.ensureSchema(request.schema, request.idbVersion)
      session = { database, store }
      return { backlog: backlogSize(database.db) }
    }
    if (request.type === "destroy") {
      const database = session?.database ?? (await openDatabase(request.idbName))
      session = null
      const pending = backlogSize(database.db)
      if (pending > 0) {
        database.close()
        throw new Error(`${pending} committed transactions have not reached IndexedDB yet`)
      }
      await database.destroy()
      return {}
    }
    const { store, database } = requireSession()
    switch (request.type) {
      case "begin": {
        const tx = requireActive(request.tx)
        if (tx.readonly) return {}
        try {
          if (tx.strict) database.db.exec("PRAGMA synchronous=FULL")
          database.db.exec("BEGIN IMMEDIATE")
        } catch (error) {
          end(database.db, tx)
          throw error
        }
        return {}
      }
      case "write": {
        const tx = requireActive(request.tx)
        if (tx.readonly) throw new DOMException("The transaction is read-only", "ReadOnlyError")
        const { failures, applied } = store.write(request.write)
        tx.writes.push(applied)
        return { failures }
      }
      case "commit": {
        const tx = requireActive(request.tx)
        if (tx.readonly) {
          end(database.db, tx)
          return {}
        }
        try {
          if (tx.writes.length > 0) store.appendBacklog(tx.writes)
          database.db.exec("COMMIT")
        } catch (error) {
          try {
            database.db.exec("ROLLBACK")
          } catch {
            // The failed COMMIT already rolled the transaction back.
          }
          throw error
        } finally {
          end(database.db, tx)
        }
        return {}
      }
      case "rollback": {
        const tx = requireActive(request.tx)
        try {
          if (!tx.readonly) database.db.exec("ROLLBACK")
        } finally {
          end(database.db, tx)
        }
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
      case "reset":
        store.reset(request.incarnation)
        return {}
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
      // A transaction whose begin or end failed before reaching SQLite must not hold the others back.
      const ends = request.type === "begin" || request.type === "commit" || request.type === "rollback"
      const stuck = ends ? admitted.get(request.tx) : undefined
      if (stuck) end(session?.database.db, stuck)
      const failure = error instanceof Error ? error : new Error(String(error))
      return { ok: false, error: failure.name, message: failure.message }
    }
  }

  /** `onStart` runs as the request begins, so the caller can tell a busy worker from a dead one. */
  function handle(request: MirrorRequest, onStart: () => void = () => {}): Promise<MirrorReply> {
    if (request.type === "begin") {
      if (queued.length > 0 || !admissible(request)) {
        return new Promise((resolve) =>
          queued.push({ begin: request, release: () => resolve(dispatch(request, onStart)) })
        )
      }
      admit(request)
      return dispatch(request, onStart)
    }
    const tx = txOf(request)
    const waits = tx === undefined ? writer !== null : queued.some(({ begin }) => begin.tx === tx)
    if (waits) return new Promise((resolve) => held.push(() => resolve(handle(request, onStart))))
    return dispatch(request, onStart)
  }

  function dispatch(request: MirrorRequest, onStart: () => void): Promise<MirrorReply> {
    const reply = tail.then(() => timed(request, onStart))
    tail = reply
    return reply
  }

  return { handle }
}
