import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { createMirrorHandler } from "./handler"
import type { WorkerEnvelope, WorkerResponse } from "./protocol"

const DATABASE_FILE = "/mirror.sqlite3"
const INSTALL_ATTEMPTS = 6
const FIRST_RETRY_MS = 100

const sqlite3Ready = sqlite3InitModule()

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// The pool locks its directory exclusively, so each database gets its own; a
// tab inheriting ownership retries while the previous owner's worker lets go.
async function installPool(idbName: string) {
  const sqlite3 = await sqlite3Ready
  const name = `threa-mirror-${fnv1a(idbName)}`
  // Without both flags a failed install deletes the pool's files, then caches the failure.
  // forceReinitIfPreviouslyFailed is honoured at runtime but missing from the typings.
  const options = { name, directory: `.${name}`, preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true }
  for (let attempt = 1; ; attempt++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs(options)
    } catch (error) {
      if (attempt === INSTALL_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, FIRST_RETRY_MS * 2 ** (attempt - 1)))
    }
  }
}

const handler = createMirrorHandler(async (idbName) => {
  const pool = await installPool(idbName)
  const db = new pool.OpfsSAHPoolDb(DATABASE_FILE)
  return {
    db,
    close: () => db.close(),
    destroy: async () => {
      db.close()
      await pool.removeVfs()
    },
  }
})

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerEnvelope>) => void) | null
  postMessage(message: WorkerResponse): void
}

scope.onmessage = ({ data }) => {
  void handler
    .handle(data.request, () => scope.postMessage({ id: data.id, started: true }))
    .then((reply) => scope.postMessage({ id: data.id, reply }))
}
