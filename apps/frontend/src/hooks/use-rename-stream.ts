import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Stream } from "@threahq/types"
import { useStreamService } from "@/contexts"
import { sealStreamRename } from "@/lib/crypto/stream-rename"
import { mergeStreamByTitleRevision, persistStreamByTitleRevision } from "@/lib/title-merge"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useWorkspaceUserId } from "./use-workspaces"
import { streamKeys } from "./use-streams"
import { workspaceKeys } from "./use-workspaces"

export function useRenameStream(workspaceId: string, streamId: string, streamOverride?: Stream) {
  const queryClient = useQueryClient()
  const service = useStreamService()
  const streams = useWorkspaceStreams(workspaceId)
  const stream = streamOverride ?? streams.find((item) => item.id === streamId)
  const userId = useWorkspaceUserId(workspaceId) ?? ""
  const session = useE2eSession(workspaceId, userId)
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const canRename = !stream?.e2eEnabled || session.status === "unlocked"

  const rename = useCallback(
    async (name: string) => {
      if (!canRename) {
        const lockedError = new Error("Unlock this scratchpad to rename it")
        setError(lockedError)
        throw lockedError
      }
      setIsPending(true)
      setError(null)
      try {
        const input = stream?.e2eEnabled
          ? await sealStreamRename({ workspaceId, streamId, userId, name })
          : { displayName: name }
        const updated = await service.update(workspaceId, streamId, input)
        await persistStreamByTitleRevision(updated)
        queryClient.setQueryData<Stream>(streamKeys.detail(workspaceId, streamId), (old) =>
          old ? mergeStreamByTitleRevision(old, updated) : updated
        )
        queryClient.setQueriesData<{ stream?: Stream }>(
          { queryKey: streamKeys.bootstrap(workspaceId, streamId) },
          (old) =>
            old ? { ...old, stream: old.stream ? mergeStreamByTitleRevision(old.stream, updated) : updated } : old
        )
        queryClient.setQueryData<{ streams?: Stream[] }>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old?.streams
            ? {
                ...old,
                streams: old.streams.map((item) =>
                  item.id === streamId ? mergeStreamByTitleRevision(item, updated) : item
                ),
              }
            : old
        )
      } catch (cause) {
        const nextError = cause instanceof Error ? cause : new Error("Failed to update name")
        setError(nextError)
        throw nextError
      } finally {
        setIsPending(false)
      }
    },
    [canRename, queryClient, service, stream, streamId, userId, workspaceId]
  )

  return { rename, canRename, isPending, error }
}
