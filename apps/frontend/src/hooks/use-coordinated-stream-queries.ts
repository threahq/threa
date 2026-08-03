import { useMemo } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import { useSocket, useStreamService } from "@/contexts"
import { debugBootstrap } from "@/lib/bootstrap-debug"
import {
  QUERY_LOAD_STATE,
  getQueryLoadState,
  isQueryLoadStateLoading,
  isTerminalBootstrapError,
  type QueryLoadState,
} from "@/lib/query-load-state"
import { STREAM_BOOTSTRAP_QUERY_OPTIONS } from "@/lib/stream-bootstrap-query"
import { joinRoomBestEffort } from "@/lib/socket-room"
import { applyStreamBootstrap, toCachedStreamBootstrap, type CachedStreamBootstrap } from "@/sync/stream-sync"
import { streamKeys } from "./use-streams"

export function isDraftId(id: string): boolean {
  // Draft scratchpads use "draft_xxx" format, draft thread panels use "draft:xxx:xxx" format
  return id.startsWith("draft_") || id.startsWith("draft:")
}

async function queryFnWithoutSocket() {
  throw new Error("Socket not available for stream subscription")
}

function aggregateQueryLoadState(states: QueryLoadState[]): QueryLoadState {
  if (states.length === 0) return QUERY_LOAD_STATE.READY

  const nonErrorStates = states.filter((state) => state !== QUERY_LOAD_STATE.ERROR)
  if (nonErrorStates.some((state) => state === QUERY_LOAD_STATE.FETCHING)) return QUERY_LOAD_STATE.FETCHING
  if (nonErrorStates.some((state) => state === QUERY_LOAD_STATE.PENDING)) return QUERY_LOAD_STATE.PENDING
  if (nonErrorStates.length === 0) return QUERY_LOAD_STATE.ERROR
  return QUERY_LOAD_STATE.READY
}

/**
 * Fetches multiple stream bootstraps in parallel using React Query's useQueries.
 * Filters out draft IDs since they're local IndexedDB data.
 */
export function useCoordinatedStreamQueries(workspaceId: string, streamIds: string[]) {
  const socket = useSocket()
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  // Filter out draft IDs - they don't need server fetches
  const serverStreamIds = useMemo(() => streamIds.filter((id) => !isDraftId(id)), [streamIds])

  // Check which queries have already errored - don't re-enable them.
  // Note: queryClient is stable (never changes reference), so this memo only re-runs
  // when serverStreamIds or workspaceId change. This is intentional - we want to check
  // cached query state when the stream list changes, but not re-check on every render.
  // Queries that error after mount will still be caught because useQueries tracks them.
  const erroredStreamIds = useMemo(() => {
    const errored = new Set<string>()
    for (const streamId of serverStreamIds) {
      const state = queryClient.getQueryState(streamKeys.bootstrap(workspaceId, streamId))
      if (state?.status === "error" && isTerminalBootstrapError(state.error)) {
        errored.add(streamId)
      }
    }
    return errored
  }, [serverStreamIds, workspaceId, queryClient])

  const queries = useMemo(
    () =>
      serverStreamIds.map((streamId) => ({
        queryKey: streamKeys.bootstrap(workspaceId, streamId),
        queryFn: socket
          ? async () => {
              debugBootstrap("Coordinated stream bootstrap queryFn start", { workspaceId, streamId })
              await joinRoomBestEffort(socket, `ws:${workspaceId}:stream:${streamId}`, "CoordinatedStreamBootstrap")

              const fetchStartedAt = Date.now()
              const bootstrap = await streamService.bootstrap(workspaceId, streamId)
              debugBootstrap("Coordinated stream bootstrap fetch success", {
                workspaceId,
                streamId,
                eventCount: bootstrap.events.length,
              })

              await applyStreamBootstrap(workspaceId, streamId, bootstrap, { fetchStartedAt, queryClient })

              return toCachedStreamBootstrap(
                bootstrap,
                queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId)),
                { incrementWindowVersionOnReplace: bootstrap.syncMode === "replace" }
              )
            }
          : queryFnWithoutSocket,
        // Terminal 403/404 errors disable the query to prevent loops; recoverable
        // errors stay enabled and self-heal via STREAM_BOOTSTRAP_QUERY_OPTIONS.retry.
        enabled: !!workspaceId && !!socket && !erroredStreamIds.has(streamId),
        ...STREAM_BOOTSTRAP_QUERY_OPTIONS,
      })),
    [serverStreamIds, workspaceId, streamService, socket, erroredStreamIds, queryClient]
  )

  const results = useQueries({ queries })
  const queryLoadStates = results.map((result) => getQueryLoadState(result.status, result.fetchStatus))
  const loadState = aggregateQueryLoadState(queryLoadStates)

  // Backwards-compatible boolean while call sites migrate to `loadState`.
  const isLoading = isQueryLoadStateLoading(loadState)
  const isError = results.some((r) => r.isError)
  const errors = results.filter((r) => r.error).map((r) => r.error)

  debugBootstrap("Coordinated stream observer state", {
    workspaceId,
    streamIds,
    serverStreamIds,
    hasSocket: !!socket,
    loadState,
    isLoading,
    isError,
    errorCount: errors.length,
  })

  return {
    results,
    loadState,
    isLoading,
    isError,
    errors,
  }
}
