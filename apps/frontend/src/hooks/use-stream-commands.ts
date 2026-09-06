import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { CommandInfo } from "@threahq/types"
import { commandsApi } from "@/api"
import { streamKeys } from "@/hooks/use-streams"
import { isDraftId } from "@/hooks/use-coordinated-stream-queries"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
import { useWorkspaceMetadata } from "@/stores/workspace-store"

export const commandKeys = {
  forStream: (workspaceId: string, streamId: string) => ["commands", "stream", workspaceId, streamId] as const,
}

/**
 * A stream's effective command list REPLACES the workspace list — never merges
 * with it. Absent stream commands
 * fall back to the workspace set.
 */
export function resolveEffectiveCommandInfos(
  workspaceCommands: readonly CommandInfo[] | undefined,
  streamCommands: readonly CommandInfo[] | undefined
): readonly CommandInfo[] {
  return streamCommands ?? workspaceCommands ?? []
}

/**
 * Single source of truth for "what slash commands apply here" — read by both the
 * `/` palette and composer send-time dispatch so the two can never disagree on
 * what counts as a command.
 *
 * The stream's cached bootstrap wins when present (no network, no flash). A
 * conversation surface has no bootstrap for its stream (the panel is an overlay,
 * not a route), so the list is fetched — the backend resolves a thread through
 * its root, so a thread id returns the scratchpad's runtime commands.
 */
export function useStreamCommands(workspaceId: string | undefined, streamId: string | undefined): CommandInfo[] {
  const metadata = useWorkspaceMetadata(workspaceId)
  const queryClient = useQueryClient()

  const bootstrapKey = workspaceId && streamId ? streamKeys.bootstrap(workspaceId, streamId) : null
  const { data: streamBootstrap } = useQuery({
    queryKey: bootstrapKey ?? ["streams", "bootstrap", workspaceId ?? "", ""],
    queryFn: () => (bootstrapKey ? (queryClient.getQueryData<CachedStreamBootstrap>(bootstrapKey) ?? null) : null),
    enabled: false,
    staleTime: Infinity,
  })

  const bootstrapCommands = streamBootstrap?.commands
  const { data: fetchedCommands } = useQuery({
    queryKey: commandKeys.forStream(workspaceId ?? "", streamId ?? ""),
    queryFn: () => commandsApi.listForStream(workspaceId!, streamId!),
    // A draft id names no server stream — the request 200-[]s and an empty list
    // REPLACES the workspace palette (resolveEffectiveCommandInfos), so a draft
    // must keep the workspace fallback with zero requests.
    enabled: !!workspaceId && !!streamId && !isDraftId(streamId) && bootstrapCommands === undefined,
    // The socket writes this key on runtime presence changes, but only for a
    // stream this client has joined — a panel on any other stream would hold a
    // stale list forever. Revalidate on every mount; cached data still renders
    // instantly.
    staleTime: 0,
    refetchOnMount: true,
    gcTime: 5 * 60_000,
  })

  return useMemo(
    () => [...resolveEffectiveCommandInfos(metadata?.commands, bootstrapCommands ?? fetchedCommands)],
    [metadata?.commands, bootstrapCommands, fetchedCommands]
  )
}
