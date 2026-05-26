import { useMemo, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useWorkspaceMetadata } from "@/stores/workspace-store"
import { CommandListProvider } from "@/lib/markdown/command-list-context"
import { streamKeys } from "@/hooks/use-streams"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"

interface WorkspaceCommandListProviderProps {
  workspaceId: string
  children: ReactNode
}

/**
 * Provides the registered slash command names for rendering, so "/foo" in
 * message text is only styled as a command chip when `foo` is a real command.
 */
export function WorkspaceCommandListProvider({ workspaceId, children }: WorkspaceCommandListProviderProps) {
  const metadata = useWorkspaceMetadata(workspaceId)
  const { streamId } = useParams<{ streamId: string }>()
  const queryClient = useQueryClient()
  const streamBootstrapKey = streamId ? streamKeys.bootstrap(workspaceId, streamId) : null
  const { data: streamBootstrap } = useQuery({
    queryKey: streamBootstrapKey ?? ["streams", "bootstrap", workspaceId, ""],
    queryFn: () =>
      streamBootstrapKey ? (queryClient.getQueryData<CachedStreamBootstrap>(streamBootstrapKey) ?? null) : null,
    enabled: false,
    staleTime: Infinity,
  })

  const commandNames = useMemo(() => {
    const effective = streamBootstrap?.commands ?? metadata?.commands ?? []
    return effective.map((command) => command.name)
  }, [metadata?.commands, streamBootstrap?.commands])

  return <CommandListProvider commandNames={commandNames}>{children}</CommandListProvider>
}
