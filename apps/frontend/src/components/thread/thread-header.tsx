import { useMemo } from "react"
import { useParams } from "react-router-dom"
import { useThreadAncestors } from "@/hooks"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { usePanelNavigation } from "@/contexts"
import { ResponsiveBreadcrumbs } from "./responsive-breadcrumbs"
import { streamLabel } from "@/lib/streams"
import type { StreamType } from "@threa/types"

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
  /** Whether this header is in a panel (true) or main view (false). Affects navigation behavior. */
  inPanel?: boolean
}

export function ThreadHeader({ workspaceId, stream, inPanel = false }: ThreadHeaderProps) {
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

  const { getPanelUrl, closeOwnPanel } = usePanelNavigation()
  const { streamId: mainViewStreamId } = useParams<{ streamId: string }>()

  const getNavigationUrl = (streamId: string) => {
    return inPanel ? getPanelUrl(streamId) : `/w/${workspaceId}/s/${streamId}`
  }

  const isMainViewStream = (streamId: string) => {
    return inPanel && mainViewStreamId === streamId
  }

  const showLoadingPlaceholder = isLoading && stream.parentStreamId && ancestors.length === 0

  return (
    <div className={`min-w-0 flex-1 overflow-hidden ${inPanel ? "pr-2" : ""}`}>
      <ResponsiveBreadcrumbs
        ancestors={ancestors}
        currentLabel={streamLabel(stream, "breadcrumb")}
        isMainViewStream={isMainViewStream}
        onClosePanel={closeOwnPanel}
        getNavigationUrl={getNavigationUrl}
        isLoading={!!showLoadingPlaceholder}
      />
    </div>
  )
}
