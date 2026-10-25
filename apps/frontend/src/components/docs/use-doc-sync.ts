import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import * as Y from "yjs"
import type { DocUpdatedOutboxPayload } from "@threahq/types"
import { useSocket, useSocketReconnectCount } from "@/contexts"
import { useStreamSocket } from "@/hooks/use-stream-socket"
import { DocSync, type DocSyncStatus } from "@/lib/docs/doc-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"

interface DocSession {
  key: string
  ydoc: Y.Doc
  sync: DocSync
}

const NO_SESSION_STATUS: DocSyncStatus = { phase: "loading", saving: false }
const noSubscription = () => () => {}

export interface UseDocSyncResult {
  /** Null until the session for the current generation exists. */
  ydoc: Y.Doc | null
  status: DocSyncStatus["phase"]
  error: unknown
  retry: () => void
}

/**
 * One live `Y.Doc` for a doc stream, kept in sync over REST and the doc's room.
 * A rejected edit replaces the doc and its sync: the old doc still holds the
 * dropped bytes, and every later edit built on them would fail as not applicable.
 */
export function useDocSync(workspaceId: string, docId: string): UseDocSyncResult {
  const [generation, setGeneration] = useState(0)
  const [created, setCreated] = useState<DocSession | null>(null)
  const key = `${workspaceId}:${docId}:${generation}`
  // The previous doc's session stays in state for the render that switches away from it.
  const session = created?.key === key ? created : null

  useEffect(() => {
    const ydoc = new Y.Doc()
    const sync = new DocSync({ workspaceId, docId, ydoc })
    setCreated({ key, ydoc, sync })
    void sync.start()
    return () => {
      sync.stop()
      ydoc.destroy()
    }
  }, [workspaceId, docId, key])

  useStreamSocket(workspaceId, docId)

  const socket = useSocket()
  const syncEngine = useOptionalSyncEngine()
  useEffect(() => {
    const eventSource = syncEngine?.getLiveEventSource() ?? socket
    if (!session || !eventSource) return
    const onDocUpdated = (payload: DocUpdatedOutboxPayload) => {
      if (payload.workspaceId === workspaceId) session.sync.receive(payload)
    }
    eventSource.on("doc:updated", onDocUpdated)
    return () => {
      eventSource.off("doc:updated", onDocUpdated)
    }
  }, [session, socket, syncEngine, workspaceId])

  const reconnectCount = useSocketReconnectCount()
  useEffect(() => {
    void session?.sync.catchUp()
  }, [session, reconnectCount])

  const status = useSyncExternalStore(
    session?.sync.subscribe ?? noSubscription,
    () => session?.sync.getStatus() ?? NO_SESSION_STATUS
  )

  const phase = status.phase
  useEffect(() => {
    if (phase !== "rejected") return
    toast.error("Your last edit couldn't be saved", { description: "The doc reloaded with the saved version." })
    setGeneration((current) => current + 1)
  }, [phase, session])

  const retry = useCallback(() => void session?.sync.retry(), [session])

  return {
    ydoc: session?.ydoc ?? null,
    status: phase,
    error: status.phase === "error" ? status.error : null,
    retry,
  }
}
