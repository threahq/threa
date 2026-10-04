import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Stream } from "@threahq/types"
import { useStreamService } from "@/contexts"
import { sealStreamRename } from "@/lib/crypto/stream-rename"
import { mergeStreamByRevision, persistStreamByRevision } from "@/lib/title-merge"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useStreamFromStore } from "@/stores/stream-store"
import type { CachedStream } from "@/db"
import { useWorkspaceUserId } from "./use-workspaces"
import { streamKeys } from "./use-streams"
import { workspaceKeys } from "./use-workspaces"

const pickE2eEnabled = (stream: CachedStream) => ({ e2eEnabled: stream.e2eEnabled })

export function useRenameStream(workspaceId: string, streamId: string, streamOverride?: Pick<Stream, "e2eEnabled">) {
  const queryClient = useQueryClient()
  const service = useStreamService()
  const stored = useStreamFromStore(workspaceId, streamOverride ? undefined : streamId, pickE2eEnabled)
  const e2eEnabled = (streamOverride ?? stored)?.e2eEnabled
  const userId = useWorkspaceUserId(workspaceId) ?? ""
  const session = useE2eSession(workspaceId, userId)
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const canRename = !e2eEnabled || session.status === "unlocked"

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
        const input = e2eEnabled
          ? await sealStreamRename({ workspaceId, streamId, userId, name })
          : { displayName: name }
        const updated = await service.update(workspaceId, streamId, input)
        await persistStreamByRevision(updated)
        queryClient.setQueryData<Stream>(streamKeys.detail(workspaceId, streamId), (old) =>
          old ? mergeStreamByRevision(old, updated) : updated
        )
        queryClient.setQueriesData<{ stream?: Stream }>(
          { queryKey: streamKeys.bootstrap(workspaceId, streamId) },
          (old) => (old ? { ...old, stream: old.stream ? mergeStreamByRevision(old.stream, updated) : updated } : old)
        )
        queryClient.setQueryData<{ streams?: Stream[] }>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old?.streams
            ? {
                ...old,
                streams: old.streams.map((item) =>
                  item.id === streamId ? mergeStreamByRevision(item, updated) : item
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
    [canRename, queryClient, service, e2eEnabled, streamId, userId, workspaceId]
  )

  return { rename, canRename, isPending, error }
}
