import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSocket } from "@/contexts"
import { joinRoomFireAndForget } from "@/lib/socket-room"
import { registerStreamSocketHandlers } from "@/sync/stream-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"

/**
 * Hook to handle real-time message/reaction events for a specific stream.
 * Joins the stream room and delegates event handling to the sync module
 * which writes exclusively to IndexedDB (UI updates via useLiveQuery).
 *
 * Bootstrap hooks also use join ack via joinRoomWithAck before fetching.
 * This hook keeps the room subscription active for realtime updates.
 */
export function useStreamSocket(workspaceId: string, streamId: string, options?: { enabled?: boolean }) {
  const shouldSubscribe = options?.enabled ?? true
  const queryClient = useQueryClient()
  const socket = useSocket()
  // Optional: draft panels can mount outside the workspace SyncEngine provider.
  const syncEngine = useOptionalSyncEngine()

  useEffect(() => {
    if (!socket || !workspaceId || !streamId || !shouldSubscribe) return

    const room = `ws:${workspaceId}:stream:${streamId}`
    const abortController = new AbortController()

    // Subscribe FIRST (before any fetches happen)
    joinRoomFireAndForget(socket, room, abortController.signal, "StreamSocket")

    // Register all stream-level socket handlers — they write to IDB only.
    // queryClient is passed for transitional workspace bootstrap preview updates
    // (will be removed in Phase 3).
    const cleanupHandlers = registerStreamSocketHandlers(socket, workspaceId, streamId, queryClient, {
      // A live event that skips past the cached tail means events were missed
      // (zombie socket, server bounce). Route to the engine's single-flighted
      // backfill so the hole is fetched instead of persisting until reload.
      onSequenceGap: syncEngine
        ? ({ streamId: gapStreamId, afterSequence }) => void syncEngine.backfillStreamGap(gapStreamId, afterSequence)
        : undefined,
    })

    return () => {
      abortController.abort()
      cleanupHandlers()
      // Do NOT leave the room here. Socket.io rooms are not reference-counted:
      // a single leave undoes ALL joins. The SyncEngine also joins this room
      // for stream:activity delivery — leaving here would break sidebar updates.
    }
  }, [socket, workspaceId, streamId, shouldSubscribe, queryClient, syncEngine])
}
