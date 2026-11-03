import type { Database } from "@sqlite.org/sqlite-wasm"
import { MirrorStore, type MirrorStatus } from "./mirror-store"
import type { MirrorReadResults, MirrorReply, MirrorRequest } from "./protocol"

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

/** Runs requests against one mirror database, strictly one at a time in arrival order. */
export function createMirrorHandler(openDatabase: (idbName: string) => Promise<MirrorDatabase>) {
  let session: Session | null = null
  let tail: Promise<unknown> = Promise.resolve()

  function requireSession(): Session {
    if (!session) throw new Error("Mirror database is not open")
    return session
  }

  async function run(
    request: MirrorRequest
  ): Promise<{ status?: MirrorStatus; result?: MirrorReadResults[keyof MirrorReadResults] }> {
    if (request.type === "open") {
      session?.database.close()
      session = null
      const database = await openDatabase(request.idbName)
      const store = new MirrorStore(database.db)
      store.ensureSchema(request.schema, request.idbVersion)
      session = { database, store }
      return {}
    }
    if (request.type === "destroy") {
      const database = session?.database ?? (await openDatabase(request.idbName))
      session = null
      await database.destroy()
      return {}
    }
    const { store } = requireSession()
    switch (request.type) {
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
      const failure = error instanceof Error ? error : new Error(String(error))
      return { ok: false, error: failure.name, message: failure.message }
    }
  }

  return {
    /** `onStart` runs as the request begins, so the caller can tell a busy worker from a dead one. */
    handle(request: MirrorRequest, onStart: () => void = () => {}): Promise<MirrorReply> {
      const reply = tail.then(() => timed(request, onStart))
      tail = reply
      return reply
    },
  }
}
