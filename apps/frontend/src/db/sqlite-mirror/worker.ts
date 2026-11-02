import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { createMirrorHandler } from "./handler"
import type { WorkerEnvelope, WorkerResponse } from "./protocol"

const VFS_NAME = "threa-mirror"

const poolReady = sqlite3InitModule().then((sqlite3) => sqlite3.installOpfsSAHPoolVfs({ name: VFS_NAME }))

const handler = createMirrorHandler(async (idbName) => {
  const pool = await poolReady
  const file = `/${encodeURIComponent(idbName)}.sqlite3`
  const db = new pool.OpfsSAHPoolDb(file)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA synchronous=NORMAL")
  return {
    db,
    close: () => db.close(),
    destroy: () => {
      db.close()
      pool.unlink(file)
    },
  }
})

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerEnvelope>) => void) | null
  postMessage(message: WorkerResponse): void
}

scope.onmessage = ({ data }) => {
  void handler.handle(data.request).then((reply) => scope.postMessage({ id: data.id, reply }))
}
