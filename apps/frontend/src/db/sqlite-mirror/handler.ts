import type { Database } from "@sqlite.org/sqlite-wasm"
import { MirrorStore } from "./mirror-store"
import type { MirrorReply, MirrorRequest } from "./protocol"

export interface MirrorDatabase {
  db: Database
  close(): void
  /** Closes the database and deletes its file. */
  destroy(): void
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

  async function run(request: MirrorRequest): Promise<{ backfilled?: string[] }> {
    if (request.type === "open") {
      session?.database.close()
      session = null
      const database = await openDatabase(request.idbName)
      const store = new MirrorStore(database.db)
      store.ensureSchema(request.stores, request.idbVersion)
      session = { database, store }
      return {}
    }
    const { database, store } = requireSession()
    switch (request.type) {
      case "apply":
        store.apply(request.batch)
        return {}
      case "backfillBegin":
        store.beginBackfill(request.store)
        return {}
      case "backfillChunk":
        store.backfillChunk(request.store, request.entries)
        return {}
      case "backfillFinish":
        store.finishBackfill(request.store)
        return {}
      case "status":
        return { backfilled: store.backfilledStores() }
      case "close":
        database.close()
        session = null
        return {}
      case "destroy":
        database.destroy()
        session = null
        return {}
    }
  }

  async function timed(request: MirrorRequest): Promise<MirrorReply> {
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
    handle(request: MirrorRequest): Promise<MirrorReply> {
      const reply = tail.then(() => timed(request))
      tail = reply
      return reply
    },
  }
}
