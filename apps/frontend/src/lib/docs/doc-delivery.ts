import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import { ApiError } from "@/api/client"
import { applyServerUpdate } from "./block-rescue"
import { docLockName, type DocLocalCopies } from "./doc-local-copy"
import type { DocsApi } from "./doc-sync"

/** Thrown while a tab holds the doc open: that tab's `DocSync` sends the edits, and the row waits for it to close. */
export class DocOpenElsewhereError extends Error {
  constructor() {
    super("The doc is open in a tab, which sends its edits")
  }
}

function withDocLock<T>(workspaceId: string, docId: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return fn()
  return navigator.locks.request(docLockName(workspaceId, docId), { ifAvailable: true }, (lock) => {
    if (!lock) throw new DocOpenElsewhereError()
    return fn()
  }) as Promise<T>
}

/**
 * Sends a queued doc edit the way an open doc would: from the doc's local copy, caught
 * up row by row, so a move or rewrite since the copy was saved cannot drop it. Without
 * a copy there is no base to rescue against, and the bytes go as they are.
 */
export function deliverQueuedDocUpdate(params: {
  workspaceId: string
  docId: string
  update: string
  api: DocsApi
  localCopies: DocLocalCopies
}): Promise<void> {
  const { workspaceId, docId, update, api, localCopies } = params
  return withDocLock(workspaceId, docId, async () => {
    const copy = await localCopies.read(workspaceId, docId)
    if (!copy) {
      await api.postUpdate(workspaceId, docId, update)
      return
    }
    const server = new Y.Doc()
    const local = new Y.Doc()
    try {
      Y.applyUpdate(server, copy.state)
      Y.applyUpdate(local, Y.mergeUpdates([copy.state, ...copy.unsent, base64ToBytes(update)]))
      let seq = copy.seq
      try {
        const { updates } = await api.listUpdates(workspaceId, docId, seq)
        for (const row of updates) {
          applyServerUpdate(local, server, base64ToBytes(row.update), null, true)
          seq = row.seq
        }
      } catch (error) {
        if (!ApiError.isApiError(error) || error.status !== 409) throw error
        const doc = await api.get(workspaceId, docId, bytesToBase64(Y.encodeStateVector(server)))
        applyServerUpdate(local, server, base64ToBytes(doc.state), null, true)
        seq = doc.seq
      }
      const edits = Y.encodeStateAsUpdate(local, Y.encodeStateVector(server))
      const result = await api.postUpdate(workspaceId, docId, bytesToBase64(edits))
      // Any other answer leaves the edits unplaced in the server's log; kept as unsent, the next open re-sends them as a no-op.
      const nextRow = result.applied && result.seq === seq + 1
      if (nextRow) {
        Y.applyUpdate(server, edits)
        seq = result.seq
      }
      await localCopies.write(workspaceId, docId, {
        state: Y.encodeStateAsUpdate(server),
        seq,
        unsent: nextRow ? null : edits,
      })
    } finally {
      server.destroy()
      local.destroy()
    }
  })
}
