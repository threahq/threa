import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { StreamTypes, type DocBlockThread, type DocThreadsResponse } from "@threahq/types"
import { docKeys, docsApi } from "@/api/docs"
import { useSocket } from "@/contexts"
import type { StreamCreatedPayload, ThreadUpdatedPayload } from "@/sync/stream-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"

export type DocBlockThreadState = Omit<DocBlockThread, "blockId">

export type DocBlockThreads = ReadonlyMap<string, DocBlockThreadState>

const NO_THREADS: DocBlockThreads = new Map()

function upsertThread(
  response: DocThreadsResponse | undefined,
  blockId: string,
  patch: (existing: DocBlockThread | undefined) => DocBlockThread
): DocThreadsResponse | undefined {
  if (!response) return response
  const existing = response.threads.find((thread) => thread.blockId === blockId)
  const next = patch(existing)
  return {
    threads: existing
      ? response.threads.map((thread) => (thread === existing ? next : thread))
      : [...response.threads, next],
  }
}

/**
 * The doc's section threads with their live reply counts. The doc room `useDocSync` joins carries both the
 * threads' creation and their reply counts, so the list is read once that join is acked and again on every
 * later ack (INV-53): an event the room carried before the join is only in the next read.
 */
export function useDocBlockThreads(workspaceId: string, docId: string, joinCount: number): DocBlockThreads {
  const queryClient = useQueryClient()
  const socket = useSocket()
  const syncEngine = useOptionalSyncEngine()

  const { data } = useQuery({
    queryKey: docKeys.threads(workspaceId, docId),
    queryFn: () => docsApi.listThreads(workspaceId, docId),
    enabled: joinCount > 0,
  })

  useEffect(() => {
    const eventSource = syncEngine?.getLiveEventSource() ?? socket
    if (!eventSource) return
    const key = docKeys.threads(workspaceId, docId)
    // Before the first answer, or while an older one is in flight, a patch would be dropped or overwritten: read again.
    const apply = (blockId: string, patch: (existing: DocBlockThread | undefined) => DocBlockThread) => {
      if (queryClient.getQueryData(key) === undefined || queryClient.isFetching({ queryKey: key }) > 0) {
        // A first read in flight is joined, not replaced, by an invalidate alone.
        void queryClient.cancelQueries({ queryKey: key }).then(() => queryClient.invalidateQueries({ queryKey: key }))
        return
      }
      queryClient.setQueryData<DocThreadsResponse>(key, (old) => upsertThread(old, blockId, patch))
    }
    const onThreadUpdated = (payload: ThreadUpdatedPayload) => {
      if (payload.workspaceId !== workspaceId || payload.parentStreamId !== docId) return
      apply(payload.anchorId, (existing) => ({
        blockId: payload.anchorId,
        threadId: payload.threadId,
        replyCount: payload.replyCount ?? existing?.replyCount ?? 0,
      }))
    }
    const onStreamCreated = ({ workspaceId: eventWorkspaceId, stream }: StreamCreatedPayload) => {
      if (eventWorkspaceId !== workspaceId || stream.type !== StreamTypes.THREAD) return
      if (stream.parentStreamId !== docId || !stream.parentAnchorId) return
      const blockId = stream.parentAnchorId
      apply(blockId, (existing) => ({
        blockId,
        threadId: stream.id,
        replyCount: existing?.replyCount ?? stream.replyCount ?? 0,
      }))
    }
    eventSource.on("thread:updated", onThreadUpdated)
    eventSource.on("stream:created", onStreamCreated)
    return () => {
      eventSource.off("thread:updated", onThreadUpdated)
      eventSource.off("stream:created", onStreamCreated)
    }
  }, [workspaceId, docId, socket, syncEngine, queryClient])

  useEffect(() => {
    if (joinCount < 2) return
    void queryClient.invalidateQueries({ queryKey: docKeys.threads(workspaceId, docId) })
  }, [joinCount, workspaceId, docId, queryClient])

  return useMemo(
    () =>
      data
        ? new Map(data.threads.map(({ blockId, threadId, replyCount }) => [blockId, { threadId, replyCount }]))
        : NO_THREADS,
    [data]
  )
}
