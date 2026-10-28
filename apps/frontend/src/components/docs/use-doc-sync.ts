import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import * as Y from "yjs"
import { StreamErrorCodes } from "@threahq/types"
import { useSocket, useSocketReconnectCount } from "@/contexts"
import { DocSync, type DocSyncStatus } from "@/lib/docs/doc-sync"
import { joinRoomWithAck } from "@/lib/socket-room"
import { useOptionalSyncEngine } from "@/sync/sync-engine"

interface DocSession {
  key: string
  ydoc: Y.Doc
  sync: DocSync
  loaded: Promise<void>
}

export type DocSyncView = { phase: "loading" } | { phase: "error"; retry: () => void } | { phase: "ready"; ydoc: Y.Doc }

const NO_SESSION_STATUS: DocSyncStatus = { phase: "loading" }
const noSubscription = () => () => {}

/**
 * One live `Y.Doc` for a doc stream, kept in sync over REST and the doc's room.
 * A rejected edit replaces the doc and its sync: the old doc still holds the
 * dropped bytes, and every later edit built on them would fail as not applicable.
 */
export function useDocSync(workspaceId: string, docId: string): DocSyncView {
  const [generation, setGeneration] = useState(0)
  const [created, setCreated] = useState<DocSession | null>(null)
  const key = `${workspaceId}:${docId}:${generation}`
  // The previous doc's session stays in state for the render that switches away from it.
  const session = created?.key === key ? created : null

  useEffect(() => {
    const ydoc = new Y.Doc()
    const sync = new DocSync({
      workspaceId,
      docId,
      ydoc,
      onRejected: (refusal) => {
        const readOnly = refusal.status === 403 || refusal.code === StreamErrorCodes.READ_ONLY
        toast.error(readOnly ? "You can't edit this doc" : "Your last edit couldn't be saved", {
          description: "The doc reloaded with the saved version.",
        })
        setGeneration((current) => current + 1)
      },
    })
    setCreated({ key, ydoc, sync, loaded: sync.start() })
    return () => {
      sync.stop()
      ydoc.destroy()
    }
  }, [workspaceId, docId, key])

  const socket = useSocket()
  const syncEngine = useOptionalSyncEngine()
  useEffect(() => {
    const eventSource = syncEngine?.getLiveEventSource() ?? socket
    if (!session || !eventSource) return
    eventSource.on("doc:updated", session.sync.receive)
    return () => {
      eventSource.off("doc:updated", session.sync.receive)
    }
  }, [session, socket, syncEngine])

  // INV-53: the load may have read the doc before the room join took effect, so catch up once the join is acked.
  const reconnectCount = useSocketReconnectCount()
  useEffect(() => {
    if (!session || !socket) return
    const abortController = new AbortController()
    joinRoomWithAck(socket, `ws:${workspaceId}:stream:${docId}`, { signal: abortController.signal })
      .then(() => session.loaded)
      .then(() => {
        if (!abortController.signal.aborted) void session.sync.catchUp()
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) console.warn("Failed to join the doc room", { docId, error })
      })
    // Never leave the room: Socket.io rooms are not reference-counted, and other subscribers share this one.
    return () => abortController.abort()
  }, [session, socket, workspaceId, docId, reconnectCount])

  const status = useSyncExternalStore(
    session?.sync.subscribe ?? noSubscription,
    () => session?.sync.getStatus() ?? NO_SESSION_STATUS
  )

  const retry = useCallback(() => void session?.sync.retry(), [session])

  if (!session || status.phase === "loading") return { phase: "loading" }
  if (status.phase === "error") return { phase: "error", retry }
  return { phase: "ready", ydoc: session.ydoc }
}
