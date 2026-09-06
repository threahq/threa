import { useMemo } from "react"
import { StreamTypes } from "@threahq/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"

/** The creator's archived asides, for surfaces that must draw no row for them. */
export function useArchivedAsideIds(workspaceId: string): ReadonlySet<string> {
  const streams = useWorkspaceStreams(workspaceId)
  return useMemo(
    () => new Set(streams.filter((stream) => stream.type === StreamTypes.ASIDE && stream.archivedAt).map((s) => s.id)),
    [streams]
  )
}
