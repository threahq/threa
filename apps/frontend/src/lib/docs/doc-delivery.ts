import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocUpdateView } from "@threahq/types"
import { applyServerUpdate } from "./block-rescue"
import { docLockName, type DocLocalCopies } from "./doc-local-copy"
import type { DocsApi } from "./doc-sync"

/** Thrown while a tab holds the doc open: delivering beside it could rescue the same edits twice, so the row waits until no tab does. */
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

/** Every row of the doc's log after `after`, in seq order, a page at a time. */
export async function* rowsAfter(
  api: DocsApi,
  workspaceId: string,
  docId: string,
  after: number
): AsyncGenerator<DocUpdateView> {
  for (let cursor = after; ; ) {
    const { updates, hasMore } = await api.listUpdates(workspaceId, docId, cursor)
    yield* updates
    const last = updates.at(-1)
    if (!hasMore || !last) return
    cursor = last.seq
  }
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
      for await (const row of rowsAfter(api, workspaceId, docId, seq)) {
        applyServerUpdate(local, server, base64ToBytes(row.update), null, true)
        seq = row.seq
      }
      const edits = Y.encodeStateAsUpdate(local, Y.encodeStateVector(server))
      // Saved before the POST: a retry after a lost response starts from here, not from the copy's old base, which
      // would see the edit's own row as a change to rescue against and add it twice.
      await localCopies.write(workspaceId, docId, { state: Y.encodeStateAsUpdate(server), seq, unsent: edits })
      const result = await api.postUpdate(workspaceId, docId, bytesToBase64(edits))
      // Any other answer leaves the edits unplaced in the server's log; kept as unsent, the next open re-sends them as a no-op.
      if (result.applied && result.seq === seq + 1) {
        Y.applyUpdate(server, edits)
        await localCopies.write(workspaceId, docId, {
          state: Y.encodeStateAsUpdate(server),
          seq: result.seq,
          unsent: null,
        })
      }
    } finally {
      server.destroy()
      local.destroy()
    }
  })
}
