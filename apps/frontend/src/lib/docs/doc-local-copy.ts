import { base64ToBytes } from "@threahq/crypto"
import type { ThreaDatabase } from "@/db"

/** What this device last held of a doc. */
export interface DocLocalCopy {
  state: Uint8Array
  seq: number
  /** Local edits on top of `state` the server may not hold yet: the copy's own, then the queue's for this doc. */
  unsent: Uint8Array[]
  /** The queue rows whose bytes are in `unsent`. */
  queuedIds: string[]
}

export interface DocLocalCopies {
  read(workspaceId: string, docId: string): Promise<DocLocalCopy | null>
  write(
    workspaceId: string,
    docId: string,
    copy: { state: Uint8Array; seq: number; unsent: Uint8Array | null }
  ): Promise<void>
  /** Also deletes `queuedIds`: rows whose bytes went into a POST the server refused. */
  remove(workspaceId: string, docId: string, queuedIds?: string[]): Promise<void>
}

/** Captures the database at construction, so a write after an account switch still lands in the account that made it. */
export function dexieDocLocalCopies(database: ThreaDatabase): DocLocalCopies {
  return {
    read: (workspaceId, docId) =>
      database.transaction("r", database.docStates, database.pendingOperations, async () => {
        const row = await database.docStates.get([workspaceId, docId])
        if (!row) return null
        const queued = await database.pendingOperations
          .where("workspaceId")
          .equals(workspaceId)
          .filter((op) => op.type === "doc_update" && op.payload.docId === docId)
          .toArray()
        const unsent = queued.map((op) => base64ToBytes(op.payload.update as string))
        return {
          state: row.state,
          seq: row.seq,
          unsent: row.unsent ? [row.unsent, ...unsent] : unsent,
          queuedIds: queued.map((op) => op.id),
        }
      }),
    write: async (workspaceId, docId, copy) => {
      await database.docStates.put({ workspaceId, docId, ...copy, _cachedAt: Date.now() })
    },
    remove: (workspaceId, docId, queuedIds = []) =>
      database.transaction("rw", database.docStates, database.pendingOperations, async () => {
        await database.docStates.delete([workspaceId, docId])
        await database.pendingOperations.bulkDelete(queuedIds)
      }),
  }
}

/** Held shared by every open `DocSync` of the doc, exclusive by the queue while it sends the doc's rows: one writer per copy. */
export function docLockName(workspaceId: string, docId: string): string {
  return `threa-doc:${workspaceId}:${docId}`
}
