import { useMemo } from "react"
import { useThreadAncestors } from "@/hooks"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { usePanel } from "@/contexts"
import { ResponsiveBreadcrumbs } from "./responsive-breadcrumbs"
import { streamLabel } from "@/lib/streams"
import type { StreamType } from "@threahq/types"

interface ThreadHeaderStream {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
  parentStreamId: string | null
  rootStreamId: string | null
}

interface ThreadHeaderProps {
  workspaceId: string
  stream: ThreadHeaderStream
}

export function ThreadHeader({ workspaceId, stream }: ThreadHeaderProps) {
  const { ancestors: hookAncestors, isLoading } = useThreadAncestors(
    workspaceId,
    stream.id,
    stream.parentStreamId,
    stream.rootStreamId
  )

  const streams = useWorkspaceStreams(workspaceId)
  const ancestors = useMemo(() => {
    if (hookAncestors.length > 0) return hookAncestors

    if (stream.rootStreamId && streams.length > 0) {
      const rootStream = streams.find((s) => s.id === stream.rootStreamId)
      if (rootStream) {
        return [
          {
            id: rootStream.id,
            displayName: rootStream.displayName,
            slug: rootStream.slug,
            type: rootStream.type,
            parentStreamId: rootStream.parentStreamId,
          },
        ]
      }
    }

    return []
  }, [hookAncestors, stream.rootStreamId, streams])

  const { getNavigateUrl } = usePanel()

  const showLoadingPlaceholder = isLoading && stream.parentStreamId && ancestors.length === 0

  return (
    <div className="min-w-0 flex-1 overflow-hidden pr-2">
      <ResponsiveBreadcrumbs
        ancestors={ancestors}
        currentLabel={streamLabel(stream, "breadcrumb")}
        getNavigationUrl={getNavigateUrl}
        isLoading={!!showLoadingPlaceholder}
      />
    </div>
  )
}
