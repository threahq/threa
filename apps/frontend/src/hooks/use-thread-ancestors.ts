import { useMemo } from "react"
import type { StreamType } from "@threahq/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"

interface ThreadAncestor {
  id: string
  displayName: string | null
  slug: string | null
  type: StreamType
  parentStreamId: string | null
}

/**
 * Builds the full ancestor chain from current thread to root.
 * Uses cached workspace streams to walk parentStreamId chain.
 * Returns array ordered from root to immediate parent (excluding current).
 */
export function useThreadAncestors(
  workspaceId: string,
  currentStreamId: string,
  parentStreamId: string | null,
  _rootStreamId: string | null
): {
  ancestors: ThreadAncestor[]
  isLoading: boolean
} {
  const streams = useWorkspaceStreams(workspaceId)

  const ancestors = useMemo(() => {
    if (streams.length === 0 || !parentStreamId) {
      return []
    }

    // Build a lookup map for O(1) access
    const streamMap = new Map(streams.map((s) => [s.id, s]))

    const chain: ThreadAncestor[] = []
    const visited = new Set<string>()
    let currentId: string | null = parentStreamId

    while (currentId && currentId !== currentStreamId) {
      if (visited.has(currentId)) break
      visited.add(currentId)

      const stream = streamMap.get(currentId)
      if (!stream) break

      chain.unshift({
        id: stream.id,
        displayName: stream.displayName,
        slug: stream.slug,
        type: stream.type,
        parentStreamId: stream.parentStreamId,
      })

      currentId = stream.parentStreamId
    }

    return chain
  }, [streams, parentStreamId, currentStreamId])

  return { ancestors, isLoading: false }
}
