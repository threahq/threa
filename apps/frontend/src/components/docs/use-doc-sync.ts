import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import * as Y from "yjs"
import { StreamErrorCodes } from "@threahq/types"
import { useSocket, useSocketReconnectCount } from "@/contexts"
import { useCurrentWorkspaceUser } from "@/hooks"
import { useLatest } from "@/hooks/use-latest"
import { DocPresence } from "@/lib/docs/doc-presence"
import { DocSync, type DocSyncStatus } from "@/lib/docs/doc-sync"
import { joinRoomWithAck } from "@/lib/socket-room"
import { useOptionalSyncEngine } from "@/sync/sync-engine"

interface DocSession {
  key: string
  ydoc: Y.Doc
  sync: DocSync
  presence: DocPresence
  loaded: Promise<void>
}

export type DocSyncView =
  | { phase: "loading" }
  | { phase: "error"; retry: () => void }
  | { phase: "ready"; ydoc: Y.Doc; presence: DocPresence; flush: () => void }

const NO_SESSION_STATUS: DocSyncStatus = { phase: "loading" }
const noSubscription = () => () => {}

/**
 * One live `Y.Doc` for a doc stream, kept in sync over REST and the doc's room.
 * A rejected edit replaces the doc and its sync: the old doc still holds the
 * dropped bytes, and every later edit built on them would fail as not applicable.
 */
export function useDocSync(workspaceId: string, docId: string | null): DocSyncView {
  const [generation, setGeneration] = useState(0)
  const [created, setCreated] = useState<DocSession | null>(null)
  const key = `${workspaceId}:${docId}:${generation}`
  // The previous doc's session stays in state for the render that switches away from it.
  const session = docId && created?.key === key ? created : null

  const socket = useSocket()
  const latestSocket = useLatest(socket)
  const syncEngine = useOptionalSyncEngine()
  const latestSyncEngine = useLatest(syncEngine)

  useEffect(() => {
    if (!docId) return
    const ydoc = new Y.Doc()
    const sync = new DocSync({
      workspaceId,
      docId,
      ydoc,
      kickOperationQueue: () => latestSyncEngine()?.kickOperationQueue(),
      onLost: () => {
        toast.error("Your last edits couldn't be kept", {
          description: "This browser could not store them to send later.",
        })
      },
      onRejected: (refusal) => {
        const readOnly = refusal.status === 403 || refusal.code === StreamErrorCodes.READ_ONLY
        toast.error(readOnly ? "You can't edit this doc" : "Your last edit couldn't be saved", {
          description: "The doc reloaded with the saved version.",
        })
        setGeneration((current) => current + 1)
      },
    })
    const presence = new DocPresence({
      ydoc,
      workspaceId,
      docId,
      send: (payload) => latestSocket()?.emit("doc:awareness", payload),
    })
    // Unload and the back-forward cache never unmount: unsent edits go to the queue, and peers would keep a ghost caret until the 30 s awareness timeout.
    const onPageHide = () => {
      sync.queueUnsent()
      presence.withdraw()
    }
    // The socket can outlive an offline spell, so its reconnect flush is not enough.
    const onOnline = () => void sync.flush()
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("pageshow", presence.restore)
    window.addEventListener("online", onOnline)
    setCreated({ key, ydoc, sync, presence, loaded: sync.start() })
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("pageshow", presence.restore)
      window.removeEventListener("online", onOnline)
      presence.destroy()
      sync.stop()
      ydoc.destroy()
    }
  }, [workspaceId, docId, key, latestSocket, latestSyncEngine])

  const viewer = useCurrentWorkspaceUser(workspaceId)
  const viewerId = viewer?.id
  const viewerName = viewer?.name
  useEffect(() => {
    session?.presence.setLocalUser(viewerId && viewerName ? { userId: viewerId, name: viewerName } : null)
  }, [session, viewerId, viewerName])

  // Awareness is unsequenced, so it rides the socket, not the live event source.
  useEffect(() => {
    if (!session || !socket) return
    socket.on("doc:awareness", session.presence.receive)
    return () => {
      socket.off("doc:awareness", session.presence.receive)
    }
  }, [session, socket])

  useEffect(() => {
    const eventSource = syncEngine?.getLiveEventSource() ?? socket
    if (!session || !eventSource) return
    eventSource.on("doc:updated", session.sync.receive)
    return () => {
      eventSource.off("doc:updated", session.sync.receive)
    }
  }, [session, socket, syncEngine])

  // INV-53: the load may have read the doc before the room join took effect, so catch up once the join is acked; presence re-announces to peers who joined or timed us out meanwhile.
  const reconnectCount = useSocketReconnectCount()
  useEffect(() => {
    if (!session || !socket || !docId) return
    const abortController = new AbortController()
    joinRoomWithAck(socket, `ws:${workspaceId}:stream:${docId}`, { signal: abortController.signal })
      .then(() => session.loaded)
      .then(() => {
        if (abortController.signal.aborted) return
        void session.sync.catchUp()
        void session.sync.flush()
        session.presence.resend()
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
  const flush = useCallback(() => void session?.sync.flush(), [session])

  if (!session || status.phase === "loading") return { phase: "loading" }
  if (status.phase === "error") return { phase: "error", retry }
  return { phase: "ready", ydoc: session.ydoc, presence: session.presence, flush }
}
